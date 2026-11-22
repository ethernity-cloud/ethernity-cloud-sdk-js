// The store credential of the securelocks this package builds. A securelock
// builds its one store client from the file the node agent mounts at
// /run/ecld/store.json and, where that file gives no credential, from the
// literal pair:
//
//   - nodenithy/build/securelock/src/store_credential.js is one text in the
//     JS enclaves (this securelock and the etny-nodenithy trustedzone), and
//     the Python securelock mirrored under pynithy/build/securelock carries
//     store_credential.py: the length and the SHA-256 of each over LF line
//     endings, and the JS reader's exports;
//   - the read: vectors/store-credential.json and the files a JSON string
//     does not carry, each answered with its credential, its source and one
//     log line, which names the path and holds no key and nothing of the
//     file; an error of the open, the read or the close; the bytes read of a
//     large file; every descriptor closed;
//   - the literal pair is in no other file of either securelock's src/;
//   - the template, its run on stand-ins: one read a run, without an
//     argument, before the client is constructed over the baked host and
//     port with the read's two values, and before any store call;
//   - the client: the securelock's SwiftStreamService gives the two values
//     to its minio client; a run over it holds the file's keys, and the
//     literal pair where the file is absent or malformed; a refused
//     credential is not followed by the other one, and nothing is put;
//   - the build: each binary-fs-build.sh declares /run/ecld as a host path;
//     the last stage of each securelock Dockerfile carries the label
//     cloud.ethernity.securelock.store="file" on the line before its
//     ENTRYPOINT, in the template and with the tokens ecld-build replaces
//     rendered; ecld-build builds, tags and pushes that image as built; no
//     compose ecld-publish renders names /run/ecld, and each names the image
//     ecld-build pushed;
//   - the names: every object the securelock puts over a plain task and a
//     session, each with a state commit, is within the nine patterns the
//     node agent's policy lets a securelock's store user put, and the store
//     client is asked for no removal and no listing.
//
// The tests named "store:" run against a MinIO and are skipped unless
// ECLD_TEST_STORE_ENDPOINT names its host:port. They take the bucket of
// ECLD_TEST_STORE_BUCKET, which holds .env, and, as the reader's path, the
// file of ECLD_TEST_STORE_CREDENTIAL: the store.json of a user the node
// agent made for that bucket and the role of ECLD_TEST_STORE_ROLE, here
// securelock. They run the securelock's SwiftStreamService over the minio
// package of src/package.json, which is no dependency of this package and
// has to be installed where node resolves it from the securelock's src/.
// The objects they put stay in the bucket: the user removes nothing.
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const casConfig = require('../cas/config.js');
const { SRC, settle } = require('./helpers/securelock_app');
const T = require('./helpers/securelock_template');
const { loadStoreCredential, STORE_CREDENTIAL_PATH } = require(path.join(SRC, 'store_credential.js'));

const ROOT = path.join(__dirname, '..');
const PY_SRC = path.join(ROOT, 'pynithy', 'build', 'securelock', 'src');
// A text file of the package, by its path from the root, with LF line
// endings.
const text = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'store-credential.json'), 'utf8'));
const V01 = VECTORS.find((v) => v.id === 'V01');
const V03 = VECTORS.find((v) => v.id === 'V03');
const V12 = VECTORS.find((v) => v.id === 'V12');
const LITERAL = 'swiftstreamadmin';
const LITERAL_PAIR = { accessKey: LITERAL, secretKey: LITERAL, source: 'literal' };
const INTEGRATION_BUCKET = 'etny-bucket-integration';
const CERTIFICATE = '-----BEGIN CERTIFICATE-----\nc3VpdGU=\n-----END CERTIFICATE-----\n';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-store-credential-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// The path of a file of TMP that holds `bytes`.
function fileOf(name, bytes) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, bytes);
  return file;
}

// A new directory of TMP that holds the securelock's certificate as
// cert.pem.
function certificates() {
  const directory = fs.mkdtempSync(path.join(TMP, 'certificate-'));
  fs.writeFileSync(path.join(directory, 'cert.pem'), CERTIFICATE);
  return directory;
}

// The reader's answer for `file` and the arguments of every call of its log.
function read(file) {
  const logged = [];
  const credential = loadStoreCredential({ path: file, log: (...args) => { logged.push(args); } });
  return { credential, logged };
}

// fn()'s value, the descriptors fs.openSync answered meanwhile that
// fs.closeSync was not given, and the bytes fs.readSync answered.
function tracked(fn) {
  const { openSync, closeSync, readSync } = fs;
  const open = new Set();
  let bytes = 0;
  fs.openSync = (...args) => { const fd = openSync(...args); open.add(fd); return fd; };
  fs.closeSync = (fd) => { open.delete(fd); return closeSync(fd); };
  fs.readSync = (...args) => { const count = readSync(...args); bytes += count; return count; };
  try {
    return { value: fn(), open: [...open], bytes };
  } finally {
    Object.assign(fs, { openSync, closeSync, readSync });
  }
}

// The read of `file` answers `expected` with the one log line of its source
// and closes the file; the line and the bytes it read.
function assertRead(file, expected, what) {
  const { value: { credential, logged }, open, bytes } = tracked(() => read(file));
  const line = expected.source === 'file'
    ? `store credential: file (${file})`
    : `store credential: literal (${file}: ${expected.reason})`;
  assert.deepEqual(credential, expected.source === 'file'
    ? { accessKey: expected.accessKey, secretKey: expected.secretKey, source: 'file' }
    : LITERAL_PAIR, what);
  assert.deepEqual(logged, [[line]], what);
  assert.deepEqual(open, [], `${what}: the file is closed`);
  return { line, bytes };
}

test('store_credential.js: 2444 bytes and its SHA-256 over LF line endings; it exports loadStoreCredential and STORE_CREDENTIAL_PATH, /run/ecld/store.json', () => {
  const bytes = Buffer.from(fs.readFileSync(path.join(SRC, 'store_credential.js')).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  assert.equal(bytes.length, 2444);
  assert.equal(sha256(bytes), 'ab41bf9786ef6b32352fec64ca3b5463ee2a1cca28957e3866b6efe973c08f6c');
  assert.deepEqual(Object.keys(require(path.join(SRC, 'store_credential.js'))), ['loadStoreCredential', 'STORE_CREDENTIAL_PATH']);
  assert.equal(STORE_CREDENTIAL_PATH, '/run/ecld/store.json');
});

test('the mirror of the Python securelock carries store_credential.py: 1905 bytes and its SHA-256 over LF line endings', () => {
  const bytes = Buffer.from(fs.readFileSync(path.join(PY_SRC, 'store_credential.py')).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  assert.equal(bytes.length, 1905);
  assert.equal(sha256(bytes), '471fad84c57cded9db21e14aab7f3edabbc69ad5a269c53351916b9ce7974089');
});

test('the vectors V01 to V26: a file of the two members in their order gives its credential, every other file the literal pair as malformed; the one log line names the path and holds no key and nothing of the file', () => {
  assert.deepEqual(VECTORS.map((v) => v.id), Array.from({ length: 26 }, (_, i) => `V${String(i + 1).padStart(2, '0')}`));
  for (const v of VECTORS) {
    const file = fileOf(`${v.id}.json`, Buffer.from(v.content, 'utf8'));
    const { line } = assertRead(file, v, v.id);
    const besidePath = line.split(file).join('');
    for (const held of [v.accessKey, v.secretKey, LITERAL, v.content].filter(Boolean)) {
      assert.ok(!besidePath.includes(held), `${v.id}: the log line holds no key and nothing of the file`);
    }
  }
});

test('the files a JSON string does not carry: bytes that are no UTF-8, a UTF-8 BOM, UTF-16LE, 4096 and 4097 bytes, 8 MiB, a directory, nothing, a path under a regular file', () => {
  const v03 = Buffer.from(V03.content, 'utf8');
  const padded = (length) => Buffer.concat([v03, Buffer.alloc(length - v03.length, 0x20)]);
  const file = { source: 'file', accessKey: 'abc', secretKey: '12345678' };
  const literal = (reason) => ({ source: 'literal', reason });

  assertRead(fileOf('B01', Buffer.from([0xff, 0xfe, 0x7b, 0x7d])), literal('malformed'), 'B01');
  assert.equal(assertRead(fileOf('B02', padded(4096)), file, 'B02').bytes, 4096);
  assert.equal(assertRead(fileOf('B03', padded(4097)), literal('too large'), 'B03').bytes, 4097);
  const directory = path.join(TMP, 'B04');
  fs.mkdirSync(directory);
  assertRead(directory, literal('unreadable'), 'B04');
  assertRead(path.join(TMP, 'B05'), literal('absent'), 'B05');
  assertRead(path.join(fileOf('B06', v03), 'store.json'), literal('absent'), 'B06');
  assertRead(fileOf('B07', Buffer.from(V03.content, 'utf16le')), literal('malformed'), 'B07');
  assert.equal(assertRead(fileOf('B08', Buffer.alloc(8 * 1024 * 1024, 0x20)), literal('too large'), 'B08').bytes, 4097);
  assertRead(fileOf('B09', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), v03])), literal('malformed'), 'B09');
});

test('an error of the open, the read or the close: ENOENT and ENOTDIR are absent, every other one unreadable; the reader does not throw, the error\'s message is not logged and the file is closed', () => {
  const file = fileOf('errors.json', V01.content);
  for (const [method, code, reason] of [
    ['openSync', 'ENOENT', 'absent'],
    ['openSync', 'ENOTDIR', 'absent'],
    ['openSync', 'EACCES', 'unreadable'],
    ['openSync', 'EISDIR', 'unreadable'],
    ['openSync', null, 'unreadable'],
    ['readSync', 'EIO', 'unreadable'],
    ['closeSync', 'EIO', 'unreadable'],
  ]) {
    const real = fs[method];
    // closeSync closes the descriptor before it throws.
    fs[method] = (...args) => {
      if (method === 'closeSync') real(...args);
      throw Object.assign(new Error('zq9ERRORsecret'), code === null ? {} : { code });
    };
    try {
      assertRead(file, { source: 'literal', reason }, `${method} ${code}`);
    } finally {
      fs[method] = real;
    }
  }
});

test('called without an argument, the reader opens /run/ecld/store.json once and logs through console.log; nothing there is the literal pair as absent', () => {
  const { openSync } = fs;
  const { log } = console;
  const opened = [];
  const lines = [];
  fs.openSync = (target) => {
    opened.push(target);
    throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
  };
  console.log = (...args) => { lines.push(args); };
  let credential;
  try {
    credential = loadStoreCredential();
  } finally {
    fs.openSync = openSync;
    console.log = log;
  }
  assert.deepEqual(opened, ['/run/ecld/store.json']);
  assert.deepEqual(credential, LITERAL_PAIR);
  assert.deepEqual(lines, [['store credential: literal (/run/ecld/store.json: absent)']]);
});

// The files under `directory` that hold the literal, by their paths from it
// with forward slashes; node_modules and the Python build leftovers
// (__pycache__, *.pyc) are not read.
function holdingTheLiteral(directory, from = '') {
  return fs.readdirSync(path.join(directory, from), { withFileTypes: true }).flatMap((entry) => {
    const name = from ? `${from}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return ['node_modules', '__pycache__'].includes(entry.name) ? [] : holdingTheLiteral(directory, name);
    if (entry.name.endsWith('.pyc')) return [];
    return fs.readFileSync(path.join(directory, name)).includes(LITERAL) ? [name] : [];
  });
}

test('the literal pair is in store_credential.js and in no other file of the securelock\'s src/, and in store_credential.py alone of the Python securelock\'s', () => {
  assert.deepEqual(holdingTheLiteral(SRC), ['store_credential.js']);
  assert.deepEqual(holdingTheLiteral(PY_SRC), ['store_credential.py']);
});

test('the template reads the credential once a run, without an argument, and constructs its one store client over etny-swift-stream:9000 with the two values, before any store call', async () => {
  const template = fs.readFileSync(T.TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
  const count = (pattern) => (template.match(pattern) || []).length;
  assert.equal(count(/require\('\.\/store_credential'\)/g), 1, 'the module is required once');
  assert.equal(count(/\bloadStoreCredential\(/g), 1, 'one call of the reader');
  assert.equal(count(/\bnew SwiftStreamService\(/g), 1, 'one store client');
  assert.equal(count(/\binitSwiftStreamClient\(\)/g), 2, 'initSwiftStreamClient and its one call, in execute()');
  // The credential is named where it is read and where the client takes it.
  assert.deepEqual(template.split('\n').filter((line) => /\bcredential\b/.test(line)).map((line) => line.trim()), [
    'const credential = loadStoreCredential();',
    'credential.accessKey,',
    'credential.secretKey);',
  ]);

  const events = [];
  const credential = { accessKey: 'zq9ACCESSkey', secretKey: 'zq9SECRETkey0123', source: 'file' };
  const refused = () => Object.assign(new Error('Access Denied.'), { code: 'AccessDenied' });
  class Service {
    constructor(...args) { events.push(['client', ...args]); }

    async getFileContent(bucket, name) { events.push(['get', bucket, name]); throw refused(); }

    async putFileContent(bucket, name) { events.push(['put', bucket, name]); throw refused(); }

    async isObjectInBucket(bucket, name) { events.push(['stat', bucket, name]); throw refused(); }
  }
  const L = T.loadTemplate({ modules: {
    './store_credential': { loadStoreCredential: (...args) => { events.push(['read', ...args]); return credential; } },
    './swift_stream_service': Service,
  } });
  T.certificateIn(L, certificates());
  assert.deepEqual(events, [], 'the template reads no credential and constructs no client as it loads');
  await T.written(() => L.execute());
  assert.deepEqual(events, [
    ['read'],
    ['client', 'etny-swift-stream', 9000, credential.accessKey, credential.secretKey],
    ['get', T.BUCKET, '.env'],
    ['put', T.BUCKET, 'cert.pem'],
  ]);
});

test('SwiftStreamService constructs its minio client over the endpoint and the port with the access key and the secret key it is given', () => {
  const minio = new T.MinioStandIn();
  const Service = T.storeService(minio);
  const service = new Service('etny-swift-stream', 9000, 'zq9ACCESSkey', 'zq9SECRETkey0123');
  assert.equal(minio.clients.length, 1);
  const { transportAgent, ...options } = minio.clients[0];
  assert.deepEqual(options, { endPoint: 'etny-swift-stream', port: 9000, accessKey: 'zq9ACCESSkey', secretKey: 'zq9SECRETkey0123', useSSL: false });
  assert.ok(transportAgent instanceof http.Agent);
  // The class holds the client and neither key beside it.
  assert.deepEqual(Object.keys(service), ['client']);
});

// The template's run over the securelock's own SwiftStreamService and
// `minio`, with `file` opened at STORE_CREDENTIAL_PATH: the lines logged and
// the number of the reader's opens. The store holds no .env, so the run
// saves the securelock's certificate and ends.
async function run(minio, file) {
  const L = T.loadTemplate({ modules: { './swift_stream_service': T.storeService(minio) } });
  T.certificateIn(L, certificates());
  const { value, opens } = await T.withCredentialFile(file, () => T.written(() => L.execute()));
  return { lines: value.lines, opens };
}

const credentialLines = (lines) => lines.filter((line) => line.startsWith('store credential'));
const keysOf = (minio) => minio.clients.map((options) => [options.endPoint, options.port, options.accessKey, options.secretKey]);
const CERTIFICATE_RUN = [['getObject', T.BUCKET, '.env'], ['bucketExists', T.BUCKET], ['putObject', T.BUCKET, 'cert.pem']];

test('a run constructs one store client, with the keys of the file at /run/ecld/store.json and not the literal pair', async () => {
  const minio = new T.MinioStandIn();
  const { lines, opens } = await run(minio, fileOf('mounted.json', V01.content));
  assert.equal(opens, 1, 'the file is opened once');
  assert.deepEqual(credentialLines(lines), ['store credential: file (/run/ecld/store.json)']);
  assert.deepEqual(keysOf(minio), [['etny-swift-stream', 9000, V01.accessKey, V01.secretKey]]);
  assert.deepEqual(minio.calls, CERTIFICATE_RUN);
  assert.equal(minio.objects.get(`${T.BUCKET}/cert.pem`).toString('utf8'), CERTIFICATE);
  // The reader's line is written before the client is constructed.
  assert.ok(lines.indexOf('store credential: file (/run/ecld/store.json)') < lines.indexOf('SwiftStream Service started.'));
});

test('the fallback: with nothing at /run/ecld/store.json, and with a file that names a bucket, the store client holds the literal pair and is asked the baked bucket', async () => {
  for (const [file, reason] of [
    [path.join(TMP, 'no-mount', 'store.json'), 'absent'],
    [fileOf('with-bucket.json', V12.content), 'malformed'],
  ]) {
    const minio = new T.MinioStandIn();
    const { lines, opens } = await run(minio, file);
    assert.equal(opens, 1, reason);
    assert.deepEqual(credentialLines(lines), [`store credential: literal (/run/ecld/store.json: ${reason})`]);
    assert.deepEqual(keysOf(minio), [['etny-swift-stream', 9000, LITERAL, LITERAL]], reason);
    assert.deepEqual(minio.calls, CERTIFICATE_RUN, reason);
  }
});

test('a store that refuses the file\'s credential: the file is not read again, no client is constructed with the literal pair and nothing is put', async () => {
  const minio = new T.MinioStandIn();
  minio.refuse = true;
  const { lines, opens } = await run(minio, fileOf('refused.json', V01.content));
  assert.equal(opens, 1);
  assert.deepEqual(credentialLines(lines), ['store credential: file (/run/ecld/store.json)']);
  assert.ok(lines.includes('Failed reading .env file.'));
  assert.deepEqual(keysOf(minio), [['etny-swift-stream', 9000, V01.accessKey, V01.secretKey]]);
  assert.deepEqual(minio.calls, CERTIFICATE_RUN.slice(0, 2));
  assert.deepEqual(minio.puts(), []);
  assert.equal(minio.objects.size, 0);
});

// The lines of a binary-fs-build.sh from its EXEC=( line to the line that
// closes the list.
function execList(file) {
  const lines = text(file).split('\n');
  const first = lines.findIndex((line) => line.startsWith('EXEC=('));
  const last = lines.findIndex((line, i) => i >= first && line.endsWith(')'));
  return lines.slice(first, last + 1);
}

test('each binary-fs-build.sh declares /run/ecld, the directory of STORE_CREDENTIAL_PATH, as a host path between /etc/resolv.conf and /etc/hosts, which ends the EXEC list', () => {
  assert.equal(path.posix.dirname(STORE_CREDENTIAL_PATH), '/run/ecld');
  assert.deepEqual(execList('nodenithy/build/securelock/scripts/binary-fs-build.sh'), [
    'EXEC=(scone binaryfs / /binary-fs-dir -v \\',
    "  --include '/usr/local/bin/node' \\",
    "  --include '/etny-securelock/*' \\",
    '  --host-path=/etc/resolv.conf \\',
    '  --host-path=/run/ecld \\',
    '  --host-path=/etc/hosts)',
  ]);
  for (const file of ['nodenithy/build/securelock/scripts/binary-fs-build.sh', 'pynithy/build/securelock/scripts/binary-fs-build.sh']) {
    assert.deepEqual(execList(file).slice(-3), [
      '  --host-path=/etc/resolv.conf \\',
      '  --host-path=/run/ecld \\',
      '  --host-path=/etc/hosts)',
    ], file);
    assert.equal((text(file).match(/--host-path=/g) || []).length, 3, file);
  }
});

const LABEL = 'LABEL cloud.ethernity.securelock.store="file"';
// The securelock Dockerfile template of each kind of dApp, the build script
// that renders it, and the ENTRYPOINT of its last stage as that script
// renders it for a jitless node.
const BUILDS = [
  {
    kind: 'nodenithy',
    template: 'nodenithy/build/securelock/Dockerfile.tmpl',
    name: 'Dockerfile.tmpl',
    entrypoint: 'ENTRYPOINT ["/usr/local/bin/node", "--jitless", "/etny-securelock/securelock.js"]',
  },
  {
    kind: 'pynithy',
    template: 'pynithy/build/securelock/Dockerfile.tpl',
    name: 'Dockerfile.tpl',
    entrypoint: 'ENTRYPOINT ["/usr/local/bin/python", "/etny-securelock/securelock.py"]',
  },
];

// The last stage of the Dockerfile `content` holds the securelock's label on
// the line before its one ENTRYPOINT, the file's last instruction; the file
// holds no other LABEL, no key of a trustedzone image and no USER
// instruction (the credential file is readable by uid 0 alone).
function assertLabelled(content, entrypoint, what) {
  const lines = content.replace(/\n+$/, '').split('\n');
  const stage = lines.slice(lines.reduce((last, line, i) => (/^FROM\s/.test(line) ? i : last), -1));
  assert.match(stage[0], /^FROM\s/, `${what}: a last stage`);
  assert.deepEqual(stage.filter((line) => /^ENTRYPOINT\s/.test(line)), [entrypoint], what);
  assert.deepEqual(stage.slice(-2), [LABEL, entrypoint], what);
  assert.deepEqual(lines.filter((line) => /^\s*LABEL\b/.test(line)), [LABEL], what);
  assert.ok(!content.includes('cloud.ethernity.store'), what);
  assert.deepEqual(lines.filter((line) => /^\s*USER\b/.test(line)), [], what);
}

// The Dockerfile `build` writes from `template`: the template with each of
// its tokens replaced. Every token is the pattern of a replace of the build
// script; __NODE_FLAGS__ is rendered as for a jitless node, every other
// token as a text that holds no instruction.
function renderedDockerfile({ template, kind }) {
  const script = text(`${kind}/build.mjs`);
  let content = text(template);
  const tokens = [...new Set(content.match(/__[A-Z][A-Z0-9_]*__/g))];
  assert.ok(tokens.length > 0);
  for (const token of tokens) {
    assert.match(script, new RegExp(`\\.replace\\((?:/\\^?|')${token}`), `${kind}/build.mjs replaces ${token}`);
    content = content.split(token).join(token === '__NODE_FLAGS__' ? ', "--jitless"' : 'rendered');
  }
  return content;
}

for (const build of BUILDS) {
  test(`${build.kind}: the last stage of ${build.name} carries the label cloud.ethernity.securelock.store="file" on the line before its ENTRYPOINT, in the template and in the Dockerfile ecld-build writes from it`, () => {
    assertLabelled(text(build.template).split('__NODE_FLAGS__').join(', "--jitless"'), build.entrypoint, build.name);
    const rendered = renderedDockerfile(build);
    assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(rendered), 'every token of the template is rendered');
    assertLabelled(rendered, build.entrypoint, `the rendered ${build.name}`);
  });

  test(`${build.kind}: ecld-build writes the Dockerfile from ${build.name}, builds etny-securelock from it and pushes that image, as built, to the tree's registry under the name the composes pull`, () => {
    const script = text(`${build.kind}/build.mjs`);
    assert.ok(script.includes(`fs.readFileSync('${build.name}', 'utf8')`));
    const steps = [
      "fs.writeFileSync('Dockerfile', ",
      /runCommand\(`docker build [^`\n]*-t etny-securelock:latest \.`\);/,
      "runCommand('docker tag etny-securelock localhost:5000/etny-securelock');",
      "runCommand('docker push localhost:5000/etny-securelock');",
      "runCommand('docker cp registry:/var/lib/registry registry');",
    ].map((step) => {
      const found = typeof step === 'string' ? script.indexOf(step) : script.search(step);
      assert.notEqual(found, -1, String(step));
      return found;
    });
    assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'in this order');
    // No docker command of the build or of the publish makes another image
    // of the securelock's layers or sets a label.
    for (const file of [`${build.kind}/build.mjs`, `${build.kind}/run.js`]) {
      assert.ok(!/docker\s+(export|import|commit|save|load)\b|--squash|--label\b/.test(text(file)), file);
    }
  });

  test(`${build.kind}: no compose ecld-publish renders names /run/ecld or gives a service a volume, and each names the securelock image ecld-build pushed`, () => {
    for (const name of ['docker-compose.yml.tmpl', 'docker-compose-final.yml.tmpl']) {
      const template = text(`${build.kind}/run/${name}`);
      for (const [cas, unsafe] of [[true, false], [false, false], [true, true], [false, true]]) {
        const compose = casConfig.renderCompose(template, cas, unsafe);
        const what = `${build.kind}/run/${name} (cas ${cas}, unsafe ${unsafe})`;
        assert.ok(!compose.includes('/run/ecld'), what);
        assert.deepEqual(compose.split('\n').filter((line) => /^\s*volumes\s*:/.test(line)), [], what);
        const lines = compose.split('\n').map((line) => line.trim());
        const service = lines.indexOf('etny-securelock:');
        assert.notEqual(service, -1, what);
        assert.equal(lines.slice(service).find((line) => line.startsWith('image:')), 'image: localhost:5000/etny-securelock', what);
      }
    }
    // The publish renders its composes from these two templates.
    const publish = text(`${build.kind}/run.js`);
    assert.ok(publish.includes("'docker-compose.yml'") && publish.includes("'docker-compose-final.yml'"));
    assert.ok(!publish.includes('/run/ecld'));
  });
}

test('Dockerfile.base.tpl of the Python securelock holds no LABEL', () => {
  assert.deepEqual(text('pynithy/build/securelock/Dockerfile.base.tpl').split('\n').filter((line) => /^\s*LABEL\b/.test(line)), []);
});

// The object names the node agent's policy lets the store user of a
// securelock put (the nine patterns of its P-SL policy): * is any run of
// characters, every other character itself.
const PUT_PATTERNS = [
  'result.*',
  'result_code.*',
  'cert.pem',
  'esr.*',
  'state.*',
  'session.commit.*',
  'session.output.*',
  'session.ready*',
  'securelock.*',
];
const literally = (part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const admitted = (name) => PUT_PATTERNS.some((pattern) => new RegExp(`^${pattern.split('*').map(literally).join('[\\s\\S]*')}$`).test(name));

// The names the JS securelock and the Python securelock put, with a key
// hash, a step and a relay nonce of the test's.
const SECURELOCK_NAMES = [
  'result.txt', 'result.txt.securelock', 'result.txt.sig.securelock', 'result.trustedzone', 'result.trustedzone.sig',
  'result_code.txt.securelock', 'result_code.txt.sig.securelock', 'result_code.trustedzone', 'result_code.trustedzone.sig',
  'cert.pem',
  'esr.authorizations.json', 'esr.commit.0123456789abcdef.0.json',
  'state.counter.enc', 'state.counter.cid', 'state.fence.0123456789abcdef.enc', 'state.fence.0123456789abcdef.cid',
  'session.commit.0.0123456789abcdef.0.json',
  'session.output.0.securelock', 'session.output.0.sig.securelock', 'session.output.0', 'session.output.0.sig',
  'session.ready.securelock', 'session.ready.sig.securelock', 'session.ready', 'session.ready.sig',
  'securelock.heartbeat.securelock', 'securelock.ready.securelock', 'securelock.ready.sig.securelock',
  'securelock.heartbeat', 'securelock.ready', 'securelock.ready.sig',
];
// Names the node agent and the trustedzone write, and a .links name.
const OTHER_NAMES = [
  '.env', 'payload.etny', 'input.txt', 'transaction.txt', 'payload.etny.securelock', 'payload.securelock',
  'input.txt.securelock', 'task.securelock', 'caller.securelock', 'session.config.securelock', 'session.input.0',
  'session.input.0.securelock', 'session.control.securelock', 'session.fence.securelock', 'session.replay.0',
  'session.wallet.proof', 'payload.etny.links', 'x.links',
];

test('the nine patterns admit every name the two securelocks put and none of the names the node agent and the trustedzone write', () => {
  for (const name of SECURELOCK_NAMES) assert.ok(admitted(name), name);
  for (const name of OTHER_NAMES) assert.ok(!admitted(name), name);
  assert.ok(!admitted('result'));
  assert.ok(!admitted('cert.pem.links'));
  assert.ok(admitted('state.a/b\n.enc'), '* is any run of characters');
});

const CALLER = `0x${'11'.repeat(20)}`;
const INCREMENT = '(state) => ({ n: ((state || {}).n || 0) + 1 })';
const TASK_PAYLOAD = `(async () => {
  await ecld.state.commit('counter', ${INCREMENT});
  return ecld.result('done');
})()`;
const SESSION_PAYLOAD = `ecld.onInput = async (data) => {
  await ecld.state.commit('journal', ${INCREMENT});
  return 'reply to ' + data;
};
'context'`;

// An order of the template's securelock over its own SwiftStreamService and
// a recording minio client, with its certificate, the caller the trustedzone
// forwards and an Enclave State Registry: esr_local's contract in the place
// of the chain's.
function recordedOrder(payload) {
  const minio = new T.MinioStandIn();
  const Service = T.storeService(minio);
  const o = T.order({
    payload, input: 'the input', swift: new Service('etny-swift-stream', 9000, V03.accessKey, V03.secretKey), objects: minio.objects,
  });
  o.forward('caller.securelock', CALLER);
  o.process.env.ESR_CONTRACT_ADDRESS = `0x${'5e'.repeat(20)}`;
  const contract = new o.mods.esrLocal.MemContract(null);
  o.mods.ecldState.setContractOverride(contract);
  o.mods.ecldState.setLocalCommitApply((...commit) => contract.applyCommit(...commit));
  const directory = certificates();
  o.app.cert_file = path.join(directory, 'cert.pem');
  o.app.pub_cert_file = path.join(directory, 'enclave_pub_cert.pem');
  return { ...o, minio };
}

// A name with its key hash and its numbers replaced, so that a run's names
// read the same whatever key and step they carry.
const shape = (name) => name.replace(/\.[0-9a-f]{16}\./, '.<key16>.').replace(/\.\d+\./g, '.<n>.');
const shapes = (minio) => [...new Set(minio.puts().map(shape))].sort();

// The store client is asked for no removal and no listing: the calls made
// on it are the four of a store whose bucket exists.
function assertNoRemoval(minio) {
  assert.deepEqual([...new Set(minio.calls.map((call) => call[0]))].sort(), ['bucketExists', 'getObject', 'putObject', 'statObject']);
  for (const call of minio.calls) assert.equal(call[1], T.BUCKET, 'every call is on the baked bucket');
}

async function until(cond, what) {
  for (let i = 0; i < 100000 && !cond(); i += 1) await Promise.resolve();
  assert.ok(cond(), what);
}

test('a plain task with its certificate, its heartbeat and a state commit: every name the securelock puts is within the nine patterns, and it asks for no removal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const o = recordedOrder(TASK_PAYLOAD);
  await T.written(async () => {
    await o.app.savePublicCert();
    await o.app.startProbe();
    assert.equal(await o.app.execute(), true);
    await o.app.saveResult();
    const stopped = o.app.stopProbe();
    for (let i = 0; i < 10; i += 1) {
      await settle();
      t.mock.timers.tick(1000);
    }
    await stopped;
  });
  assert.equal(o.app.task_code, 0);
  assert.equal(JSON.parse(o.app.task_result).data, 'done');
  for (const name of o.minio.puts()) assert.ok(admitted(name), name);
  assert.deepEqual(shapes(o.minio), [
    'cert.pem',
    'esr.authorizations.json',
    'esr.commit.<key16>.<n>.json',
    'result.txt',
    'result.txt.securelock',
    'result.txt.sig.securelock',
    'result_code.txt.securelock',
    'result_code.txt.sig.securelock',
    'securelock.heartbeat.securelock',
    'securelock.ready.securelock',
    'securelock.ready.sig.securelock',
    'state.counter.cid',
    'state.counter.enc',
  ]);
  assertNoRemoval(o.minio);
});

test('a session whose step commits state: every name the securelock puts is within the nine patterns, and it asks for no removal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const o = recordedOrder(SESSION_PAYLOAD);
  o.stage('session.config', JSON.stringify({ order_id: T.ORDER_ID, close_after_seconds: 3600, input_cutoff_seconds: 3000, max_messages: 256 }));
  o.stage('session.input.0', 'the first input');
  await T.written(async () => {
    const executing = o.app.execute();
    await until(() => o.get('session.output.0.securelock') !== undefined, 'output 0 staged');
    o.stage('session.control', 'close');
    t.mock.timers.tick(2000);
    await settle();
    assert.equal(await executing, true);
    await o.app.saveResult();
  });
  assert.equal(o.app.task_code, 0);
  assert.equal(JSON.parse(o.app.task_result).reason, 'CLOSED');
  for (const name of o.minio.puts()) assert.ok(admitted(name), name);
  assert.deepEqual(shapes(o.minio), [
    'esr.authorizations.json',
    'result.txt',
    'result.txt.securelock',
    'result.txt.sig.securelock',
    'result_code.txt.securelock',
    'result_code.txt.sig.securelock',
    'session.commit.<n>.<key16>.<n>.json',
    'session.output.<n>.securelock',
    'session.output.<n>.sig.securelock',
    'session.ready.securelock',
    'session.ready.sig.securelock',
    'state.journal.cid',
    'state.journal.enc',
  ]);
  assertNoRemoval(o.minio);
});

const sourceNames = () => fs.readdirSync(SRC).filter((n) => n.endsWith('.js') || n.endsWith('.tmpl')).sort();
// The lines of a source file of src/ that are no comment.
const code = (name) => fs.readFileSync(path.join(SRC, name), 'utf8').split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

test('the securelock\'s sources: SwiftStreamService calls five methods of its minio client, none a removal or a listing; the put sites are the ones PUT_SITES counts', () => {
  const service = code('swift_stream_service.js');
  assert.deepEqual([...new Set(service.match(/this\.client\.\w+/g))].sort(),
    ['this.client.bucketExists', 'this.client.getObject', 'this.client.makeBucket', 'this.client.putObject', 'this.client.statObject']);
  const Service = T.storeService(new T.MinioStandIn());
  assert.deepEqual(Object.getOwnPropertyNames(Service.prototype).sort(),
    ['constructor', 'createBucket', 'getFileContent', 'getFileContentBytes', 'isObjectInBucket', 'putFileContent']);
  // The calls of putFileContent on a store, by file: a put site more is a
  // name more to hold against the nine patterns.
  const PUT_SITES = { 'ecld_state.js': 6, 'etny_session_exec.js': 1, 'securelock.js.tmpl': 3, 'securelock_probe.js': 1 };
  for (const name of sourceNames()) {
    const source = code(name);
    assert.equal((source.match(/\.putFileContent\(/g) || []).length, PUT_SITES[name] || 0, name);
    // No module reaches the minio client behind the service, and none names
    // a removal or a listing of minio's.
    if (name !== 'swift_stream_service.js') assert.ok(!/\.client\b/.test(source), name);
    assert.ok(!/\b(removeObject|removeObjects|removeBucket|removeIncompleteUpload|listObjects|listObjectsV2|listBuckets|listIncompleteUploads)\b/.test(source), name);
  }
});

const STORE_ENDPOINT = process.env.ECLD_TEST_STORE_ENDPOINT;
const onStore = { skip: STORE_ENDPOINT ? false : 'ECLD_TEST_STORE_ENDPOINT names no MinIO' };

// The securelock's SwiftStreamService on the store of
// ECLD_TEST_STORE_ENDPOINT, constructed with the reader's answer for the
// file of ECLD_TEST_STORE_CREDENTIAL, and the bucket of
// ECLD_TEST_STORE_BUCKET.
function storeUser() {
  const endpoint = /^(.+):([0-9]+)$/.exec(STORE_ENDPOINT);
  assert.ok(endpoint, 'ECLD_TEST_STORE_ENDPOINT is host:port');
  assert.equal(process.env.ECLD_TEST_STORE_ROLE, 'securelock', 'ECLD_TEST_STORE_ROLE is the role of this enclave');
  const bucket = process.env.ECLD_TEST_STORE_BUCKET;
  assert.ok(bucket, 'ECLD_TEST_STORE_BUCKET names the bucket');
  assert.notEqual(bucket, INTEGRATION_BUCKET);
  const credential = loadStoreCredential({ path: process.env.ECLD_TEST_STORE_CREDENTIAL, log: () => {} });
  assert.equal(credential.source, 'file', 'ECLD_TEST_STORE_CREDENTIAL is the path of a credential file');
  let SwiftStreamService;
  try {
    SwiftStreamService = require(path.join(SRC, 'swift_stream_service.js'));
  } catch (e) {
    assert.fail(`the securelock's SwiftStreamService does not load (${e.code}): the minio package of src/package.json has to be installed where node resolves it from ${SRC}`);
  }
  return { service: new SwiftStreamService(endpoint[1], Number(endpoint[2]), credential.accessKey, credential.secretKey), bucket };
}

const denied = (e) => e.code === 'AccessDenied';
const MULTIPART_BYTES = 70 * 1024 * 1024;

test('store: the securelock\'s user finds its bucket and does not make it; an absent object is not found by a presence check and NoSuchKey to a get; .env is read and found', onStore, async () => {
  const { service, bucket } = storeUser();
  assert.equal(await service.createBucket(bucket), `Bucket ${bucket} already exists!`);
  const absent = `result.absent.${crypto.randomBytes(8).toString('hex')}`;
  assert.equal((await service.isObjectInBucket(bucket, absent))[1], false);
  await assert.rejects(service.getFileContent(bucket, absent), (e) => e.code === 'NoSuchKey');
  const unlisted = `ecld-test.${crypto.randomBytes(8).toString('hex')}`;
  assert.equal((await service.isObjectInBucket(bucket, unlisted))[1], false, 'a name outside the nine patterns is absent, not refused');
  await assert.rejects(service.getFileContent(bucket, unlisted), (e) => e.code === 'NoSuchKey');
  assert.equal(typeof (await service.getFileContent(bucket, '.env')), 'string');
  assert.equal((await service.isObjectInBucket(bucket, '.env'))[1], true);
});

test('store: the securelock\'s user puts every name the two securelocks put, and reads and finds each', onStore, async () => {
  const { service, bucket } = storeUser();
  for (const name of SECURELOCK_NAMES) {
    const content = `the content of ${name}`;
    await service.putFileContent(bucket, name, null, content);
    assert.equal(await service.getFileContent(bucket, name), content, name);
    assert.equal((await service.isObjectInBucket(bucket, name))[1], true, name);
  }
});

test('store: the securelock\'s user puts result.txt of 70 MiB, above the one part of the minio client', onStore, async () => {
  const { service, bucket } = storeUser();
  assert.ok(MULTIPART_BYTES > service.client.partSize, 'the object is more than one part');
  await service.putFileContent(bucket, 'result.txt', null, Buffer.alloc(MULTIPART_BYTES, 0x61));
  const [stat, present] = await service.isObjectInBucket(bucket, 'result.txt');
  assert.equal(present, true);
  assert.equal(stat.size, MULTIPART_BYTES);
});

test('store: the securelock\'s user is refused etny-bucket-integration: its presence, a get, a presence check and a put of an object, a remove and a listing each end AccessDenied', onStore, async () => {
  const { service } = storeUser();
  await assert.rejects(service.createBucket(INTEGRATION_BUCKET), denied);
  await assert.rejects(service.getFileContent(INTEGRATION_BUCKET, '.env'), denied);
  await assert.rejects(service.isObjectInBucket(INTEGRATION_BUCKET, '.env'), denied);
  await assert.rejects(service.putFileContent(INTEGRATION_BUCKET, 'result.txt', null, 'the content'), denied);
  await assert.rejects(service.client.removeObject(INTEGRATION_BUCKET, 'result.txt'), denied);
  await assert.rejects(new Promise((resolve, reject) => {
    const listing = service.client.listObjects(INTEGRATION_BUCKET, '', true);
    listing.on('data', () => {});
    listing.on('end', resolve);
    listing.on('error', reject);
  }), denied);
});

test('store: the securelock\'s user removes no object of its bucket and puts none of the names the node agent and the trustedzone write, in one request or in parts', onStore, async () => {
  const { service, bucket } = storeUser();
  await service.putFileContent(bucket, 'securelock.ready', null, 'the content');
  await assert.rejects(service.client.removeObject(bucket, 'securelock.ready'), denied);
  assert.equal((await service.isObjectInBucket(bucket, 'securelock.ready'))[1], true);
  for (const name of OTHER_NAMES) {
    await assert.rejects(service.putFileContent(bucket, name, null, 'the content'), denied, name);
  }
  await assert.rejects(service.putFileContent(bucket, 'payload.etny', null, Buffer.alloc(MULTIPART_BYTES, 0x61)), denied);
  assert.equal((await service.isObjectInBucket(bucket, 'payload.etny.links'))[1], false);
});
