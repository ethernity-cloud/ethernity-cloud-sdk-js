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
 *
 * The key that pays for the order (a funded 0x key) is PRIVATE_KEY, else
 * ECLD_PRIVATE_KEY, of the environment or .env; else the ENC_PRIVATE_KEY
 * ecld-publish writes to .env, decrypted with ECLD_KEY_PASSWORD of the
 * environment or a password asked on the terminal (privateKey.js).
 *
 * Usage, from the project root:
 *
 *   npx ecld-run 'hello("World")'
 *   npx ecld-run --file payload.js
 *   npx ecld-run --input data.json 'processData(___etny_data_set___)'
 *   npx ecld-run --network BLOXBERG_TESTNET --task-price 2.5 'esrIncrement()'
 *   npx ecld-run --mode session --expected-inputs 5 'hello("World")'
 *   npx ecld-run --bid-wei 1200000000000000000 --bid-ceiling-wei 2000000000000000000 --epc-mib 256 'hello("World")'
 *   npx ecld-run --unsafe 'hello("World")'    # the network's -unsafe variant
 *   npx ecld-run --json 'hello("World")'      # machine-readable result
 *
 * The order's execution object (execution.js) is read from the EXEC_* keys
 * of .env, as ecld-init writes them, and each flag overrides its key; it is
 * validated before the runner is constructed and passed nested in the
 * resources beside the flat duration a 1.1 runner reads.
 *
 * The claims flags go to the runner's run() options (runOptionsFor): with
 * --bid-wei the request's V2 terms (options.v2), the execution's maxGflops as
 * the GFLOPS ceiling and the relays per hour among them; --min-node-score and
 * --allow-marked-image beside them. On a network that serves requests by
 * claims the runner refuses a request without a bid before anything is sent,
 * and ecld-run reports that refusal and exits 1 (runReport.js).
 *
 * The runner is ESM; this CJS entry loads it with dynamic import().
 *
 * Exit code 0 on a SUCCESS task result, 1 otherwise, 2 on a usage error and on
 * a stored key it cannot decrypt.
 */

'use strict';

const fs = require('fs');
const casConfig = require('./cas/config.js');
const { networkFor, unsafeVariant } = require('./network.js');
const { PUBLIC_IPFS_HOST } = require('./localKubo.js');
const { reportRun } = require('./runReport.js');
const execution = require('./execution.js');
const { resolvePrivateKey, promptHidden, readEnvFile, KeyError } = require('./privateKey.js');

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

// The bounds of the claims flags, the runners' (ethernity-cloud-runner-js
// options.v2, ethernity-cloud-runner-py resources): a bid and a bid ceiling
// per CU-hour 1 to 2^128 - 1 wei and a gas level 1e18 to 2^128 - 1 (the PoX
// 2.0's MAX_PRICE and MAX_GAS_LEVEL; the pricing refuses a gas level below
// 1e18), a required GFLOPS figure 0 to 65,535, an EPC figure 1 to 4,194,240
// MiB (65,535 units of 64 MiB, which the runner rounds the figure up to) and
// a minimum node score 0 to 5.00 points.
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const GAS_LEVEL_MIN = 10n ** 18n;
const REQUIRED_GFLOPS_MAX = 65535n;
const EPC_MIB_MAX = 65535n * 64n;
const SCORE_MAX = 5;

// A whole-number flag from `min` to `max`, as a bigint.
function wholeFlag(name, raw, min, max) {
  const s = String(raw === undefined ? '' : raw).trim();
  if (!/^\d+$/.test(s)) throw new UsageError(`${name} takes a whole number, got ${JSON.stringify(raw)}`);
  const n = BigInt(s);
  if (n < min || n > max) throw new UsageError(`${name} takes a whole number from ${min} to ${max}, got ${s}`);
  return n;
}

// --min-node-score: points, a plain decimal from 0 to 5.00.
function scoreFlag(name, raw) {
  const s = String(raw === undefined ? '' : raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) > SCORE_MAX) {
    throw new UsageError(`${name} takes a score from 0 to 5.00, got ${JSON.stringify(raw)}`);
  }
  return Number(s);
}

// Each claims flag names the runner's options.v2 key it sets and its bounds;
// the bigint the flag gives is passed as a Number where the key is a count.
const CLAIMS_FLAGS = {
  '--bid-wei': ['maxPricePerCuHourWei', 1n, UINT128_MAX, false],
  '--bid-ceiling-wei': ['maxBidPerCuHourWei', 1n, UINT128_MAX, false],
  '--escrow-wei': ['escrowWei', 1n, UINT256_MAX, false],
  '--required-gflops': ['requiredGflops', 0n, REQUIRED_GFLOPS_MAX, true],
  '--gas-level': ['gasLevel', GAS_LEVEL_MIN, UINT128_MAX, false],
  '--epc-mib': ['epcMiB', 1n, EPC_MIB_MAX, true],
};
const BID_FLAG = '--bid-wei';

// Each integer execution flag names the execution.js key it sets.
const EXECUTION_FLAGS = {
  '--duration-hours': 'durationHours',
  '--duration': 'durationHours',
  '--parallelism': 'parallelism',
  '--max-gflops': 'maxGflops',
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

// An argument that starts with '-', holds no whitespace and is not a number
// is an option: parseArgs refuses one it does not know with a usage error.
function isOption(a) {
  return /^-\S*$/.test(a) && !Number.isFinite(Number(a));
}

function setKey(obj, dotted, value) {
  const [head, tail] = dotted.split('.');
  if (tail === undefined) obj[head] = value;
  else (obj[head] = obj[head] || {})[tail] = value;
}

function parseArgs(argv) {
  const opts = { ipfs: DEFAULT_IPFS, timeout: 600, taskPrice: 3, cpu: 1, memory: 1, storage: 10, bandwidth: 1, validators: 1, node: '', execution: {}, claims: {} };
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
    else if (a in CLAIMS_FLAGS) {
      const [key, min, max, count] = CLAIMS_FLAGS[a];
      const value = wholeFlag(a, argv[++i], min, max);
      opts.claims[key] = count ? Number(value) : value;
    } else if (a === '--min-node-score') opts.minNodeScore = scoreFlag(a, argv[++i]);
    else if (a === '--allow-marked-image') opts.allowMarkedImage = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (isOption(a)) throw new UsageError(`unknown option ${a}`);
    else positional.push(a);
  }
  // A request is added with V2 terms only with a bid.
  const [bidKey] = CLAIMS_FLAGS[BID_FLAG];
  const unbid = Object.keys(CLAIMS_FLAGS).find((flag) => opts.claims[CLAIMS_FLAGS[flag][0]] !== undefined);
  if (unbid && opts.claims[bidKey] === undefined) {
    throw new UsageError(`${unbid} states a V2 term of the request, which is added with V2 terms only with ${BID_FLAG}`);
  }
  return { opts, positional };
}

/* The options of runner.run(): the input dataset; with --bid-wei, the V2
 * terms (options.v2): the bid, the execution's maxGflops as the GFLOPS
 * ceiling, the relays per hour and each claims flag given; --min-node-score
 * and --allow-marked-image when given. Without a claims flag the options are
 * the input dataset alone. */
function runOptionsFor(opts, exec, relaysPerHour, inputData) {
  const options = { inputData };
  if (opts.claims[CLAIMS_FLAGS[BID_FLAG][0]] !== undefined) {
    options.v2 = { maxGflops: exec.maxGflops, relaysPerHour, ...opts.claims };
  }
  if (opts.minNodeScore !== undefined) options.minNodeScore = opts.minNodeScore;
  if (opts.allowMarkedImage) options.allowMarkedImage = true;
  return options;
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
key:       PRIVATE_KEY or ECLD_PRIVATE_KEY (a funded 0x key) from env / .env, else ENC_PRIVATE_KEY of .env
           (ecld-publish writes it) decrypted with ECLD_KEY_PASSWORD or the password asked on the terminal
resources: --task-price 3 (ECLD, fractional allowed: 2.5) --cpu 1 --memory 1 --storage 10 --bandwidth 1 --validators 1
execution: each flag overrides its EXEC_* key in .env (ecld-init writes them; the defaults otherwise)
           --mode task|session  --duration-hours 1 (alias --duration)  --parallelism 1  --max-gflops 0  --headroom 25
           --expected-inputs 1  --keep-open / --no-keep-open  --renew / --no-renew  --max-renewals 0
           --expected-commits 0  --relays-per-hour <n> (default 1 + expected inputs, plus 10 with ESR_ENABLED)
claims:    --bid-wei <wei>: the bid per CU-hour; the request is added with V2 terms, with --max-gflops as
           its GFLOPS ceiling and --relays-per-hour; a network that serves requests by claims takes none without it
           --bid-ceiling-wei <wei> (the most a raise bids)  --escrow-wei <wei> (the most the add pulls)
           --required-gflops <n>  --gas-level <n> (default 1e18)  --epc-mib <MiB> (the EPC the task needs)
           --min-node-score <0-5.00>  --allow-marked-image
other:     --node <addr>  --ipfs intake|<ipfs api url> (default intake: the bootnode's payload intake;
           a URL takes ECLD_IPFS_TOKEN or IPFS_TOKEN as its Authorization header)
           --timeout <sec>  --json`;

async function main() {
  // The environment ecld-run was started with, before dotenv adds the
  // variables of .env to process.env.
  const startEnv = { ...process.env };
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
    // The range named is the one this SDK depends on.
    const runnerRange = require('./package.json').dependencies['@ethernity-cloud/runner'];
    console.error('ecld-run: the runner package is not installed or is too old '
      + `(need @ethernity-cloud/runner ${runnerRange}): ` + e.message);
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

  let privateKey;
  try {
    privateKey = await resolvePrivateKey('run', {
      env: startEnv, file: readEnvFile('.env'), isTTY: Boolean(process.stdin.isTTY),
      promptHidden, log: (line) => console.error(line),
    });
  } catch (e) {
    if (!(e instanceof KeyError)) throw e;
    if (e.message) console.error(`ecld-run: ${e.message}`);
    process.exit(e.exitCode);
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
  const runOptions = runOptionsFor(opts, exec, relaysPerHour, input);
  console.log(`resources  : ${JSON.stringify(flat)}`);
  console.log(`execution  : ${JSON.stringify(exec)}`);
  console.log(`relays/hour: ${relaysPerHour}`);
  const { inputData, ...claims } = runOptions;
  if (Object.keys(claims).length) {
    console.log(`claims     : ${JSON.stringify(claims, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  }
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
    const runPromise = runner.run(resources, securelock, code, opts.node, trustedzone || null, runOptions)
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

module.exports = { parseArgs, executionFor, relaysPerHourFor, runOptionsFor, UsageError, HELP };
