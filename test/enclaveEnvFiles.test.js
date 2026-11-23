// No securelock of this package loads a .env file of its file system. The
// nodenithy securelock's sources (nodenithy/build/securelock/src) use dotenv
// only as require('dotenv').parse( and call no process.loadEnvFile; the
// pynithy securelock's (pynithy/build/securelock/src, the mirror of the
// Python SDK's) name dotenv on no line, so neither load_dotenv nor
// dotenv_values reads a file. The per-order values reach the securelock in
// the environment the fixed start passes and in the .env object of its
// store bucket, which readEnv parses in memory and admits key by key
// (NODE_ENV_ALLOWLIST). A file a CAS session places outside the paths of the
// file tree check, such as /app/.env, is read by no entry.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { SRC, cryptoStub, freshModules } = require('./helpers/securelock_app');

const ROOT = path.join(__dirname, '..');
const PYNITHY_SRC = path.join(ROOT, 'pynithy', 'build', 'securelock', 'src');
const TEMPLATE = path.join(SRC, 'securelock.js.tmpl');
// The one use of dotenv a nodenithy securelock source makes: a parse in memory.
const PARSE = "require('dotenv').parse(";
const BUCKET = 'etny-suite-v3';
const RENDERED = Object.freeze({
  __ETNY_NETWORK_TYPE__: 'testnet_cas',
  __ETNY_BUCKET__: BUCKET,
  __ENCLAVE_NAME_SECURELOCK__: 'etny-suite-securelock',
  __ETNY_SMART_CONTRACT_ADDRESS__: '0x00000000000000000000000000000000000000A1',
  __ETNY_IMAGE_REGISTRY_ADDRESS__: '0x00000000000000000000000000000000000000B2',
  __ETNY_VALIDATOR_REGISTRY_ADDRESS__: '',
  __ETNY_CHAIN_ID__: '8995',
  __ETNY_WEB3_PROVIDER__: 'http://rpc.invalid',
});
// The statement at the end of the template that starts the run.
const START = '\n(async () => {\n    let failed = false;';

// The files below `dir` whose name matches `pattern`, node_modules left out.
function files(dir, pattern) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...files(file, pattern));
    } else if (pattern.test(entry.name)) {
      out.push(file);
    }
  }
  return out;
}

// The lines of JavaScript `text` that load a .env file or may, as
// "<line>: <text>": every line that is not a comment line (one that starts
// with //, /* or *) and names dotenv other than in PARSE, or names
// loadEnvFile.
function javascriptEnvFileLoads(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const code = line.trim();
    if (/^(\/\/|\/\*|\*)/.test(code)) return;
    if (/dotenv|loadEnvFile/.test(code.split(PARSE).join(''))) found.push(`${i + 1}: ${code}`);
  });
  return found;
}

// The lines of Python `text` that are not comment lines and name dotenv.
function pythonEnvFileLoads(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const code = line.trim();
    if (!code.startsWith('#') && /dotenv/.test(code)) found.push(`${i + 1}: ${code}`);
  });
  return found;
}

const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// Every file of `list` with the lines `check` finds in it.
function loads(list, check) {
  const out = {};
  for (const file of list) {
    const found = check(fs.readFileSync(file, 'utf8'));
    if (found.length) out[relative(file)] = found;
  }
  return out;
}

test('no nodenithy securelock source loads a .env file: dotenv only in require(\'dotenv\').parse(, no process.loadEnvFile', () => {
  const list = files(SRC, /\.(js|mjs|cjs)(\.tmpl)?$/);
  assert.ok(list.map(relative).includes('nodenithy/build/securelock/src/securelock.js.tmpl'));
  assert.deepEqual(loads(list, javascriptEnvFileLoads), {});
  assert.ok(fs.readFileSync(TEMPLATE, 'utf8').includes(PARSE), 'readEnv parses the bucket\'s .env with dotenv');
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
  assert.ok(Object.prototype.hasOwnProperty.call(pkg.dependencies, 'dotenv'), 'src/package.json keeps dotenv for that parse');
});

test('no pynithy securelock source names dotenv: no load_dotenv, no dotenv_values', () => {
  const list = files(PYNITHY_SRC, /\.py(\.tmpl)?$/);
  assert.ok(list.map(relative).includes('pynithy/build/securelock/src/securelock.py.tmpl'));
  assert.deepEqual(loads(list, pythonEnvFileLoads), {});
});

test('the checks find each form of a .env file load, and pass a parse and a comment', () => {
  for (const line of [
    "require('dotenv').config();",
    "require('dotenv').config({path: './app/.env'});",
    'require("dotenv").config({path: "/app/.env"});',
    "require('dotenv/config');",
    "import 'dotenv/config';",
    "const { config } = require('dotenv');",
    "const env = require('dotenv'); env.configDotenv();",
    "process.loadEnvFile('/app/.env');",
    "const parsed = require('dotenv').parse(text); require('dotenv').config();",
  ]) assert.equal(javascriptEnvFileLoads(line).length, 1, line);
  for (const line of [
    "            const parsed = require('dotenv').parse(Buffer.from(envFile));",
    '// Parsed in memory: dotenv.parse does not touch process.env.',
    " * require('dotenv').config() is not called",
    '/* dotenv */',
  ]) assert.deepEqual(javascriptEnvFileLoads(line), [], line);
  for (const line of [
    'from dotenv import load_dotenv',
    'load_dotenv()',
    'import dotenv',
    "values = dotenv_values('/app/.env')",
  ]) assert.equal(pythonEnvFileLoads(line).length, 1, line);
  assert.deepEqual(pythonEnvFileLoads('    # load_dotenv is not called'), []);
});

// The template's EtnySecureLock compiled off SGX over `store`, with dotenv
// given as its parse alone (a template that calls dotenv.config throws here),
// and the process it was given.
function loadTemplate(store) {
  freshModules();
  let source = fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
  for (const [token, value] of Object.entries(RENDERED)) source = source.split(token).join(value);
  assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(source), 'every token of the template is rendered');
  const start = source.lastIndexOf(START);
  assert.notEqual(start, -1, 'the template ends with the statement that starts the run');
  source = `${source.slice(0, start)}\nmodule.exports = { EtnySecureLock };\n`;
  const standIns = {
    dotenv: Object.freeze({ parse: require('dotenv').parse }),
    './etny_crypto': cryptoStub,
    './swift_stream_service': class SwiftStreamService {
      constructor() { return store; }
    },
    './self_sign': { generateCertFromMrEnclave() { throw new Error('no SGX report off the enclave'); } },
  };
  const fromSrc = Module.createRequire(path.join(SRC, 'securelock.js'));
  const requireOf = (name) => (Object.prototype.hasOwnProperty.call(standIns, name) ? standIns[name] : fromSrc(name));
  const proc = { env: {}, on() { return proc; }, exit() {} };
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', source)(
    requireOf, compiled, compiled.exports, path.join(SRC, 'securelock.js'), SRC, proc);
  return { EtnySecureLock: compiled.exports.EtnySecureLock, process: proc };
}

// fn()'s value and the lines console.log wrote while it ran.
async function logged(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = log;
  }
}

test('readEnv takes the bucket\'s .env through dotenv.parse alone and admits the allow-listed keys the environment does not set', async () => {
  const { esrLocal } = freshModules();
  const store = new esrLocal.MemSwift();
  await store.putFileContent(BUCKET, '.env', '', [
    'ETNY_MODE=PUBLIC_KEY',
    'ETNY_ORDER_ID=17',
    'ETNY_CLIENT_CHALLENGE=from-the-bucket',
    'ESR_CONTRACT_ADDRESS=0x00000000000000000000000000000000000000E5',
    'ENCLAVE_KDF_SALT=from-the-bucket',
  ].join('\n'));
  const { EtnySecureLock, process: proc } = loadTemplate(store);
  proc.env.ETNY_CLIENT_CHALLENGE = 'from-the-environment';
  const { value: app } = await logged(async () => new EtnySecureLock(store));
  const { value: read, lines } = await logged(() => app.readEnv());
  assert.equal(read, true);
  assert.deepEqual(proc.env, {
    ETNY_CLIENT_CHALLENGE: 'from-the-environment',
    ETNY_MODE: 'PUBLIC_KEY',
    ETNY_ORDER_ID: '17',
  });
  assert.equal(app.etny_mode, 'PUBLIC_KEY');
  for (const key of ['ESR_CONTRACT_ADDRESS', 'ENCLAVE_KDF_SALT']) {
    assert.ok(lines.includes(`Ignoring non-allowlisted .env key from the node bucket: ${key}`), key);
  }
});
