// ecld-publish and the publisher's key: publish.js writes no PRIVATE_KEY to
// .env and hands the key to the runner it starts (nodenithy/run.js or
// pynithy/run.js) in that runner's environment.
//
// The source of publish.js is read with acorn: no writeEnv call names
// PRIVATE_KEY, and each spawn of a run.js passes { ...process.env,
// PRIVATE_KEY: privateKey } as its environment. publish.js is then run in a
// scratch project with stdin not a terminal and test/helpers/
// fake_publish_children.js preloaded, so no child process starts: the
// image_registry.js actions before the runner are answered as for a funded
// key, and the start of the runner is printed with the SHA-256 of the
// PRIVATE_KEY of its environment.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Parser } = require('acorn');

const { PLAINTEXT_NOTICE, decryptPrivateKey } = require('../privateKey.js');

const ROOT = path.join(__dirname, '..');
const PUBLISH = path.join(ROOT, 'publish.js');
const FAKE_CHILDREN = path.join(__dirname, 'helpers', 'fake_publish_children.js');
const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'sdk-py-enc-private-key.json'), 'utf8')).vectors;
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PASSWORD = 'dummy-password';
const SDK_PY_ENC = VECTORS[0].encPrivateKey;
const KEY_DIGEST = crypto.createHash('sha256').update(KEY).digest('hex');
const KEY_VARIABLES = ['PRIVATE_KEY', 'ECLD_PRIVATE_KEY', 'ECLD_KEY_PASSWORD', 'ENC_PRIVATE_KEY', 'WALLET_ADDRESS'];
const PROJECT = 'PROJECT_NAME=demo\nBLOCKCHAIN_NETWORK=Bloxberg_Testnet\nDEVELOPER_FEE=0\nSERVICE_TYPE=Nodenithy\nVERSION=v1\n';

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

const parsed = (file) => Parser.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'script' });
const calls = (tree, name) => [...nodes(tree)].filter((n) => n.type === 'CallExpression'
  && n.callee.type === 'Identifier' && n.callee.name === name);
const property = (object, name) => object.properties.find((p) => p.type === 'Property' && !p.computed
  && (p.key.name === name || p.key.value === name));

test('no writeEnv call of publish.js, run.js or privateKey.js names PRIVATE_KEY; each names its variable literally', () => {
  const named = {};
  for (const file of ['publish.js', 'run.js', 'privateKey.js']) {
    named[file] = calls(parsed(path.join(ROOT, file)), 'writeEnv').map((call) => {
      const [first] = call.arguments;
      assert.ok(first && first.type === 'Literal' && typeof first.value === 'string',
        `${file}: a writeEnv call whose variable is not a string literal`);
      return first.value;
    });
  }
  assert.deepEqual(named, {
    'publish.js': ['DEVELOPER_FEE'],
    'run.js': [],
    'privateKey.js': ['ENC_PRIVATE_KEY', 'WALLET_ADDRESS'],
  });
});

test('publish.js starts nodenithy/run.js and pynithy/run.js with PRIVATE_KEY in their environment', () => {
  const runners = calls(parsed(PUBLISH), 'spawn').filter((call) => call.arguments[1]
    && call.arguments[1].type === 'ArrayExpression'
    && call.arguments[1].elements.some((e) => e.type === 'Literal' && /\/run\.js$/.test(e.value)));
  assert.deepEqual(runners.map((call) => call.arguments[1].elements[0].value), [
    './node_modules/@ethernity-cloud/sdk-js/nodenithy/run.js',
    './node_modules/@ethernity-cloud/sdk-js/pynithy/run.js',
  ]);
  for (const call of runners) {
    const options = call.arguments[2];
    assert.equal(options.type, 'ObjectExpression');
    const env = property(options, 'env');
    assert.ok(env && env.value.type === 'ObjectExpression', 'an env object');
    const [spread, key] = env.value.properties;
    assert.equal(spread.type, 'SpreadElement');
    assert.equal(spread.argument.type, 'MemberExpression');
    assert.equal(spread.argument.object.name, 'process');
    assert.equal(spread.argument.property.name, 'env');
    assert.equal(key.key.name, 'PRIVATE_KEY');
    assert.equal(key.value.name, 'privateKey');
    assert.equal(env.value.properties.length, 2);
    assert.equal(property(options, 'stdio').value.value, 'inherit');
  }
});

// publish.js run in a scratch project whose .env is `envFile`, with `env`
// over an environment without the key variables; its output, its exit
// status and the .env it leaves.
function publish(t, envFile, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-publish-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), envFile);
  const base = { ...process.env };
  for (const name of KEY_VARIABLES) delete base[name];
  const run = spawnSync(process.execPath, ['-r', FAKE_CHILDREN, PUBLISH], {
    cwd: dir, input: '', encoding: 'utf8', env: { ...base, ...env },
  });
  const result = { status: run.status, stdout: run.stdout, stderr: run.stderr, envFile: fs.readFileSync(path.join(dir, '.env'), 'utf8') };
  for (const text of [result.stdout, result.stderr]) {
    assert.ok(!text.includes(KEY.slice(2)), `the key is printed: ${text}`);
  }
  if (!/^PRIVATE_KEY=/m.test(envFile)) assert.doesNotMatch(result.envFile, /^PRIVATE_KEY=/m, 'PRIVATE_KEY is written to .env');
  return result;
}

test('publish.js: PRIVATE_KEY of the environment reaches the runner and .env is left as it was', (t) => {
  const r = publish(t, PROJECT, { PRIVATE_KEY: KEY });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.envFile, PROJECT);
  assert.ok(!r.stdout.includes(PLAINTEXT_NOTICE));
  assert.match(r.stdout, /Using PROJECT_NAME, BLOCKCHAIN_NETWORK, DEVELOPER_FEE from \.env/);
  assert.match(r.stderr, new RegExp(`^execSync checkBalance PRIVATE_KEY ${KEY_DIGEST}$`, 'm'));
  assert.match(r.stderr, new RegExp(`^execSync validateAddress PRIVATE_KEY ${KEY_DIGEST}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^spawn node \\./node_modules/@ethernity-cloud/sdk-js/nodenithy/run\\.js PRIVATE_KEY ${KEY_DIGEST}$`, 'm'));
});

test('publish.js: PRIVATE_KEY of the .env file prints the notice, reaches the runner and is not rewritten', (t) => {
  const envFile = `${PROJECT}PRIVATE_KEY=${KEY}\n`;
  const r = publish(t, envFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.envFile, envFile);
  assert.ok(r.stdout.includes(PLAINTEXT_NOTICE));
  assert.match(r.stdout, new RegExp(`^spawn node \\S+/nodenithy/run\\.js PRIVATE_KEY ${KEY_DIGEST}$`, 'm'));
});

test('publish.js: ECLD_PRIVATE_KEY with ECLD_KEY_PASSWORD stores ENC_PRIVATE_KEY and WALLET_ADDRESS, not PRIVATE_KEY', (t) => {
  const r = publish(t, PROJECT.replace('Nodenithy', 'Pynithy'), { ECLD_PRIVATE_KEY: KEY, ECLD_KEY_PASSWORD: PASSWORD });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const stored = /^ENC_PRIVATE_KEY=(.+)$/m.exec(r.envFile);
  assert.ok(stored, r.envFile);
  assert.equal(decryptPrivateKey(stored[1], PASSWORD), KEY);
  assert.match(r.envFile, new RegExp(`^WALLET_ADDRESS=${ADDRESS}$`, 'm'));
  assert.doesNotMatch(r.envFile, /^PRIVATE_KEY=/m);
  assert.match(r.stdout, new RegExp(`^spawn node \\S+/pynithy/run\\.js PRIVATE_KEY ${KEY_DIGEST}$`, 'm'));
});

test('publish.js: ENC_PRIVATE_KEY of sdk-py is decrypted with ECLD_KEY_PASSWORD and reaches the runner', (t) => {
  const envFile = `${PROJECT}ENC_PRIVATE_KEY=${SDK_PY_ENC}\nWALLET_ADDRESS=${ADDRESS}\n`;
  const r = publish(t, envFile, { ECLD_KEY_PASSWORD: PASSWORD });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.envFile, envFile);
  assert.match(r.stdout, new RegExp(`^spawn node \\S+/nodenithy/run\\.js PRIVATE_KEY ${KEY_DIGEST}$`, 'm'));
});

test('publish.js exits 2 before any registry action without a key, or with a stored key and no password, or a wrong one', (t) => {
  const stored = `${PROJECT}ENC_PRIVATE_KEY=${SDK_PY_ENC}\n`;
  for (const [envFile, env, message] of [
    [PROJECT, {}, /^No wallet is configured and there is no terminal to ask for one: set ECLD_PRIVATE_KEY, /m],
    [stored, {}, /^The stored key \(ENC_PRIVATE_KEY in \.env\) is encrypted and there is no terminal /m],
    [stored, { ECLD_KEY_PASSWORD: 'wrong' }, /^ECLD_KEY_PASSWORD does not decrypt the stored key/m],
    [PROJECT, { ECLD_PRIVATE_KEY: `${KEY}00`, ECLD_KEY_PASSWORD: PASSWORD }, /^ECLD_PRIVATE_KEY is not a usable private key\.$/m],
  ]) {
    const r = publish(t, envFile, env);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, message);
    assert.doesNotMatch(r.stderr, /^execSync/m);
    assert.doesNotMatch(r.stdout, /^spawn/m);
    assert.equal(r.envFile, envFile);
  }
});
