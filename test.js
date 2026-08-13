#!/usr/bin/env node
/* ecld-test — run a Nodenithy payload locally, without SGX, exactly as the
 * enclave would.
 *
 * Stages the project's src/serverless next to the vendored securelock
 * executor (the same layout ecld-build produces inside the enclave image) and
 * executes the payload with that executor: same backend reflection, same
 * ___etny_result___ / ___etny_data_set___ scope, same TaskStatus codes.
 * Validates the CALL — names, arguments, result wiring — before anything is
 * paid for on-chain. It does not validate attestation, checksums or
 * encryption; those need a real (testnet) run.
 *
 * Usage, from the project root:
 *
 *   npx ecld-test 'hello("World")'              one-shot, in-process
 *   npx ecld-test --file payload.js
 *   npx ecld-test --input data.json 'processData(___etny_data_set___)'
 *   npx ecld-test --input-text '{"x":1}' 'processData(___etny_data_set___)'
 *
 *   npx ecld-test serve [--port 8745]           local API for runner LOCAL mode
 *
 * `serve` starts the local test API so a dApp can exercise its real runner
 * integration end to end: new EthernityCloudRunner('LOCAL') in
 * @ethernity-cloud/runner >= 0.3.6 executes every run() against this API
 * instead of the blockchain.
 *
 * ESR (Enclave State Registry) is emulated locally and ON by default: a
 * state-using backend -- `require('../ecld_state').StateRegistry`, get/commit,
 * the ownership/ACL API -- runs fully in-process against an in-memory registry
 * + store, with no chain, node, or SGX. State persists between runs in
 * .ecld-esr-local.*.json so a counter advances exactly as it would on-chain.
 * The task caller (the DO owner the trustedzone attests) defaults to your
 * developer address and is set for every task; override with --caller.
 *
 * Exit code 0 on TaskStatus SUCCESS, 1 otherwise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ethers } = require('ethers');

const TASK_STATUS_NAMES = {
  0: 'SUCCESS',
  1: 'SYSTEM_ERROR',
  2: 'KEY_ERROR',
  3: 'SYNTAX_WARNING',
  4: 'BASE_EXCEPTION',
  5: 'PAYLOAD_NOT_DEFINED',
  6: 'PAYLOAD_CHECKSUM_ERROR',
  7: 'INPUT_CHECKSUM_ERROR',
  8: 'EVAL_ERROR',
  28: 'IMPORT_ERROR',
  32: 'CONFIG_ERROR',
};

const VENDORED_SRC = path.join(__dirname, 'nodenithy', 'build', 'securelock', 'src');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/* Stage the executor + the project's backend the way ecld-build does inside
 * the enclave image, then load the REAL executor from the staged copy. */
function loadExecutor(projectSrc) {
  // Stage INSIDE the SDK tree (not the OS temp dir) so the executor's
  // `require('ethers')` and other runtime deps resolve by walking up to the
  // SDK's own node_modules -- exactly what binary-fs gives the enclave.
  const stageRoot = path.join(VENDORED_SRC, '..', '.ecld-test-stage');
  fs.mkdirSync(stageRoot, { recursive: true });
  const stage = fs.mkdtempSync(path.join(stageRoot, 'run-'));
  const cleanup = () => { try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {} };
  process.on('exit', cleanup);
  // `serve` runs until interrupted -- clean the stage on Ctrl-C / kill too.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanup(); process.exit(130); });
  }
  // Stage the ENTIRE vendored securelock src so `require('./ecld_state')`,
  // esr_local, and their deps all resolve, exactly as inside the enclave image.
  copyDir(VENDORED_SRC, stage);
  const backendDir = path.join(projectSrc, 'serverless');
  const backendJs = path.join(backendDir, 'backend.js');
  if (fs.existsSync(backendJs)) {
    copyDir(backendDir, path.join(stage, 'serverless'));
    console.log(`backend : ${backendJs}`);
  } else if (fs.existsSync(path.join(backendDir, 'backend.py'))) {
    console.log('backend : backend.py found — this is a Pynithy project; use');
    console.log('          ecld-test from ethernity-cloud-sdk-py instead.');
    console.log('          Continuing with bare globals (stock-enclave mode).');
  } else {
    console.log('backend : none found — running with bare globals, like a stock enclave');
  }
  const executor = require(path.join(stage, 'etny_exec.js'));
  executor.__stageDir = stage;
  return executor;
}

/* The task caller for local runs -- the DEVELOPER'S address, mirroring the
 * trustedzone-attested DO owner the real securelock receives. Resolution:
 *   1. --caller / ECLD_TEST_CALLER
 *   (a) WALLET_ADDRESS in .env (written at publish time)
 *   (b) derive from ECLD_PRIVATE_KEY
 *   else DEFAULT_TEST_CALLER (a well-known dev address). */
const DEFAULT_TEST_CALLER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function resolveCaller(explicit) {
  const chosen = explicit || process.env.ECLD_TEST_CALLER;
  if (chosen) return chosen.trim();
  if (process.env.WALLET_ADDRESS) return process.env.WALLET_ADDRESS.trim();     // (a)
  const pk = process.env.ECLD_PRIVATE_KEY;                                       // (b)
  if (pk) {
    try { return new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk).address; }
    catch (e) { /* fall through */ }
  }
  console.log(`[ecld-test] no developer address configured; using default test caller `
    + `${DEFAULT_TEST_CALLER} (set ECLD_TEST_CALLER or WALLET_ADDRESS)`);
  return DEFAULT_TEST_CALLER;
}

/* Install the local ESR emulator + set the task caller (ON by default). */
function installEsr(executor, caller) {
  try {
    const stage = executor.__stageDir;
    const ecldState = require(path.join(stage, 'ecld_state.js'));
    const esrLocal = require(path.join(stage, 'esr_local.js'));
    esrLocal.install(ecldState, { caller, filePrefix: '.ecld-esr-local' });
    return { ecldState };
  } catch (e) {
    console.log(`esr     : emulation unavailable (${e.message})`);
    return null;
  }
}

async function runTask(executor, payload, input, esr, caller) {
  // Set the task caller EXACTLY as the real securelock does after the
  // trustedzone hands it the DO owner -- for every task, ESR or not.
  if (esr && esr.ecldState) {
    try { esr.ecldState.setTaskCaller(caller || null); } catch (e) { /* ignore */ }
  }
  // executeTask is async (ESR reads/commits await); the real securelock awaits
  // it too (securelock.js: `await executeTask(...)`).
  const [code, resultRaw] = await executor.executeTask(payload, input || '');
  const result = typeof resultRaw === 'string' ? resultRaw : JSON.stringify(resultRaw);
  const checksum = crypto.createHash('sha256').update(result, 'utf8').digest('hex');
  const challenge = Array.from({ length: 20 }, () =>
    'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]
  ).join('');
  return {
    task_code: code,
    task_code_name: TASK_STATUS_NAMES[code] || `UNKNOWN_${code}`,
    result,
    checksum,
    enclave_challenge: challenge,
    result_string: `v3:${code}:${checksum}:${challenge}:`,
  };
}

function serve(executor, host, port, esr, defaultCaller) {
  const server = http.createServer((req, res) => {
    const send = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end(body);
    };
    if (req.method === 'OPTIONS') return send(204, {});
    if (req.method === 'GET' && req.url === '/v1/health') {
      // Probe with an expression that lists scope? Keep it simple: report ok.
      return send(200, { status: 'ok', backend: serve.backendFunctions || [] });
    }
    if (req.method === 'POST' && req.url === '/v1/task') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw || '{}');
          if (typeof body.payload !== 'string' || !body.payload.trim()) {
            return send(400, { error: 'payload (string) is required' });
          }
          let input = body.input;
          if (input !== undefined && input !== null && typeof input !== 'string') {
            input = JSON.stringify(input);
          }
          const caller = body.caller !== undefined ? body.caller : defaultCaller;
          runTask(executor, body.payload, input, esr, caller)
            .then((out) => {
              console.log(`[local-api] task -> ${out.task_code} (${out.task_code_name})`);
              send(200, out);
            })
            .catch((e) => send(500, { error: e.message }));
        } catch (e) {
          if (e instanceof SyntaxError) return send(400, { error: 'invalid JSON body' });
          return send(500, { error: e.message });
        }
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  server.listen(port, host, () => {
    console.log(`[local-api] listening on http://${host}:${port}  (POST /v1/task, GET /v1/health)`);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { src: 'src', host: '127.0.0.1', port: 8745 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') opts.file = argv[++i];
    else if (a === '--input' || a === '-i') opts.inputFile = argv[++i];
    else if (a === '--input-text') opts.inputText = argv[++i];
    else if (a === '--src') opts.src = argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--port') opts.port = parseInt(argv[++i], 10);
    else if (a === '--caller') opts.caller = argv[++i];
    else positional.push(a);
  }

  const projectSrc = path.resolve(opts.src);
  const executor = loadExecutor(projectSrc);
  // Record the backend's exported names once for /v1/health.
  try {
    serve.backendFunctions = Object.keys(require(path.join(projectSrc, 'serverless', 'backend.js')));
  } catch (e) {
    serve.backendFunctions = [];
  }

  // ESR emulation ON by default so a state-using backend runs locally exactly
  // as in an ESR-enabled enclave (no chain/node/SGX). Caller (default: your dev
  // address) is set for every task, so taskCaller() and the ACL behave as
  // on-chain.
  const caller = resolveCaller(opts.caller);
  const esr = installEsr(executor, caller);
  if (esr) console.log(`esr     : local emulation ON   caller ${caller}`);

  if (positional[0] === 'serve') {
    return serve(executor, opts.host, opts.port, esr, caller);
  }

  let payload;
  if (opts.file) payload = fs.readFileSync(opts.file, 'utf8');
  else if (positional.length) payload = positional.join(' ');
  else {
    console.error("usage: ecld-test 'hello(\"World\")' | ecld-test --file payload.js | ecld-test serve");
    process.exit(2);
  }

  let input = null;
  if (opts.inputFile && opts.inputText !== undefined) {
    console.error('--input and --input-text are mutually exclusive');
    process.exit(2);
  }
  if (opts.inputFile) input = fs.readFileSync(opts.inputFile, 'utf8');
  else if (opts.inputText !== undefined) input = opts.inputText;

  console.log(`payload : ${JSON.stringify(payload)}`);
  console.log(`input   : ${input === null ? '<empty>' : JSON.stringify(input.slice(0, 80))}`);
  const out = await runTask(executor, payload, input, esr, caller);
  console.log(`task code: ${out.task_code} (${out.task_code_name})`);
  console.log(`result   : ${JSON.stringify(out.result)}`);
  if (out.task_code !== 0) {
    console.log('\nThis is exactly what the network would write on-chain — the failed');
    console.log('attempt would still cost gas. Fix locally, then submit.');
  }
  process.exit(out.task_code === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
