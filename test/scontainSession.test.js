// The upload of a securelock session to the Scontain CAS
// (cas/scontain_session.js) and the client key it is made under, against
// test/helpers/cas_stand_in.js: an HTTPS server on a loopback port that
// requires a client certificate, records the key each request came under and
// keeps sessions by the SCONE rules the upload relies on (the uploader's key
// holds a session unless its access_policy names other keys). No request
// leaves the machine: every upload is given the stand-in's URL, and a host
// name lookup fails the test.
//
// A publish is run here as nodenithy/run.js and pynithy/run.js run its CAS
// step: the session file rendered from the package's template into the run
// directory of a scratch project, the upload with the project's settings, and
// the answer's hash stored as the next predecessor. The call run.js makes is
// read from its source with acorn. The wallet is the 0xee...ee one of
// test/vectors/cas-client-key.json, whose derived public key the vector holds.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { Parser } = require('acorn');
const dotenv = require('dotenv');
const yaml = require('js-yaml');

// The scratch tree of this file and, in it, the directory os.tmpdir() names
// from here on: whatever the code under test writes to the system's temporary
// directory lands there.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-scontain-session-'));
const TEMP = path.join(SCRATCH, 'tmp');
fs.mkdirSync(TEMP);
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = TEMP;

// An address is looked up as node does; a host name ends the test.
const { lookup } = dns;
dns.lookup = (hostname, ...rest) => {
  if (net.isIP(hostname) === 0) throw new Error(`this test resolves no host name: ${hostname}`);
  return lookup(hostname, ...rest);
};

const casConfig = require('../cas/config.js');
const { casClientKey } = require('../cas/client_key.js');
const scontainSession = require('../cas/scontain_session.js');
const { startCas, post, throwawayIdentity, keyOfCertificate } = require('./helpers/cas_stand_in.js');

const ROOT = path.join(__dirname, '..');
const { vectors } = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'cas-client-key.json'), 'utf8'));
const WALLET = vectors.find((v) => v.walletPrivateKey === `0x${'ee'.repeat(32)}`);
const WALLET_KEY = WALLET.walletPrivateKey;
const WALLET_CAS_KEY = WALLET.publicKeySpkiDer;
const SESSION_NAME = 'demo_SECURELOCK_V3_bloxberg_1';
const MRENCLAVE = 'ab'.repeat(32);
const { RECORD, HANDOVER, WALLET: WALLET_RECORD } = scontainSession;
// The directories of the package a publish works in, and what they hold when
// this file starts.
const PACKAGE_DIRS = ['cas', 'nodenithy/run', 'pynithy/run'];
const listed = () => PACKAGE_DIRS.map((dir) => fs.readdirSync(path.join(ROOT, dir)).sort());
const PACKAGE_FILES = listed();

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

test.after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

// A scratch project: .env at its root and the run directory of the installed
// package, where run.js renders the session file and where an SDK up to
// 1.9.1 kept key.pem and cert.pem (`legacy`).
function project({ stack = 'nodenithy', legacy = null } = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'project-'));
  const runDir = path.join(dir, 'node_modules', '@ethernity-cloud', 'sdk-js', stack, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'PROJECT_NAME=demo\nVERSION=1\n');
  if (legacy) {
    fs.writeFileSync(path.join(runDir, 'key.pem'), legacy.keyPem);
    fs.writeFileSync(path.join(runDir, 'cert.pem'), legacy.certPem);
  }
  return { dir, runDir, stack, sessionFile: path.join(runDir, 'etny-securelock-test.yaml') };
}

const readEnv = (p) => dotenv.parse(fs.readFileSync(path.join(p.dir, '.env')));

// run.js's writeEnv on the project's .env.
function writeEnv(p, key, value) {
  const file = path.join(p.dir, '.env');
  const content = fs.readFileSync(file, 'utf8');
  const line = new RegExp(`^${key}=.*`, 'm');
  fs.writeFileSync(file, line.test(content) ? content.replace(line, `${key}=${value}`) : `${content}\n${key}=${value}`);
}

function removeEnv(p, key) {
  const file = path.join(p.dir, '.env');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter((line) => !line.startsWith(`${key}=`)).join('\n'));
}

// The session run.js renders from the package's template for a mainnet.
function render(p, predecessor) {
  const attestation = casConfig.sessionAttestation('Bloxberg_Mainnet');
  const content = fs.readFileSync(path.join(ROOT, p.stack, 'run', 'etny-securelock-test.yaml.tpl'), 'utf8')
    .replace(/__PREDECESSOR__/g, predecessor ? `predecessor: ${predecessor}` : '# predecessor: EMPTY')
    .replace(/__MRENCLAVE__/g, MRENCLAVE)
    .replace(/__ENCLAVE_NAME__/g, SESSION_NAME)
    .replace(/__NODE_FLAGS__/g, '')
    .replace(/__ESR_ENVIRONMENT__/g, '# ESR not enabled')
    .replace(/__TOLERATE__/g, attestation.tolerate)
    .replace(/__IGNORE_ADVISORIES__/g, attestation.ignoreAdvisories);
  assert.doesNotMatch(content, /__[A-Z_]+__/);
  fs.writeFileSync(p.sessionFile, content);
  return content;
}

// One publish's CAS step: what was rendered, the request the stand-in
// recorded, the answer of the upload or its error (with the error's message
// as `refusal`), and the lines it logged.
async function publish(p, cas) {
  assert.match(cas.url, /^https:\/\/127\.0\.0\.1:\d+\/session$/);
  const env = readEnv(p);
  const rendered = render(p, env.PREDECESSOR_HASH_SECURELOCK);
  const lines = [];
  const requests = cas.requests.length;
  const result = { rendered, lines, response: null, error: null, refusal: null };
  try {
    result.response = await scontainSession.upload({
      url: cas.url,
      sessionFile: p.sessionFile,
      predecessor: Boolean(env.PREDECESSOR_HASH_SECURELOCK),
      legacyDir: p.runDir,
      recorded: env[RECORD],
      walletKey: WALLET_KEY,
      organization: SESSION_NAME,
      writeRecord: (value) => writeEnv(p, RECORD, value),
      log: (line) => lines.push(line),
    });
    if (result.response.data.hash) writeEnv(p, 'PREDECESSOR_HASH_SECURELOCK', result.response.data.hash);
  } catch (error) {
    result.error = error;
    result.refusal = error.message;
  }
  assert.equal(cas.requests.length, requests + 1, 'one request to the CAS');
  result.request = cas.requests[requests];
  return result;
}

// The outcome of `run` with the clock `days` ahead: Date reads that much
// later while it runs.
async function daysAhead(days, run) {
  const RealDate = Date;
  const shift = days * 86400000;
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now() + shift]));
    }

    static now() {
      return RealDate.now() + shift;
    }
  };
  try {
    return await run();
  } finally {
    global.Date = RealDate;
  }
}

// Every file under `dir`, by its path from it, with the SHA-256 of its bytes.
function snapshot(dir, prefix = '') {
  const files = {};
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, snapshot(dir, rel));
    else files[rel] = sha256(fs.readFileSync(path.join(dir, rel)));
  }
  return files;
}

// The files of the project that a publish created or changed since `before`,
// none removed; and no file of it but a key.pem that was there before holds a
// private key.
function written(p, before) {
  const after = snapshot(p.dir);
  for (const name of Object.keys(before)) assert.ok(name in after, `${name} was removed`);
  for (const name of Object.keys(after)) {
    if (name.endsWith('/key.pem') && before[name] === after[name]) continue;
    assert.ok(!fs.readFileSync(path.join(p.dir, name), 'latin1').includes('PRIVATE KEY'), `${name} holds a private key`);
  }
  return Object.keys(after).filter((name) => before[name] !== after[name]).sort();
}

const RUN = 'node_modules/@ethernity-cloud/sdk-js';
const policyOf = (body) => yaml.load(body.toString('utf8')).access_policy;

test('the upload goes to scone-cas.cf:8081/session in a publish', () => {
  assert.equal(scontainSession.SESSION_URL, 'https://scone-cas.cf:8081/session');
  assert.deepEqual([RECORD, HANDOVER, WALLET_RECORD], ['CAS_CLIENT_KEY', 'handover', 'wallet']);
});

test('uploadKey: the project\'s key.pem and cert.pem sign only the update of a session no record covers', () => {
  const { uploadKey } = scontainSession;
  for (const recorded of [undefined, '', 'other', HANDOVER, WALLET_RECORD]) {
    for (const predecessor of [false, true]) {
      for (const legacyFiles of [false, true]) {
        const handOver = predecessor && legacyFiles && recorded !== HANDOVER && recorded !== WALLET_RECORD;
        assert.equal(uploadKey({ predecessor, legacyFiles, recorded }), handOver ? HANDOVER : WALLET_RECORD,
          JSON.stringify({ predecessor, legacyFiles, recorded }));
      }
    }
  }
  assert.equal(uploadKey({ predecessor: true, legacyFiles: true, recorded: undefined }), HANDOVER);
  assert.equal(uploadKey({ predecessor: true, legacyFiles: true, recorded: HANDOVER }), WALLET_RECORD);
  assert.equal(uploadKey({ predecessor: false, legacyFiles: true, recorded: undefined }), WALLET_RECORD);
  assert.equal(uploadKey({ predecessor: true, legacyFiles: false, recorded: undefined }), WALLET_RECORD);
});

test('the stand-in requires a client certificate and holds a session for its uploader\'s key', async (t) => {
  const cas = await startCas();
  t.after(() => cas.close());
  const p = project();
  const body = render(p);
  const refused = await post(cas.url, body);
  assert.equal(refused.status, 401);
  assert.equal(cas.requests[0].key, null);
  const owner = throwawayIdentity('owner');
  const other = throwawayIdentity('other');
  const created = await post(cas.url, body, owner);
  assert.equal(created.status, 201);
  assert.equal(cas.requests[1].key, owner.key);
  const update = render(p, created.data.hash);
  assert.equal((await post(cas.url, update, other)).status, 403);
  assert.equal((await post(cas.url, body, owner)).status, 409);
  assert.equal((await post(cas.url, update, owner)).status, 201);
});

test('a new session is posted under the wallet\'s CAS client key, over TLS 1.2, with a certificate built for the upload', async (t) => {
  const cas = await startCas();
  t.after(() => cas.close());
  const p = project();
  const before = snapshot(p.dir);
  const first = await publish(p, cas);
  assert.equal(first.refusal, null);
  assert.equal(first.response.status, 201);
  const { request } = first;
  assert.equal(request.key, WALLET_CAS_KEY);
  assert.equal(request.protocol, 'TLSv1.2');
  assert.deepEqual([request.method, request.path, request.contentType], ['POST', '/session', 'application/octet-stream']);
  assert.equal(request.body.toString('utf8'), first.rendered);
  assert.equal(policyOf(request.body), undefined);
  assert.equal(yaml.load(request.body.toString('utf8')).predecessor, undefined);

  const certificate = new crypto.X509Certificate(request.certificate);
  assert.equal(certificate.subject, `C=AU\nST=Some-State\nO=${SESSION_NAME}`);
  assert.equal(certificate.issuer, certificate.subject);
  assert.ok(certificate.ca);
  assert.ok(certificate.verify(certificate.publicKey), 'self-signed');
  const now = Date.now();
  const year = 365 * 86400000;
  assert.ok(Math.abs(new Date(certificate.validFrom).getTime() - (now - year)) < 2 * 86400000);
  assert.ok(Math.abs(new Date(certificate.validTo).getTime() - (now + year)) < 2 * 86400000);

  assert.equal(readEnv(p)[RECORD], WALLET_RECORD);
  assert.deepEqual(first.lines, [
    'Deriving the CAS client key of the publishing wallet',
    'The session is uploaded under the CAS client key of the publishing wallet',
  ]);
  assert.deepEqual(written(p, before), ['.env', `${RUN}/nodenithy/run/etny-securelock-test.yaml`]);
  assert.deepEqual(fs.readdirSync(p.runDir), ['etny-securelock-test.yaml']);

  // The update of that session, a day later by the clock: the same key under
  // a certificate built then.
  const second = await daysAhead(1, () => publish(p, cas));
  assert.equal(second.refusal, null);
  assert.equal(second.request.key, WALLET_CAS_KEY);
  assert.equal(yaml.load(second.request.body.toString('utf8')).predecessor, first.response.data.hash);
  assert.equal(policyOf(second.request.body), undefined);
  const later = new crypto.X509Certificate(second.request.certificate);
  assert.ok(new Date(later.validFrom) - new Date(certificate.validFrom) > 20 * 3600000);
  assert.ok(new Date(later.validTo) - new Date(certificate.validTo) > 20 * 3600000);
  assert.equal(readEnv(p)[RECORD], WALLET_RECORD);
  assert.deepEqual(fs.readdirSync(p.runDir), ['etny-securelock-test.yaml']);
});

test('an existing project hands its session over under its old key, then updates it under the wallet\'s key', async (t) => {
  const cas = await startCas();
  t.after(() => cas.close());
  const legacy = throwawayIdentity('an SDK up to 1.9.1');
  const p = project({ legacy });
  // The session as an SDK up to 1.9.1 created it, under the project's key.pem.
  const created = await post(cas.url, render(p), legacy);
  assert.equal(created.status, 201);
  writeEnv(p, 'PREDECESSOR_HASH_SECURELOCK', created.data.hash);
  const before = snapshot(p.dir);

  // The hand-over: the old key posts, the policy names the wallet's key.
  const handOver = await publish(p, cas);
  assert.equal(handOver.refusal, null);
  assert.equal(handOver.response.status, 201);
  assert.equal(handOver.request.key, legacy.key);
  assert.ok(handOver.request.certificate.equals(new crypto.X509Certificate(legacy.certPem).raw));
  const body = handOver.request.body.toString('utf8');
  assert.ok(body.startsWith(`${handOver.rendered}\naccess_policy:\n  read:\n    - |\n      -----BEGIN CERTIFICATE-----\n`));
  assert.ok(!body.includes('\r'));
  const session = yaml.load(body);
  assert.deepEqual(Object.keys(session.access_policy), ['read', 'update']);
  for (const right of ['read', 'update']) {
    assert.equal(session.access_policy[right].length, 1);
    assert.equal(keyOfCertificate(session.access_policy[right][0]), WALLET_CAS_KEY);
  }
  assert.equal(session.access_policy.read[0], session.access_policy.update[0]);
  const { access_policy: policy, ...rest } = session;
  assert.deepEqual(rest, yaml.load(handOver.rendered));
  assert.equal(rest.predecessor, created.data.hash);
  assert.equal(fs.readFileSync(p.sessionFile, 'utf8'), body);
  assert.deepEqual(cas.sessions.get(SESSION_NAME).update, [WALLET_CAS_KEY]);
  assert.deepEqual(cas.sessions.get(SESSION_NAME).read, [WALLET_CAS_KEY]);
  assert.equal(readEnv(p)[RECORD], HANDOVER);
  assert.deepEqual(handOver.lines, [
    'Deriving the CAS client key of the publishing wallet',
    `The session is uploaded under key.pem and cert.pem of ${p.runDir}; its access policy gives its read and update rights to the CAS client key of the publishing wallet`,
    'The session\'s read and update rights now belong to the CAS client key of the publishing wallet: the next publish uploads under it',
  ]);
  assert.deepEqual(written(p, before), ['.env', `${RUN}/nodenithy/run/etny-securelock-test.yaml`]);

  // The next update goes under the wallet's key and says once that the old
  // files are no longer used.
  const unused = `key.pem and cert.pem of ${p.runDir} are no longer used: the session is uploaded under the CAS client key of the publishing wallet`;
  const update = await publish(p, cas);
  assert.equal(update.refusal, null);
  assert.equal(update.response.status, 201);
  assert.equal(update.request.key, WALLET_CAS_KEY);
  assert.equal(update.request.body.toString('utf8'), update.rendered);
  assert.equal(yaml.load(update.rendered).predecessor, handOver.response.data.hash);
  assert.equal(readEnv(p)[RECORD], WALLET_RECORD);
  assert.deepEqual(update.lines, [
    'Deriving the CAS client key of the publishing wallet',
    'The session is uploaded under the CAS client key of the publishing wallet',
    unused,
  ]);

  const later = await publish(p, cas);
  assert.equal(later.refusal, null);
  assert.equal(later.request.key, WALLET_CAS_KEY);
  assert.ok(!later.lines.includes(unused));
  assert.equal(readEnv(p)[RECORD], WALLET_RECORD);

  // The old files are as they were and the run directory holds no other key.
  assert.deepEqual(written(p, before), ['.env', `${RUN}/nodenithy/run/etny-securelock-test.yaml`]);
  assert.deepEqual(fs.readdirSync(p.runDir).sort(), ['cert.pem', 'etny-securelock-test.yaml', 'key.pem']);

  // The old key holds the session no longer: a project without the record
  // posts under it again and the stand-in refuses the update.
  removeEnv(p, RECORD);
  const predecessor = readEnv(p).PREDECESSOR_HASH_SECURELOCK;
  const refused = await publish(p, cas);
  assert.equal(refused.request.key, legacy.key);
  assert.equal(refused.request.status, 403);
  assert.equal(refused.error.response.status, 403);
  assert.equal(readEnv(p)[RECORD], undefined);
  assert.equal(readEnv(p).PREDECESSOR_HASH_SECURELOCK, predecessor);
  assert.deepEqual(written(p, before), ['.env', `${RUN}/nodenithy/run/etny-securelock-test.yaml`]);
  // The error of the refusal holds nothing of the old key either.
  const whole = util.inspect(refused.error, { depth: Infinity, maxStringLength: Infinity, maxArrayLength: Infinity });
  for (const line of legacy.keyPem.split('\n').filter((l) => l && !l.startsWith('-----'))) assert.ok(!whole.includes(line));
});

test('a project with a predecessor and no key files posts the update under the wallet\'s key, whoever holds the session', async (t) => {
  const cas = await startCas();
  t.after(() => cas.close());

  // The session is the wallet's: the update is accepted.
  const own = project();
  assert.equal((await publish(own, cas)).refusal, null);
  removeEnv(own, RECORD);
  const update = await publish(own, cas);
  assert.equal(update.refusal, null);
  assert.equal(update.request.key, WALLET_CAS_KEY);
  assert.equal(update.request.body.toString('utf8'), update.rendered);
  assert.notEqual(yaml.load(update.rendered).predecessor, undefined);
  assert.equal(readEnv(own)[RECORD], WALLET_RECORD);
  assert.deepEqual(update.lines, [
    'Deriving the CAS client key of the publishing wallet',
    'The session is uploaded under the CAS client key of the publishing wallet',
  ]);

  // The session is held by a key the project has lost: the CAS refuses.
  cas.sessions.clear();
  const lost = project();
  const created = await post(cas.url, render(lost), throwawayIdentity('a lost key'));
  writeEnv(lost, 'PREDECESSOR_HASH_SECURELOCK', created.data.hash);
  const before = snapshot(lost.dir);
  const refused = await publish(lost, cas);
  assert.equal(refused.request.key, WALLET_CAS_KEY);
  assert.equal(refused.request.body.toString('utf8'), refused.rendered);
  assert.equal(refused.request.status, 403);
  assert.equal(refused.error.response.status, 403);
  assert.equal(readEnv(lost)[RECORD], undefined);
  assert.deepEqual(written(lost, before), [`${RUN}/nodenithy/run/etny-securelock-test.yaml`]);
  assert.deepEqual(fs.readdirSync(lost.runDir), ['etny-securelock-test.yaml']);

  // What run.js prints of the refusal (console.log of the error), and the
  // error inspected to any depth, hold nothing of the client key in either
  // of its PEM forms.
  const printed = util.format('Scone CAS error: ', refused.error);
  assert.match(printed, /Request failed with status code 403/);
  const whole = util.inspect(refused.error, { depth: Infinity, maxStringLength: Infinity, maxArrayLength: Infinity });
  assert.ok(whole.length > printed.length);
  const key = casClientKey(WALLET_KEY);
  for (const type of ['pkcs8', 'pkcs1']) {
    const keyLines = key.export({ type, format: 'pem' }).split('\n').filter((line) => line && !line.startsWith('-----'));
    assert.ok(keyLines.length > 40);
    for (const dump of [printed, whole]) {
      assert.ok(!dump.includes('PRIVATE KEY'));
      for (const line of keyLines) assert.ok(!dump.includes(line));
    }
  }
});

test('a new session of a project that holds key.pem and cert.pem goes under the wallet\'s key and leaves the files', async (t) => {
  const cas = await startCas();
  t.after(() => cas.close());
  const legacy = throwawayIdentity('an SDK up to 1.9.1');
  const p = project({ stack: 'pynithy', legacy });
  const before = snapshot(p.dir);
  const unused = `key.pem and cert.pem of ${p.runDir} are no longer used: the session is uploaded under the CAS client key of the publishing wallet`;

  const created = await publish(p, cas);
  assert.equal(created.refusal, null);
  assert.equal(created.request.key, WALLET_CAS_KEY);
  assert.equal(created.request.body.toString('utf8'), created.rendered);
  assert.equal(readEnv(p)[RECORD], WALLET_RECORD);
  assert.deepEqual(created.lines, [
    'Deriving the CAS client key of the publishing wallet',
    'The session is uploaded under the CAS client key of the publishing wallet',
    unused,
  ]);

  // Its update: the record keeps the files out, and the line is not repeated.
  const update = await publish(p, cas);
  assert.equal(update.refusal, null);
  assert.equal(update.request.key, WALLET_CAS_KEY);
  assert.equal(policyOf(update.request.body), undefined);
  assert.ok(!update.lines.includes(unused));
  assert.deepEqual(written(p, before), ['.env', `${RUN}/pynithy/run/etny-securelock-test.yaml`]);
});

test('an answer without the session\'s hash records no key', async (t) => {
  const cas = await startCas();
  t.after(() => cas.close());
  cas.omitHash = true;
  const legacy = throwawayIdentity('an SDK up to 1.9.1');
  const p = project({ legacy });
  writeEnv(p, 'PREDECESSOR_HASH_SECURELOCK', 'cd'.repeat(32));
  cas.sessions.set(SESSION_NAME, { hash: 'cd'.repeat(32), creator: legacy.key, read: [legacy.key], update: [legacy.key] });
  const handOver = await publish(p, cas);
  assert.equal(handOver.refusal, null);
  assert.equal(handOver.response.status, 201);
  assert.equal(handOver.request.key, legacy.key);
  assert.equal(readEnv(p)[RECORD], undefined);
  assert.equal(handOver.lines.length, 2);

  const fresh = project();
  cas.sessions.clear();
  const created = await publish(fresh, cas);
  assert.equal(created.response.status, 201);
  assert.equal(created.request.key, WALLET_CAS_KEY);
  assert.equal(readEnv(fresh)[RECORD], undefined);
});

test('the access policy is two YAML lists of one certificate each, after either template', () => {
  const { certPem, key } = throwawayIdentity('named');
  const policy = scontainSession.accessPolicy(certPem);
  assert.ok(!policy.includes('\r'));
  assert.ok(policy.endsWith('-----END CERTIFICATE-----\n'));
  for (const stack of ['nodenithy', 'pynithy']) {
    const session = yaml.load(`${render(project({ stack }))}\n${policy}`);
    assert.equal(session.name, SESSION_NAME);
    assert.deepEqual(Object.keys(session.access_policy), ['read', 'update']);
    for (const right of ['read', 'update']) {
      assert.deepEqual(session.access_policy[right].map(keyOfCertificate), [key]);
      assert.equal(session.access_policy[right][0].replace(/\n/g, ''), certPem.replace(/\r?\n/g, ''));
    }
  }
});

// Every node of the tree under `node`.
function* nodes(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* nodes(child);
    return;
  }
  if (!node || typeof node.type !== 'string') return;
  yield node;
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') yield* nodes(value);
  }
}

const parsed = (file) => {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return { source, tree: Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'script' }) };
};
const text = ({ source }, node) => source.slice(node.start, node.end);
const isCall = (node, object, method) => node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
  && node.callee.object.name === object && node.callee.property.name === method;
// The strings of a tree: its string literals and the text of its template
// literals.
const strings = (tree) => [...nodes(tree)].flatMap((node) => {
  if (node.type === 'Literal' && typeof node.value === 'string') return [node.value];
  return node.type === 'TemplateElement' ? [node.value.cooked] : [];
});

for (const stack of ['nodenithy', 'pynithy']) {
  test(`${stack}/run.js posts the session through scontainSession.upload with the project's settings and makes no key of its own`, () => {
    const file = parsed(`${stack}/run.js`);
    const uploads = [...nodes(file.tree)].filter((node) => isCall(node, 'scontainSession', 'upload'));
    assert.equal(uploads.length, 1);
    const [call] = uploads;
    assert.equal(call.arguments.length, 1);
    assert.deepEqual(call.arguments[0].properties.map((property) => [property.key.name, text(file, property.value)]), [
      ['url', 'scontainSession.SESSION_URL'],
      ['sessionFile', '\'etny-securelock-test.yaml\''],
      ['predecessor', 'PREDECESSOR_HASH_SECURELOCK !== \'EMPTY\''],
      ['legacyDir', 'runDir'],
      ['recorded', 'process.env[scontainSession.RECORD]'],
      ['walletKey', 'process.env.PRIVATE_KEY'],
      ['organization', 'process.env.ENCLAVE_NAME_SECURELOCK || \'Internet Widgits Pty Ltd\''],
      ['writeRecord', '(value) => writeEnv(scontainSession.RECORD, value)'],
      ['log', '(line) => console.log(`# ${line}`)'],
    ]);
    // The answer goes to the handlers that store the predecessor, as before.
    assert.match(file.source.slice(call.end), /^\s*\.then\(response => \{\s*fs\.writeFileSync\('predecessor\.json'/);
    // The session file is the one run.js renders, in the run directory it
    // works from.
    assert.ok(file.source.includes('processYamlTemplate(\'etny-securelock-test.yaml.tpl\', \'etny-securelock-test.yaml\', replacementsSecurelock)'));
    assert.match(file.source, new RegExp(`const runDir = \`\\$\\{currentDir\\}/node_modules/@ethernity-cloud/sdk-js/${stack}/run\`;\\s*process\\.chdir\\(runDir\\);`));

    const required = [...nodes(file.tree)].filter((node) => node.type === 'CallExpression' && node.callee.name === 'require')
      .map((node) => node.arguments[0].value);
    assert.ok(required.includes('../cas/scontain_session.js'));
    for (const name of ['node-forge', 'axios', 'https', 'crypto']) assert.ok(!required.includes(name), name);
    for (const value of strings(file.tree)) {
      assert.ok(!value.includes('.pem'), value);
      assert.ok(!value.includes('scone-cas.cf:8081'), value);
    }
    const names = [...nodes(file.tree)].filter((node) => node.type === 'Identifier').map((node) => node.name);
    for (const name of ['generateKeyPair', 'generateKeyPairSync', 'createCertificate']) assert.ok(!names.includes(name), name);
  });
}

test('cas/scontain_session.js writes the session file and nothing else, and removes nothing', () => {
  const file = parsed('cas/scontain_session.js');
  const fsCalls = [...nodes(file.tree)].filter((node) => node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression' && node.callee.object.name === 'fs');
  assert.deepEqual([...new Set(fsCalls.map((node) => node.callee.property.name))].sort(), ['existsSync', 'readFileSync', 'writeFileSync']);
  const writes = fsCalls.filter((node) => node.callee.property.name === 'writeFileSync');
  assert.equal(writes.length, 1);
  assert.equal(text(file, writes[0].arguments[0]), 'sessionFile');
  const required = [...nodes(file.tree)].filter((node) => node.type === 'CallExpression' && node.callee.name === 'require')
    .map((node) => node.arguments[0].value);
  assert.deepEqual(required, ['fs', 'https', 'path', 'tls', 'axios', 'node-forge', './client_key.js']);
});

test('the uploads of this file left nothing in the temporary directory or in the package', () => {
  assert.deepEqual(fs.readdirSync(TEMP), []);
  assert.deepEqual(listed(), PACKAGE_FILES);
});
