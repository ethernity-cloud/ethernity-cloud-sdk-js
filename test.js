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
 * Exit code 0 on TaskStatus SUCCESS, 1 otherwise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

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
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-test-'));
  for (const f of ['etny_exec.js', 'task_status.js']) {
    fs.copyFileSync(path.join(VENDORED_SRC, f), path.join(stage, f));
  }
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
  return require(path.join(stage, 'etny_exec.js'));
}

function runTask(executor, payload, input) {
  const [code, resultRaw] = executor.executeTask(payload, input || '');
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

function serve(executor, host, port) {
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
          const out = runTask(executor, body.payload, input);
          console.log(`[local-api] task -> ${out.task_code} (${out.task_code_name})`);
          return send(200, out);
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

function main() {
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

  if (positional[0] === 'serve') {
    return serve(executor, opts.host, opts.port);
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
  const out = runTask(executor, payload, input);
  console.log(`task code: ${out.task_code} (${out.task_code_name})`);
  console.log(`result   : ${JSON.stringify(out.result)}`);
  if (out.task_code !== 0) {
    console.log('\nThis is exactly what the network would write on-chain — the failed');
    console.log('attempt would still cost gas. Fix locally, then submit.');
  }
  process.exit(out.task_code === 0 ? 0 : 1);
}

main();
