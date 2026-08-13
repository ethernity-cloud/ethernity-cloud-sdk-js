#!/usr/bin/env node
/* ecld-run — submit a payload to the Ethernity Cloud network and print the result.
 *
 * The network-side sibling of `ecld-test`: same payload flags (a code string,
 * --file, --input/--input-text), but instead of executing locally it drives the
 * real runner (@ethernity-cloud/runner's EthernityCloudRunner) end to end —
 * encrypt the payload, push to IPFS, place the on-chain DO request, wait for a
 * node to process it, download and decrypt the result.
 *
 * Where ecld-test answers "does my CALL work?", ecld-run answers "does it work
 * on the network, on the enclave I published?" — it costs gas and needs a
 * funded key.
 *
 * Network and enclave come from the project's .env (written by ecld-init /
 * ecld-publish), matching how ethernity_task drives a run:
 *
 *   BLOCKCHAIN_NETWORK   e.g. "Bloxberg_Testnet" -> the network token address
 *   PROJECT_NAME         the securelock enclave to run
 *   TRUSTED_ZONE_IMAGE   the trustedzone enclave
 *   PRIVATE_KEY          a funded 0x key — it pays for the order
 *
 * Usage, from the project root:
 *
 *   npx ecld-run 'hello("World")'
 *   npx ecld-run --file payload.js
 *   npx ecld-run --input data.json 'processData(___etny_data_set___)'
 *   npx ecld-run --network BLOXBERG_TESTNET --task-price 3 'esrIncrement()'
 *   npx ecld-run --json 'hello("World")'      # machine-readable result
 *
 * The runner is ESM; this CJS entry loads it with dynamic import().
 *
 * Exit code 0 on a SUCCESS task result, 1 otherwise.
 */

'use strict';

const fs = require('fs');
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

const DEFAULT_IPFS = 'https://ipfs.ethernity.cloud/api/v0';

/* Map a BLOCKCHAIN_NETWORK token (as ecld-init writes it, spaces -> underscores)
 * to the runner's network token ADDRESS. Built from the runner's own ECAddress
 * so it can't drift. Accepts a few spellings per network. */
function networkAddress(ECAddress, raw) {
  const key = String(raw || '').trim().toUpperCase().replace(/\s+/g, '_');
  const table = {
    BLOXBERG_TESTNET: ECAddress.BLOXBERG.TESTNET_ADDRESS,
    BLOXBERG_MAINNET: ECAddress.BLOXBERG.MAINNET_ADDRESS,
    POLYGON_MAINNET: ECAddress.POLYGON.MAINNET_ADDRESS,
    POLYGON_AMOY: ECAddress.POLYGON.TESTNET_ADDRESS,
    POLYGON_AMOY_TESTNET: ECAddress.POLYGON.TESTNET_ADDRESS,
    IOTEX_TESTNET: ECAddress.IOTEX && ECAddress.IOTEX.TESTNET_ADDRESS,
    ETHEREUM_SEPOLIA: ECAddress.SEPOLIA && ECAddress.SEPOLIA.TESTNET_ADDRESS,
    SEPOLIA: ECAddress.SEPOLIA && ECAddress.SEPOLIA.TESTNET_ADDRESS,
    LITVM_LITEFORGE: ECAddress.LITVM && ECAddress.LITVM.TESTNET_ADDRESS,
    LITVM: ECAddress.LITVM && ECAddress.LITVM.TESTNET_ADDRESS,
  };
  return { key, address: table[key] || null, known: Object.keys(table) };
}

function parseArgs(argv) {
  const opts = { ipfs: DEFAULT_IPFS, timeout: 600, taskPrice: 3, cpu: 1, memory: 1, storage: 10, bandwidth: 1, duration: 1, validators: 1, node: '' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') opts.file = argv[++i];
    else if (a === '--input' || a === '-i') opts.inputFile = argv[++i];
    else if (a === '--input-text') opts.inputText = argv[++i];
    else if (a === '--network') opts.network = argv[++i];
    else if (a === '--securelock') opts.securelock = argv[++i];
    else if (a === '--trustedzone') opts.trustedzone = argv[++i];
    else if (a === '--node') opts.node = argv[++i];
    else if (a === '--ipfs') opts.ipfs = argv[++i];
    else if (a === '--timeout') opts.timeout = parseInt(argv[++i], 10);
    else if (a === '--task-price') opts.taskPrice = parseInt(argv[++i], 10);
    else if (a === '--cpu') opts.cpu = parseInt(argv[++i], 10);
    else if (a === '--memory') opts.memory = parseInt(argv[++i], 10);
    else if (a === '--storage') opts.storage = parseInt(argv[++i], 10);
    else if (a === '--bandwidth') opts.bandwidth = parseInt(argv[++i], 10);
    else if (a === '--duration') opts.duration = parseInt(argv[++i], 10);
    else if (a === '--validators') opts.validators = parseInt(argv[++i], 10);
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else positional.push(a);
  }
  return { opts, positional };
}

const HELP = `ecld-run — submit a payload to the Ethernity Cloud network (costs gas; needs a funded key).
Local sibling: ecld-test.

usage: ecld-run 'hello("World")' | ecld-run --file payload.js | ecld-run --input data.json 'fn(___etny_data_set___)'

payload:   a code string, or --file <path>; input via --input <file> / --input-text <str>
network:   --network BLOXBERG_TESTNET (default: BLOCKCHAIN_NETWORK from .env)
enclaves:  --securelock <name> (default PROJECT_NAME), --trustedzone <name> (default TRUSTED_ZONE_IMAGE)
key:       PRIVATE_KEY (a funded 0x key) from .env / env, or ECLD_PRIVATE_KEY
resources: --task-price 3 --cpu 1 --memory 1 --storage 10 --bandwidth 1 --duration 1 --validators 1
other:     --node <addr>  --ipfs <url>  --timeout <sec>  --json`;

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  // ---- payload ----
  let code;
  if (opts.file) code = fs.readFileSync(opts.file, 'utf8');
  else if (positional.length) code = positional.join(' ');
  else if ((process.env.ECLD_TEST_CODE || '').trim()) code = process.env.ECLD_TEST_CODE.trim();
  else { console.error("ecld-run: provide a payload string, --file, or ECLD_TEST_CODE\n\n" + HELP); process.exit(2); }

  if (opts.inputFile !== undefined && opts.inputText !== undefined) {
    console.error('ecld-run: --input and --input-text are mutually exclusive'); process.exit(2);
  }
  let input = null;
  if (opts.inputFile !== undefined) input = fs.readFileSync(opts.inputFile, 'utf8');
  else if (opts.inputText !== undefined) input = opts.inputText;
  // The enclave executor exposes the input as ___etny_data_set___; the runner
  // passes it as part of the code's scope, so a payload references it by name.
  // ecld-run mirrors ecld-test: input is delivered via the payload call itself.

  // ---- runner (ESM) ----
  let EthernityCloudRunner, ECStatus, ECEvent, ECAddress, ECOrderTaskStatus;
  try {
    const runnerMod = await import('@ethernity-cloud/runner');
    EthernityCloudRunner = runnerMod.default || runnerMod.EthernityCloudRunner;
    const enums = await import('@ethernity-cloud/runner/enums.js');
    ({ ECStatus, ECEvent, ECAddress, ECOrderTaskStatus } = enums);
  } catch (e) {
    console.error('ecld-run: the runner package is not installed or is too old '
      + '(need @ethernity-cloud/runner >= 0.4.4): ' + e.message);
    process.exit(1);
  }

  // ---- network / enclaves / key ----
  const rawNetwork = opts.network || process.env.BLOCKCHAIN_NETWORK || 'BLOXBERG_TESTNET';
  const { key: netKey, address, known } = networkAddress(ECAddress, rawNetwork);
  if (!address) {
    console.error(`ecld-run: unknown network '${rawNetwork}'. Known: ${known.join(', ')}`);
    process.exit(1);
  }
  const securelock = opts.securelock || process.env.PROJECT_NAME;
  const trustedzone = opts.trustedzone || process.env.TRUSTED_ZONE_IMAGE;  // may be undefined -> run() default
  if (!securelock) {
    console.error('ecld-run: no securelock enclave: set PROJECT_NAME in .env '
      + '(run ecld-init/ecld-publish) or pass --securelock.');
    process.exit(1);
  }

  let privateKey = (process.env.PRIVATE_KEY || process.env.ECLD_PRIVATE_KEY || '').trim();
  if (!privateKey) {
    console.error('ecld-run: no signing key. Set PRIVATE_KEY (a funded 0x key) in .env '
      + '(ecld-publish stores it) or ECLD_PRIVATE_KEY.');
    process.exit(1);
  }
  if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;

  console.log(`network    : ${netKey} (${address})`);
  console.log(`securelock : ${securelock}`);
  console.log(`trustedzone: ${trustedzone || '(runner default)'}`);
  console.log(`payload    : ${JSON.stringify(code)}`);
  console.log(`input      : ${input === null ? '<empty>' : JSON.stringify(input.slice(0, 80))}`);

  // ---- drive the runner ----
  let runner;
  try {
    runner = new EthernityCloudRunner(address, { privateKey });
  } catch (e) {
    console.error('ecld-run: could not initialise the runner: ' + e.message);
    process.exit(1);
  }
  runner.initializeStorage(opts.ipfs);

  let lastPhase = null;
  const onProgress = (e) => {
    const d = (e && e.detail) || {};
    if (d.progress !== lastPhase) { lastPhase = d.progress; console.log(`[${d.progress}] ${d.message}`); }
    else if (d.message) console.log(`          ${d.message}`);
  };
  runner.addEventListener(ECStatus.DEFAULT, onProgress);

  const resources = {
    taskPrice: opts.taskPrice, cpu: opts.cpu, memory: opts.memory,
    storage: opts.storage, bandwidth: opts.bandwidth, duration: opts.duration, validators: opts.validators,
  };
  console.log(`resources  : ${JSON.stringify(resources)}`);
  console.log('submitting order... (this places an on-chain request and costs gas)');

  const done = new Promise((resolve) => {
    runner.addEventListener(ECStatus.SUCCESS, () => resolve('SUCCESS'));
    runner.addEventListener(ECStatus.ERROR, (e) => {
      const msg = (e && e.detail && e.detail.message) || 'unknown error';
      resolve({ error: msg });
    });
  });

  // run() resolves when the task terminates; the events resolve `done`. Race a
  // timeout so a stuck order doesn't hang the CLI forever.
  const timeoutMs = (opts.timeout || 600) * 1000;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs); });

  try {
    const runArgs = [resources, securelock, code, opts.node];
    if (trustedzone) runArgs.push(trustedzone);
    // Fire the run; its own promise also settles on completion.
    const runPromise = runner.run(...runArgs).catch((e) => ({ error: e.message }));
    const outcome = await Promise.race([done, timeout, runPromise]);
    clearTimeout(timer);

    if (outcome === 'TIMEOUT') {
      console.error(`\necld-run: no result after ${opts.timeout}s; the order may still process on-chain.`);
      process.exit(1);
    }
    if (outcome && outcome.error) {
      console.error(`\nstatus     : ERROR`);
      console.error(`error      : ${outcome.error}`);
      process.exit(1);
    }

    // SUCCESS
    const result = await runner.getResult();
    const typed = (runner.getStructuredResult && runner.getStructuredResult()) || null;
    const taskCode = runner.resultTaskCode;
    const taskName = runner.resultTaskCodeName
      || (ECOrderTaskStatus && taskCode !== undefined ? ECOrderTaskStatus[taskCode] : undefined);

    if (opts.json) {
      console.log(JSON.stringify({ task_code: taskCode, task_code_name: taskName, value: result, structured: typed }, null, 2));
    } else {
      if (taskName && taskName !== 'SUCCESS') console.log(`task code  : ${taskCode} (${taskName})`);
      console.log('result     :');
      console.log(result);
    }
    // A non-zero enclave task code is a failed run even though the order landed.
    process.exit(taskCode === undefined || taskCode === 0 ? 0 : 1);
  } catch (e) {
    clearTimeout(timer);
    console.error('ecld-run: run failed: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
