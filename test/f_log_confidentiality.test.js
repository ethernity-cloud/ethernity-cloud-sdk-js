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
// The store credential is written there neither: the template's run on the
// credential of a file at /run/ecld/store.json against a store that refuses
// it and names its access key in the refusal, and on the literal pair where
// nothing is at that path.
//
// helpers/securelock_template.js compiles the template off SGX and holds the
// stand-ins the runs use.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { SRC, settle } = require('./helpers/securelock_app');
const T = require('./helpers/securelock_template');

const { BUCKET, ORDER_ID, loadTemplate, written, opened, sha256 } = T;

const PAYLOAD = 'zq9PAYLOADsecret';
const INPUT = 'zq9INPUTsecret';
const RESULT = 'zq9RESULTsecret';
const SESSION_INPUT = 'zq9SESSIONinput';
const SESSION_OUTPUT = 'zq9OUTPUTsecret';
const SECRETS = [PAYLOAD, INPUT, RESULT];

// Neither a secret nor its first ten characters (the part of a text a JSON
// parse error quotes) is in any line.
function assertNothingOf(lines, secrets, what) {
  const text = lines.join('\n');
  for (const secret of secrets) {
    assert.ok(!text.includes(secret.slice(0, 10)), `${what}: ${secret} is not written`);
  }
}

// An order of the template's securelock whose input is INPUT unless given.
const order = (given) => T.order({ input: INPUT, ...given });

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

test('the store credential: a run on the keys of the file at /run/ecld/store.json, refused by a store that names the access key, and a run on the literal pair write neither key and nothing of the file', async () => {
  const ACCESS = 'zq9ACCESSsecret';
  const SECRET = 'zq9SECRETsecret0123456789';
  const LITERAL = 'swiftstreamadmin';
  const CERTIFICATE = '-----BEGIN CERTIFICATE-----\nc3VpdGU=\n-----END CERTIFICATE-----\n';
  const content = `{"accessKey":"${ACCESS}","secretKey":"${SECRET}"}\n`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-log-credential-'));
  const file = path.join(directory, 'store.json');
  fs.writeFileSync(file, content);
  fs.writeFileSync(path.join(directory, 'cert.pem'), CERTIFICATE);
  try {
    // The securelock's SwiftStreamService over a minio client whose store
    // refuses every request.
    const minio = new T.MinioStandIn();
    minio.refuse = true;
    const Service = T.storeService(minio);

    const refusal = await new Service('etny-swift-stream', 9000, ACCESS, SECRET).getFileContent(BUCKET, '.env').catch((e) => e);
    assert.equal(refusal.code, 'InvalidAccessKeyId');
    assert.ok(util.inspect(refusal).includes(ACCESS), 'the error of a refused request names the access key');

    // The run finds no .env and saves its certificate: the read and the put
    // are both refused.
    const run = async (credentialFile) => {
      minio.clients.length = 0;
      minio.calls.length = 0;
      const L = loadTemplate({ modules: { './swift_stream_service': Service } });
      T.certificateIn(L, directory);
      const { value, opens } = await T.withCredentialFile(credentialFile, () => written(() => L.execute()));
      return { lines: value.lines, opens };
    };

    const mounted = await run(file);
    assert.equal(mounted.opens, 1);
    assert.deepEqual(minio.clients.map((options) => [options.accessKey, options.secretKey]), [[ACCESS, SECRET]]);
    assert.deepEqual(minio.calls, [['getObject', BUCKET, '.env'], ['bucketExists', BUCKET]]);
    assert.deepEqual(mounted.lines.filter((line) => line.includes('store credential')), ['store credential: file (/run/ecld/store.json)']);
    assert.ok(mounted.lines.includes('Failed reading .env file.'));
    assert.ok(mounted.lines.includes(CERTIFICATE), 'the certificate is read and logged before its put');
    assertNothingOf(mounted.lines, [ACCESS, SECRET, content.trim()], 'a refused file credential');
    assert.ok(mounted.lines.includes('Save public certificate error: S3Error'));

    const absent = await run(path.join(directory, 'nothing', 'store.json'));
    assert.equal(absent.opens, 1);
    assert.deepEqual(minio.clients.map((options) => [options.accessKey, options.secretKey]), [[LITERAL, LITERAL]]);
    assert.deepEqual(minio.calls, [['getObject', BUCKET, '.env'], ['bucketExists', BUCKET]]);
    assert.deepEqual(absent.lines.filter((line) => line.includes('store credential')), ['store credential: literal (/run/ecld/store.json: absent)']);
    assert.ok(!absent.lines.join('\n').includes(LITERAL), 'the literal pair is not written');
    assert.ok(absent.lines.includes('Save public certificate error: S3Error'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  // No console call of the template or of a module names the credential or
  // the store client, whose minio client holds both keys; the reader's one
  // mention of console is the default of its log argument, and
  // SwiftStreamService calls console nowhere.
  const code = (name) => sourceLines(name).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  for (const name of sourceNames()) {
    assert.ok(!/console\.\w+\([^\n]*(\b(credential|swiftStreamClient|swiftStreamService|accessKey|secretKey)\b|\b_swift\b|\bthis\.swift\b)/.test(code(name)), name);
  }
  assert.deepEqual(code('store_credential.js').match(/\bconsole\.\w+/g), ['console.log']);
  assert.equal(code('swift_stream_service.js').match(/\bconsole\.\w+/g), null);
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
