#!/usr/bin/env node
/* ecld-run — submit a payload to the Ethernity Cloud network and print the result.
 *
 * The network-side sibling of `ecld-test`: same payload flags (a code string,
 * --file, --input/--input-text), but instead of executing locally it drives the
 * real runner (@ethernity-cloud/runner's EthernityCloudRunner) end to end —
 * encrypt the payload, place the on-chain DO request, deliver the payload to
 * the bootnode's payload intake once the request is on chain (or to the IPFS
 * API named with --ipfs <url>), wait for a node to process it, download and
 * decrypt the result.
 *
 * Where ecld-test answers "does my CALL work?", ecld-run answers "does it work
 * on the network, on the enclave I published?" — it costs gas and needs a
 * funded key.
 *
 * Network and enclave come from the project's .env (written by ecld-init /
 * ecld-publish), matching how ethernity_task drives a run:
 *
 *   BLOCKCHAIN_NETWORK   e.g. "Bloxberg_Testnet" -> the network token address
 *   PROJECT_NAME         the securelock enclave to run (<PROJECT_NAME>-unsafe
 *                        on an -unsafe network)
 *   TRUSTED_ZONE_IMAGE   the trustedzone enclave (its -unsafe variant on an
 *                        -unsafe network)
 *   PRIVATE_KEY          a funded 0x key — it pays for the order
 *
 * Usage, from the project root:
 *
 *   npx ecld-run 'hello("World")'
 *   npx ecld-run --file payload.js
 *   npx ecld-run --input data.json 'processData(___etny_data_set___)'
 *   npx ecld-run --network BLOXBERG_TESTNET --task-price 2.5 'esrIncrement()'
 *   npx ecld-run --mode session --expected-inputs 5 'hello("World")'
 *   npx ecld-run --unsafe 'hello("World")'    # the network's -unsafe variant
 *   npx ecld-run --json 'hello("World")'      # machine-readable result
 *
 * The order's execution object (execution.js) is read from the EXEC_* keys
 * of .env, as ecld-init writes them, and each flag overrides its key; it is
 * validated before the runner is constructed and passed nested in the
 * resources beside the flat duration a 1.1 runner reads.
 *
 * The runner is ESM; this CJS entry loads it with dynamic import().
 *
 * Exit code 0 on a SUCCESS task result, 1 otherwise, 2 on a usage error.
 */

'use strict';

const fs = require('fs');
const casConfig = require('./cas/config.js');
const { networkFor, unsafeVariant } = require('./network.js');
const { PUBLIC_IPFS_HOST } = require('./localKubo.js');
const { reportRun } = require('./runReport.js');
const execution = require('./execution.js');

// `--ipfs intake` (the default): the artefacts' CIDs are computed locally and
// the bytes delivered to the bootnode's payload intake once the DO request is
// on chain (runner initializePublicIntake); `--ipfs <url>` uploads and reads
// through that IPFS RPC API instead, with ECLD_IPFS_TOKEN or IPFS_TOKEN as its
// Authorization header. The public API takes writes only with a writer token,
// so a URL naming it is refused without one.
const DEFAULT_IPFS = 'intake';

// A flag value the CLI refuses: main prints the message with HELP and exits 2.
class UsageError extends Error {}

// A count flag: a non-negative integer.
function integerFlag(name, raw) {
  const s = String(raw === undefined ? '' : raw).trim();
  if (!/^\d+$/.test(s)) throw new UsageError(`${name} takes a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(s);
}

// A flag that takes a word: the next argument, which is neither missing,
// blank nor another flag.
function wordFlag(name, raw) {
  const s = String(raw === undefined ? '' : raw).trim();
  if (s === '' || s.startsWith('-')) throw new UsageError(`${name} takes a value, got ${JSON.stringify(raw)}`);
  return s;
}

// --task-price: an ECLD amount, fractional or not, kept as given for the runner.
function priceFlag(name, raw) {
  const s = String(raw === undefined ? '' : raw).trim();
  const n = Number(s);
  if (s === '' || !Number.isFinite(n) || n < 0) throw new UsageError(`${name} takes a non-negative number, got ${JSON.stringify(raw)}`);
  return n;
}

// Each integer execution flag names the execution.js key it sets.
const EXECUTION_FLAGS = {
  '--duration-hours': 'durationHours',
  '--duration': 'durationHours',
  '--parallelism': 'parallelism',
  '--max-cu': 'maxCu',
  '--headroom': 'headroomPercent',
  '--expected-inputs': 'session.expectedInputs',
  '--max-renewals': 'session.maxRenewals',
  '--expected-commits': 'esr.expectedCommits',
};
const EXECUTION_SWITCHES = {
  '--keep-open': ['session.keepOpen', true],
  '--no-keep-open': ['session.keepOpen', false],
  '--renew': ['session.renew', true],
  '--no-renew': ['session.renew', false],
};

function setKey(obj, dotted, value) {
  const [head, tail] = dotted.split('.');
  if (tail === undefined) obj[head] = value;
  else (obj[head] = obj[head] || {})[tail] = value;
}

function parseArgs(argv) {
  const opts = { ipfs: DEFAULT_IPFS, timeout: 600, taskPrice: 3, cpu: 1, memory: 1, storage: 10, bandwidth: 1, validators: 1, node: '', execution: {} };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') opts.file = argv[++i];
    else if (a === '--input' || a === '-i') opts.inputFile = argv[++i];
    else if (a === '--input-text') opts.inputText = argv[++i];
    else if (a === '--network') opts.network = argv[++i];
    else if (a === '--unsafe') opts.unsafe = true;
    else if (a === '--securelock') opts.securelock = argv[++i];
    else if (a === '--trustedzone') opts.trustedzone = argv[++i];
    else if (a === '--node') opts.node = argv[++i];
    else if (a === '--ipfs') opts.ipfs = argv[++i];
    else if (a === '--timeout') opts.timeout = integerFlag(a, argv[++i]);
    else if (a === '--task-price') opts.taskPrice = priceFlag(a, argv[++i]);
    else if (a === '--cpu') opts.cpu = integerFlag(a, argv[++i]);
    else if (a === '--memory') opts.memory = integerFlag(a, argv[++i]);
    else if (a === '--storage') opts.storage = integerFlag(a, argv[++i]);
    else if (a === '--bandwidth') opts.bandwidth = integerFlag(a, argv[++i]);
    else if (a === '--validators') opts.validators = integerFlag(a, argv[++i]);
    else if (a === '--relays-per-hour') opts.relaysPerHour = integerFlag(a, argv[++i]);
    else if (a === '--mode') setKey(opts.execution, 'mode', wordFlag(a, argv[++i]));
    else if (a in EXECUTION_FLAGS) setKey(opts.execution, EXECUTION_FLAGS[a], integerFlag(a, argv[++i]));
    else if (a in EXECUTION_SWITCHES) setKey(opts.execution, ...EXECUTION_SWITCHES[a]);
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else positional.push(a);
  }
  return { opts, positional };
}

/* The order's execution object: the EXEC_* keys of env (the project's .env)
 * under the flags, validated; throws the execution.js message. */
function executionFor(opts, env) {
  const fromEnv = execution.fromEnv(env);
  const flags = opts.execution;
  return execution.validate({
    ...fromEnv, ...flags,
    session: { ...fromEnv.session, ...flags.session },
    esr: { ...fromEnv.esr, ...flags.esr },
  });
}

/* --relays-per-hour, else execution.js's default for the order and ESR_ENABLED. */
function relaysPerHourFor(opts, env, exec) {
  return opts.relaysPerHour === undefined ? execution.relaysPerHour(exec, execution.esrEnabled(env)) : opts.relaysPerHour;
}

const HELP = `ecld-run — submit a payload to the Ethernity Cloud network (costs gas; needs a funded key).
Local sibling: ecld-test.

usage: ecld-run 'hello("World")' | ecld-run --file payload.js | ecld-run --input data.json 'fn(___etny_data_set___)'

payload:   a code string, or --file <path>; input via --input <file> / --input-text <str>
network:   --network BLOXBERG_TESTNET (default: BLOCKCHAIN_NETWORK from .env)
           --unsafe: the network's -unsafe variant, which runs without a CAS
           (BLOXBERG_TESTNET_UNSAFE, LITVM_LITEFORGE_UNSAFE, ETHEREUM_SEPOLIA_UNSAFE)
enclaves:  --securelock <name> (default PROJECT_NAME), --trustedzone <name> (default TRUSTED_ZONE_IMAGE);
           on an -unsafe network the default is each one's -unsafe variant
key:       PRIVATE_KEY (a funded 0x key) from .env / env, or ECLD_PRIVATE_KEY
resources: --task-price 3 (ECLD, fractional allowed: 2.5) --cpu 1 --memory 1 --storage 10 --bandwidth 1 --validators 1
execution: each flag overrides its EXEC_* key in .env (ecld-init writes them; the defaults otherwise)
           --mode task|session  --duration-hours 1 (alias --duration)  --parallelism 1  --max-cu 0  --headroom 25
           --expected-inputs 1  --keep-open / --no-keep-open  --renew / --no-renew  --max-renewals 0
           --expected-commits 0  --relays-per-hour <n> (default 1 + expected inputs, plus 10 with ESR_ENABLED)
other:     --node <addr>  --ipfs intake|<ipfs api url> (default intake: the bootnode's payload intake;
           a URL takes ECLD_IPFS_TOKEN or IPFS_TOKEN as its Authorization header)
           --timeout <sec>  --json`;

async function main() {
  try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }
  let opts, positional;
  try {
    ({ opts, positional } = parseArgs(process.argv.slice(2)));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`ecld-run: ${e.message}\n\n${HELP}`); process.exit(2);
  }
  if (opts.help) { console.log(HELP); process.exit(0); }

  let exec;
  try {
    exec = executionFor(opts, process.env);
  } catch (e) {
    console.error(`ecld-run: ${e.message}\n\n${HELP}`); process.exit(2);
  }
  const relaysPerHour = relaysPerHourFor(opts, process.env, exec);

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
  // The input is the task's input dataset (runner option inputData): sent
  // sealed for the trustedzone and read in the payload as ___etny_data_set___.

  // ---- runner (ESM) ----
  let EthernityCloudRunner, ECStatus, ECEvent, enums;
  try {
    const runnerMod = await import('@ethernity-cloud/runner');
    EthernityCloudRunner = runnerMod.default || runnerMod.EthernityCloudRunner;
    enums = await import('@ethernity-cloud/runner/enums.js');
    ({ ECStatus, ECEvent } = enums);
  } catch (e) {
    console.error('ecld-run: the runner package is not installed or is too old '
      + '(need @ethernity-cloud/runner >= 0.6.11): ' + e.message);
    process.exit(1);
  }

  // ---- network / enclaves / key ----
  let rawNetwork = opts.network || process.env.BLOCKCHAIN_NETWORK || 'BLOXBERG_TESTNET';
  if (opts.unsafe) {
    const variant = unsafeVariant(rawNetwork);
    if (!variant) {
      console.error(`ecld-run: ${rawNetwork} has no -unsafe variant. -unsafe networks: `
        + Object.keys(casConfig.UNSAFE_NETWORKS).join(', '));
      process.exit(1);
    }
    rawNetwork = variant;
  }
  const { key: netKey, network, known } = networkFor(enums, rawNetwork);
  if (!network) {
    console.error(`ecld-run: unknown network '${rawNetwork}'. Known: ${known.join(', ')}`);
    process.exit(1);
  }
  const securelock = opts.securelock || casConfig.nameOnNetwork(process.env.PROJECT_NAME, rawNetwork);
  // May be undefined -> run() default.
  const trustedzone = opts.trustedzone || casConfig.nameOnNetwork(process.env.TRUSTED_ZONE_IMAGE, rawNetwork);
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

  console.log(`network    : ${netKey} (${network.address})`);
  if (network.unsafe) {
    console.log('             UNSAFE: no CAS; the enclaves are debug-signed and sign their own certificates');
  }
  console.log(`securelock : ${securelock}`);
  console.log(`trustedzone: ${trustedzone || '(runner default)'}`);
  console.log(`payload    : ${JSON.stringify(code)}`);
  console.log(`input      : ${input === null ? '<empty>' : JSON.stringify(input.slice(0, 80))}`);

  // ---- drive the runner ----
  let runner;
  try {
    runner = new EthernityCloudRunner(network.address, network.rpcUrl ? { privateKey, rpcUrl: network.rpcUrl } : { privateKey }, network.chainId);
    if (network.unsafe) await runner.setNetwork(...network.unsafe);
  } catch (e) {
    console.error('ecld-run: could not initialise the runner: ' + e.message);
    process.exit(1);
  }
  if (opts.ipfs === 'intake') {
    runner.initializePublicIntake();
  } else {
    const token = (process.env.ECLD_IPFS_TOKEN || process.env.IPFS_TOKEN || '').trim();
    let host = '';
    try { host = new URL(opts.ipfs).hostname; } catch (e) { /* not a URL: the runner reports it */ }
    if (host === PUBLIC_IPFS_HOST && !token) {
      console.error(`ecld-run: the public API ${PUBLIC_IPFS_HOST} takes writes only with a writer token `
        + '(ECLD_IPFS_TOKEN or IPFS_TOKEN); use the intake (--ipfs intake) or your own Kubo.');
      process.exit(2);
    }
    runner.initializeStorage(opts.ipfs, undefined, undefined, token || undefined);
  }

  let lastPhase = null;
  const onProgress = (e) => {
    const d = (e && e.detail) || {};
    if (d.progress !== lastPhase) { lastPhase = d.progress; console.log(`[${d.progress}] ${d.message}`); }
    else if (d.message) console.log(`          ${d.message}`);
  };
  runner.addEventListener(ECStatus.DEFAULT, onProgress);

  // The flat duration is what a 1.1 runner reads; the nested execution is the
  // order's execution object for the runner that takes it.
  const flat = {
    taskPrice: opts.taskPrice, cpu: opts.cpu, memory: opts.memory,
    storage: opts.storage, bandwidth: opts.bandwidth, validators: opts.validators,
    duration: exec.durationHours,
  };
  const resources = { ...flat, execution: exec };
  console.log(`resources  : ${JSON.stringify(flat)}`);
  console.log(`execution  : ${JSON.stringify(exec)}`);
  console.log(`relays/hour: ${relaysPerHour}`);
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
    // Fire the run; its own promise also settles on completion.
    const runPromise = runner.run(resources, securelock, code, opts.node, trustedzone || null, { inputData: input })
      .catch((e) => ({ error: e.message }));
    const outcome = await Promise.race([done, timeout, runPromise]);
    clearTimeout(timer);

    if (outcome === 'TIMEOUT') {
      console.error(`\necld-run: no result after ${opts.timeout}s; the order may still process on-chain.`);
      process.exit(1);
    }
    process.exit(await reportRun(runner, outcome, { json: opts.json }));
  } catch (e) {
    clearTimeout(timer);
    console.error('ecld-run: run failed: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
}

module.exports = { parseArgs, executionFor, relaysPerHourFor, UsageError, HELP };
