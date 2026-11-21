// What the nodenithy securelock writes to its stdout and stderr, which the
// node's container log keeps and the operator reads. The data owner's
// payload, input and result reach this enclave encrypted and leave it
// encrypted for the trustedzone and the data owner; none of them, nothing of
// a session's inputs, outputs and summary, and no key is written there. The
// template and its modules write only through console (asserted below), so
// every console method is captured as console formats it (util.format)
// while the template's securelock runs:
//
//   - a plain task that succeeds, and one whose result is not text;
//   - a payload that throws an error quoting its input, and one that does
//     not parse;
//   - an uncaught exception and an unhandled rejection carrying data, a run
//     that fails, and a failure report that fails;
//   - a session's input, output and summary, and a session input the store
//     puts in the place of session.control and of session.config.
//
// securelock.js.tmpl starts its run at load and carries the build's tokens:
// its text is read, the tokens are rendered (a testnet_cas network without a
// ValidatorRegistry), the statement that starts the run is exported as
// main(), and the rest is compiled with a require that resolves from the
// securelock's src/ and a process of the test's own (its environment, the
// handlers the template registers, its exit code). etny_crypto is stood in
// for by helpers/securelock_app.js's signatures and the AES-256-GCM sealing
// below, the object store by esr_local's MemSwift, SwiftStreamService by a
// class that answers the test's store.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const Module = require('module');
const { SRC, cryptoStub, freshModules, p384KeyPair, settle } = require('./helpers/securelock_app');

const TEMPLATE = path.join(SRC, 'securelock.js.tmpl');
const BUCKET = 'etny-suite-v3';
const ORDER_ID = 4101;
const CHALLENGE = 'k7p2x9qv4m1zr8t3hw6n';
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

const PAYLOAD = 'zq9PAYLOADsecret';
const INPUT = 'zq9INPUTsecret';
const RESULT = 'zq9RESULTsecret';
const SESSION_INPUT = 'zq9SESSIONinput';
const SESSION_OUTPUT = 'zq9OUTPUTsecret';
const SECRETS = [PAYLOAD, INPUT, RESULT];
const METHODS = ['log', 'info', 'debug', 'error', 'warn', 'trace', 'dir'];

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// etny_crypto's sealing on node's crypto: AES-256-GCM under the SHA-256 of
// the recipient's public key (SPKI DER), the tuple stored as base64 JSON as
// the enclaves store it. encrypt reads its message as etny_crypto's
// encrypt_ecc does (cipher.update(message, 'utf8', 'hex')), so a message
// that is not text throws as it does there; decrypt answers false for an
// object that does not open, with etny_crypto's fixed log line.
const sealKey = (keyPem) => crypto.createHash('sha256')
  .update(crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' })).digest();
const sealing = {
  encrypt(certificate, message) {
    const nonce = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(certificate), nonce);
    let ciphertext = cipher.update(message, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    return { ciphertext, nonce, authTag: cipher.getAuthTag().toString('hex') };
  },
  encryptedDataToBase64Json(m) {
    return Buffer.from(JSON.stringify({ ciphertext: m.ciphertext, nonce: m.nonce.toString('hex'), authTag: m.authTag }), 'utf8').toString('base64');
  },
  encryptedDataFromBase64Json(base64Data) {
    return JSON.parse(Buffer.from(base64Data, 'base64').toString('utf8'));
  },
  decrypt(privateKeyPem, m) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(privateKeyPem), Buffer.from(m.nonce, 'hex'));
      decipher.setAuthTag(Buffer.from(m.authTag, 'hex'));
      return decipher.update(m.ciphertext, 'hex', 'utf8') + decipher.final('utf8');
    } catch (e) {
      console.log('Error while decrypting ECC');
      return false;
    }
  },
  // The data owner's encryption: the data read as Buffer.from reads it, as
  // etny_crypto's encryptWithPublicKey reads it.
  encryptWithPublicKey(publicKey, data) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(String(publicKey)).digest(), nonce);
    return Buffer.concat([nonce, cipher.update(Buffer.from(data)), cipher.final(), cipher.getAuthTag()]);
  },
};
const sealed = (publicPem, text) => sealing.encryptedDataToBase64Json(sealing.encrypt(publicPem, text));
const opened = (privatePem, stored) => sealing.decrypt(privatePem, sealing.encryptedDataFromBase64Json(String(stored)));

// The template compiled off SGX: its EtnySecureLock, reportFailure and
// main() (the statement that starts the run), the process it was given, and
// the securelock modules it loaded. `store()` answers each construction of
// SwiftStreamService.
function loadTemplate({ store = null } = {}) {
  const mods = freshModules();
  let source = fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
  for (const [token, value] of Object.entries(RENDERED)) source = source.split(token).join(value);
  assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(source), 'every token of the template is rendered');
  const start = source.lastIndexOf(START);
  assert.notEqual(start, -1, 'the template ends with the statement that starts the run');
  const tail = source.slice(start + 1);
  const end = tail.lastIndexOf('})();');
  assert.equal(tail.slice(end).trim(), '})();');
  source = `${source.slice(0, start)}\nmodule.exports = { EtnySecureLock, reportFailure, main: ${tail.slice(1, end + 1)} };\n`;

  const storeOf = store || (() => new mods.esrLocal.MemSwift());
  const standIns = {
    dotenv: { config: () => ({}), parse: require('dotenv').parse },
    './etny_crypto': { ...cryptoStub, ...sealing },
    './swift_stream_service': class SwiftStreamService {
      constructor() { return storeOf(); }
    },
    './self_sign': { generateCertFromMrEnclave() { throw new Error('no SGX report off the enclave'); } },
  };
  const fromSrc = Module.createRequire(path.join(SRC, 'securelock.js'));
  const requireOf = (name) => (Object.prototype.hasOwnProperty.call(standIns, name) ? standIns[name] : fromSrc(name));
  const handlers = {};
  const proc = {
    env: {},
    handlers,
    exitCode: undefined,
    on(event, fn) { handlers[event] = fn; return proc; },
    exit(code) { proc.exited = code; },
  };
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', source)(
    requireOf, compiled, compiled.exports, path.join(SRC, 'securelock.js'), SRC, proc);
  return { ...compiled.exports, process: proc, mods };
}

// fn()'s value and every text console wrote while it ran, each method's
// arguments formatted as console formats them.
async function written(fn) {
  const lines = [];
  const saved = Object.fromEntries(METHODS.map((name) => [name, console[name]]));
  for (const name of METHODS) console[name] = (...args) => { lines.push(util.format(...args)); };
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

// Neither a secret nor its first ten characters (the part of a text a JSON
// parse error quotes) is in any line.
function assertNothingOf(lines, secrets, what) {
  const text = lines.join('\n');
  for (const secret of secrets) {
    assert.ok(!text.includes(secret.slice(0, 10)), `${what}: ${secret} is not written`);
  }
}

// An order handed to the template's securelock: the payload and the input
// sealed for it and signed by the trustedzone, the order metadata their
// checksums, the task binding the trustedzone's. stage() puts a session
// object as the trustedzone stages it, signed over the plain text.
function order({ payload, input = INPUT, store = null } = {}) {
  const L = loadTemplate({ store });
  const swift = new L.mods.esrLocal.MemSwift();
  const tz = p384KeyPair();
  const sl = p384KeyPair();
  const app = new L.EtnySecureLock(swift);
  app.identity_private_key_pem = sl.privateKeyPem;
  app.trustedZonePublicKey = tz.publicKeyPem;
  app.image_registry = { getLatestTrustedZoneImageCertPublicKey: async () => ['v3', tz.publicKeyPem] };
  app.task_binding = { order_id: ORDER_ID, challenge: CHALLENGE };
  app._metadata = {
    image_metadata: 'v3:QmSecurelock:etny-suite-trustedzone',
    payload_metadata_obj: { has_checksum: true, checksum: sha256(payload) },
    input_metadata_obj: { has_checksum: true, checksum: sha256(input), ipfs_hash: 'QmInput' },
    public_key: `0x${'42'.repeat(32)}`,
  };
  const put = (name, text) => { swift._store.set(`${BUCKET}/${name}`, Buffer.from(text, 'utf8')); };
  const get = (name) => {
    const v = swift._store.get(`${BUCKET}/${name}`);
    return v === undefined ? undefined : v.toString('utf8');
  };
  put('payload.etny.securelock', sealed(sl.publicKeyPem, payload));
  put('payload.etny.securelock.sig', sealed(sl.publicKeyPem, cryptoStub.signData(tz.privateKeyPem, payload)));
  put('input.txt.securelock', sealed(sl.publicKeyPem, input));
  put('input.txt.securelock.sig', sealed(sl.publicKeyPem, cryptoStub.signData(tz.privateKeyPem, input)));
  const stage = (base, text) => {
    put(`${base}.sig.securelock`, sealed(sl.publicKeyPem, cryptoStub.signData(tz.privateKeyPem, text)));
    put(`${base}.securelock`, sealed(sl.publicKeyPem, text));
  };
  // The store puts the objects of session object `from` in the place of `to`.
  const copy = (from, to) => {
    put(`${to}.sig.securelock`, get(`${from}.sig.securelock`));
    put(`${to}.securelock`, get(`${from}.securelock`));
  };
  return { ...L, app, swift, tz, sl, get, stage, copy };
}

const resultLine = (code, result) => `TASK RESULT: code ${code}, ${Buffer.byteLength(String(result), 'utf8')} bytes, sha256 ${sha256(String(result))}`;

async function until(cond, what) {
  for (let i = 0; i < 100000 && !cond(); i += 1) await Promise.resolve();
  assert.ok(cond(), what);
}

async function ticks(t, n, ms = 2000) {
  for (let i = 0; i < n; i += 1) {
    t.mock.timers.tick(ms);
    await settle();
  }
}

const sourceNames = () => fs.readdirSync(SRC).filter((n) => n.endsWith('.js') || n.endsWith('.tmpl')).sort();
const sourceLines = (name) => fs.readFileSync(path.join(SRC, name), 'utf8').replace(/\r\n/g, '\n').split('\n');

test('the template and its modules write to stdout and stderr only through console', () => {
  for (const name of sourceNames()) {
    const writes = sourceLines(name).filter((line) => /process\.std(out|err)|process\._rawDebug|fs\.writeSync\(\s*[12]\b|util\.(debuglog|inspect)|\/dev\/std(out|err)/.test(line));
    if (name === 'securelock.js.tmpl') {
      // The two lines that make stdout and stderr blocking.
      assert.equal(writes.length, 2);
      for (const line of writes) {
        assert.match(line.trim(), /^try \{ if \(process\.(stdout|stderr)\._handle && process\.\1\._handle\.setBlocking\) process\.\1\._handle\.setBlocking\(true\); \} catch \(e\) \{\}$/);
      }
    } else {
      assert.deepEqual(writes, [], name);
    }
  }
});

// The commented-out console calls the template and its modules hold, by
// file: public keys and certificates, the order and its metadata from the
// chain, fixed texts, a file error, a store answer, and the fixed message of
// a commented-out encryption example. None prints the environment, a private
// key, the challenge, a stored object, the payload, the input or the result.
const COMMENTED_CONSOLE = {
  'etny_crypto.js': [
    '//console.log(certificate)',
    '//console.log(key);',
    "//         console.log('initial message:', message);",
    '//         console.log(encrypted_message);',
    '//         console.log(encryptedDataToBase64Json(encrypted_message));',
    "//         // console.log('decrypted message:', messageDecrypted);",
    '//         console.log(e);',
  ],
  'securelock.js.tmpl': [
    "//console.log('order', order);",
    "//console.log('metadata', this._metadata);",
    "//console.log('Private certificate file was cleaned.')",
    "//console.log('Error while removing the private key file content', e);",
    '//console.log(`Public certificate saved to ${this.pub_cert_file}`);',
    "//console.log('Save result put: ', result);",
  ],
};

test('the commented-out console calls of the template and its modules are the ones COMMENTED_CONSOLE names', () => {
  for (const name of sourceNames()) {
    const commented = sourceLines(name).map((line) => line.trim())
      .filter((line) => /^(\/\/|\*|\/\*).*\bconsole\.(log|info|debug|error|warn|trace|dir)\s*\(/.test(line));
    assert.deepEqual(commented, COMMENTED_CONSOLE[name] || [], name);
  }
});

test('a plain task that succeeds: its payload, input and result are not written; the result is logged as its code, its length and its SHA-256', async () => {
  const o = order({ payload: `'${PAYLOAD}'; ecld.result('${RESULT}:' + ecld.input)` });
  const { value, lines } = await written(async () => {
    const executed = await o.app.execute();
    await o.app.saveResult();
    return executed;
  });
  assertNothingOf(lines, SECRETS, 'a SUCCESS');
  assert.equal(value, true);
  assert.equal(o.app.task_code, 0);
  const envelope = JSON.parse(o.app.task_result);
  assert.equal(envelope.data, `${RESULT}:${INPUT}`);
  assert.equal(envelope.order_id, ORDER_ID);
  assert.equal(opened(o.tz.privateKeyPem, o.get('result.txt.securelock')), o.app.task_result);
  assert.ok(lines.includes(resultLine(0, o.app.task_result)), 'the TASK RESULT line');
});

test('a result that is not text: the encryption\'s error, which quotes it, is logged by class; a result String() does not convert is logged as not text', async () => {
  const NUMBER = '7310925418063';
  const o = order({ payload: `'${PAYLOAD}'; throw { args: [[0, ${NUMBER}]] }` });
  const { value, lines } = await written(async () => {
    const executed = await o.app.execute();
    await o.app.saveResult();
    return executed;
  });
  assertNothingOf(lines, [...SECRETS, NUMBER], 'a result that is not text');
  assert.equal(value, true);
  assert.equal(o.app.task_code, 0);
  assert.equal(o.app.task_result, Number(NUMBER));
  assert.equal(o.get('result.txt.securelock'), undefined, 'the result is not encrypted');
  assert.ok(lines.includes(resultLine(0, NUMBER)));
  assert.ok(lines.includes('Save result failed: TypeError'));

  const bare = order({ payload: `'${PAYLOAD}'; throw { args: [[0, Object.create(null)]] }` });
  const second = await written(() => bare.app.execute());
  assertNothingOf(second.lines, SECRETS, 'a result String() does not convert');
  assert.equal(second.value, true);
  assert.ok(second.lines.includes('TASK RESULT: code 0, not text'));
});

test('a payload that throws an error quoting its input, and one that does not parse: the error is logged by class, its message and stack are the result', async () => {
  const { TaskStatus } = require(path.join(SRC, 'task_status.js'));
  const throwing = order({ payload: `'${PAYLOAD}'; throw new Error('the input ' + ecld.input + ' is refused')` });
  const first = await written(() => throwing.app.execute());
  assertNothingOf(first.lines, SECRETS, 'an error quoting the input');
  assert.equal(first.value, true);
  assert.equal(throwing.app.task_code, TaskStatus.BASE_EXCEPTION);
  assert.match(throwing.app.task_result, new RegExp(`^BASE_EXCEPTION: Error: the input ${INPUT} is refused\\n`));
  assert.ok(first.lines.includes('Error in payload execution: Error'));

  const unparsed = order({ payload: `let marker = 1 ${PAYLOAD}` });
  const second = await written(() => unparsed.app.execute());
  assertNothingOf(second.lines, SECRETS, 'a payload that does not parse');
  assert.equal(second.value, true);
  assert.equal(unparsed.app.task_code, TaskStatus.SYNTAX_WARNING);
  assert.match(unparsed.app.task_result, new RegExp(`Unexpected identifier '${PAYLOAD}'`));
  assert.ok(second.lines.includes('Error in payload execution: SyntaxError'));
});

test('an uncaught exception and an unhandled rejection carrying data are logged by class', async () => {
  const L = loadTemplate();
  const { lines } = await written(() => {
    L.process.handlers.uncaughtException(new Error(`the input ${INPUT} is refused`));
    L.process.handlers.uncaughtException(INPUT);
    L.process.handlers.unhandledRejection(new TypeError(`${RESULT} is not a function`));
    L.process.handlers.unhandledRejection(RESULT);
  });
  assertNothingOf(lines, SECRETS, 'the process handlers');
  assert.deepEqual(lines, [
    'uncaught exception: Error',
    'uncaught exception: string',
    'unhandled rejection: TypeError',
    'unhandled rejection: string',
  ]);
});

test('a run that fails and a failure report that fails are logged by class', async () => {
  const failing = loadTemplate({ store: () => { throw new Error(`the store refused ${RESULT}`); } });
  const run = await written(() => failing.main());
  assertNothingOf(run.lines, SECRETS, 'a run that fails');
  assert.equal(failing.process.exitCode, 1);
  assert.ok(run.lines.includes('securelock failed: Error'));
  assert.ok(run.lines.includes('cannot report failure: enclave died before initialization'));

  const L = loadTemplate();
  const app = new L.EtnySecureLock(new L.mods.esrLocal.MemSwift());
  app.task_code = 4;
  app.task_result = `BASE_EXCEPTION: ${INPUT}`;
  app.saveResult = async () => { throw new Error(`the store refused ${RESULT}`); };
  const report = await written(() => L.reportFailure(app, new Error(INPUT)));
  assertNothingOf(report.lines, SECRETS, 'a failure report that fails');
  assert.deepEqual(report.lines, ['could not report the failure result: Error']);
});

const SESSION_PAYLOAD = `'${PAYLOAD}';
ecld.onInput = async (data) => 'reply to ' + data + ': ${SESSION_OUTPUT}';
'context'`;
const SESSION_CONFIG = JSON.stringify({ order_id: ORDER_ID, close_after_seconds: 3600, input_cutoff_seconds: 3000, max_messages: 256 });

test('a session: its input, its output and its summary are not written; the summary is logged as the result\'s code, length and SHA-256', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const o = order({ payload: SESSION_PAYLOAD });
  o.stage('session.config', SESSION_CONFIG);
  o.stage('session.input.0', SESSION_INPUT);
  const { value, lines } = await written(async () => {
    const executing = o.app.execute();
    await until(() => o.get('session.output.0.securelock') !== undefined, 'output 0 staged');
    o.stage('session.control', 'close');
    await ticks(t, 1);
    return executing;
  });
  assertNothingOf(lines, [...SECRETS, SESSION_INPUT, SESSION_OUTPUT], 'a session');
  assert.ok(!lines.join('\n').includes(o.app.task_result), 'the summary is not written');
  assert.equal(value, true);
  const output = JSON.parse(opened(o.tz.privateKeyPem, o.get('session.output.0.securelock')));
  assert.equal(output.data, `reply to ${SESSION_INPUT}: ${SESSION_OUTPUT}`);
  assert.equal(o.app.task_code, 0);
  assert.deepEqual(JSON.parse(o.app.task_result), { session: 'v1', reason: 'CLOSED', seen: 1, processed: 1, emitted: 1, unprocessed: [] });
  assert.ok(lines.includes('session: finalizing'));
  assert.ok(lines.includes(resultLine(0, o.app.task_result)));
});

test('a session input the store puts in the place of session.control is not written', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const o = order({ payload: SESSION_PAYLOAD });
  o.stage('session.config', SESSION_CONFIG);
  o.stage('session.input.0', SESSION_INPUT);
  o.copy('session.input.0', 'session.control');
  const { value, lines } = await written(async () => {
    const executing = o.app.execute();
    await until(() => o.get('session.output.0.securelock') !== undefined, 'output 0 staged');
    o.stage('session.control', 'close');
    await ticks(t, 1);
    return executing;
  });
  assertNothingOf(lines, [...SECRETS, SESSION_INPUT, SESSION_OUTPUT], 'a session input as the control');
  assert.equal(value, true);
  assert.equal(JSON.parse(o.app.task_result).reason, 'CLOSED');
  assert.ok(lines.includes('session: unknown control -- ignoring'));
});

test('a session input the store puts in the place of session.config is not written', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { TaskStatus } = require(path.join(SRC, 'task_status.js'));
  const o = order({ payload: SESSION_PAYLOAD });
  o.stage('session.input.0', SESSION_INPUT);
  o.copy('session.input.0', 'session.config');
  const { value, lines } = await written(() => o.app.execute());
  assertNothingOf(lines, [...SECRETS, SESSION_INPUT, SESSION_OUTPUT], 'a session input as the config');
  assert.equal(value, true);
  assert.equal(o.app.task_code, TaskStatus.SYSTEM_ERROR);
  assert.match(o.app.task_result, /^SESSION EXECUTOR ERROR: /);
  assert.ok(o.app.task_result.includes(SESSION_INPUT.slice(0, 10)), 'the parse error quotes the text it parsed');
  assert.ok(lines.includes('session executor failed: SyntaxError'));
});

test('errorClass and resultDigest', () => {
  const { errorClass, resultDigest } = require(path.join(SRC, 'log_text.js'));
  class StateFault extends Error {}
  assert.equal(errorClass(new StateFault(INPUT)), 'StateFault');
  assert.equal(errorClass({ constructor: { name: INPUT } }), 'Object');
  assert.equal(errorClass(Object.create(null)), 'object');
  assert.equal(errorClass(new Proxy({}, { getPrototypeOf() { throw new Error(INPUT); } })), 'object');
  assert.equal(errorClass(INPUT), 'string');
  assert.equal(errorClass(null), 'null');
  assert.equal(errorClass(undefined), 'undefined');
  assert.equal(resultDigest(RESULT), `${RESULT.length} bytes, sha256 ${sha256(RESULT)}`);
  assert.equal(resultDigest('é'), `2 bytes, sha256 ${sha256('é')}`);
  assert.equal(resultDigest(Object.create(null)), 'not text');
});
