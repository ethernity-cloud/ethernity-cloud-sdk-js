// privateKey.js: ENC_PRIVATE_KEY in the form PrivateKeyManager of
// ethernity-cloud-sdk-py writes and reads, the address of a key, the prompt
// that reads a line without echo, and resolvePrivateKey, the order in which
// ecld-publish and ecld-run find the key, one case per source.
//
// test/vectors/sdk-py-enc-private-key.json holds ENC_PRIVATE_KEY values that
// ethernity-cloud-sdk-py 1.9.0's PrivateKeyManager wrote for the first key of
// Hardhat's public test mnemonic. With ETHERNITY_CLOUD_SDK_PY_PYTHON naming a
// Python interpreter that has ethernity-cloud-sdk-py installed, that
// PrivateKeyManager also decrypts what encryptPrivateKey writes, and
// encrypts a key for decryptPrivateKey; the case is skipped without one.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');

const {
  ITERATIONS, KeyError, PLAINTEXT_NOTICE,
  decryptPrivateKey, encryptPrivateKey, promptHidden, readEnvFile, resolvePrivateKey, walletAddress,
} = require('../privateKey.js');

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'sdk-py-enc-private-key.json'), 'utf8')).vectors;
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BARE = KEY.slice(2);
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PASSWORD = 'dummy-password';
const SDK_PY_ENC = VECTORS[0].encPrivateKey;
const PYTHON_ENV = 'ETHERNITY_CLOUD_SDK_PY_PYTHON';

// The layout of an ENC_PRIVATE_KEY read with node's primitives alone.
function openedByLayout(encrypted, password) {
  const data = Buffer.from(encrypted, 'base64');
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), data.subarray(0, 16), 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, data.subarray(16, 32));
  return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString('utf8');
}

test('the vectors are sdk-py encryptions of the Hardhat test key', () => {
  assert.equal(VECTORS.length, 4);
  for (const vector of VECTORS) {
    assert.ok(vector.privateKey === KEY || vector.privateKey === BARE);
    assert.equal(vector.address, ADDRESS);
  }
  assert.ok(VECTORS.some((vector) => /[^\x00-\x7f]/.test(vector.password)), 'a password beyond ASCII');
  assert.ok(VECTORS.some((vector) => vector.password === ''), 'the empty password');
});

test('decryptPrivateKey gives back the key of every ENC_PRIVATE_KEY sdk-py wrote', () => {
  for (const vector of VECTORS) {
    assert.equal(decryptPrivateKey(vector.encPrivateKey, vector.password), vector.privateKey);
    assert.equal(walletAddress(vector.privateKey), vector.address);
  }
});

test('decryptPrivateKey throws on a wrong password, a changed ciphertext and a value of another form', () => {
  for (const vector of VECTORS) {
    assert.throws(() => decryptPrivateKey(vector.encPrivateKey, `${vector.password}x`),
      { message: 'the password does not decrypt ENC_PRIVATE_KEY' });
  }
  const data = Buffer.from(SDK_PY_ENC, 'base64');
  data[data.length - 1] ^= 0x01;
  assert.throws(() => decryptPrivateKey(data.toString('base64'), PASSWORD),
    { message: 'the password does not decrypt ENC_PRIVATE_KEY' });
  for (const value of ['', 'abc', Buffer.alloc(32).toString('base64'), Buffer.alloc(40).toString('base64')]) {
    assert.throws(() => decryptPrivateKey(value, PASSWORD), { message: 'ENC_PRIVATE_KEY is not an encrypted key' });
  }
});

test('decryptPrivateKey throws on a plaintext that is not UTF-8', () => {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', crypto.pbkdf2Sync(PASSWORD, salt, ITERATIONS, 32, 'sha256'), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from([0xff, 0xfe, 0x41])), cipher.final()]);
  assert.throws(() => decryptPrivateKey(Buffer.concat([salt, iv, ciphertext]).toString('base64'), PASSWORD),
    { message: 'the password does not decrypt ENC_PRIVATE_KEY' });
});

test('encryptPrivateKey writes base64(salt || iv || AES-256-CBC ciphertext) under PBKDF2-HMAC-SHA256, 100000 iterations', () => {
  assert.equal(ITERATIONS, 100000);
  const first = encryptPrivateKey(KEY, PASSWORD);
  const second = encryptPrivateKey(KEY, PASSWORD);
  assert.notEqual(first, second, 'a fresh salt and IV each time');
  assert.equal(Buffer.from(first, 'base64').length, 16 + 16 + 80);
  assert.notDeepEqual(Buffer.from(first, 'base64').subarray(0, 32), Buffer.from(second, 'base64').subarray(0, 32));
  for (const encrypted of [first, second]) {
    assert.equal(openedByLayout(encrypted, PASSWORD), KEY);
    assert.equal(decryptPrivateKey(encrypted, PASSWORD), KEY);
  }
  const password = VECTORS[2].password;
  assert.equal(openedByLayout(encryptPrivateKey(BARE, password), password), BARE);
});

test('sdk-py decrypts what encryptPrivateKey writes, and decryptPrivateKey what sdk-py writes now', (t) => {
  const python = process.env[PYTHON_ENV];
  if (!python || !fs.existsSync(python)) {
    t.skip(`${PYTHON_ENV} names no Python interpreter with ethernity-cloud-sdk-py installed`);
    return;
  }
  // PrivateKeyManager's module reads .config.json of the working directory
  // when it is imported: it runs in an empty directory of its own.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-py-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const code = [
    'import json, sys',
    'from ethernity_cloud_sdk_py.commands.private_key import PrivateKeyManager',
    'out = []',
    'for case in json.loads(sys.stdin.read()):',
    '    pkm = PrivateKeyManager(case["password"])',
    '    out.append({"decrypted": pkm.decrypt_private_key(case["encPrivateKey"]),',
    '                "encrypted": pkm.encrypt_private_key(case["privateKey"]),',
    '                "address": pkm.extract_address_from_private_key(case["privateKey"])})',
    'print("RESULT " + json.dumps(out))',
  ].join('\n');
  const cases = [[KEY, PASSWORD], [BARE, PASSWORD], [KEY, VECTORS[2].password]]
    .map(([privateKey, password]) => ({ privateKey, password, encPrivateKey: encryptPrivateKey(privateKey, password) }));
  const input = JSON.stringify(cases).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const run = spawnSync(python, ['-c', code], {
    cwd: dir, input, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  assert.ok(line, run.stdout);
  const results = JSON.parse(line.slice('RESULT '.length));
  assert.equal(results.length, cases.length);
  results.forEach((result, i) => {
    assert.equal(result.decrypted, cases[i].privateKey);
    assert.equal(decryptPrivateKey(result.encrypted, cases[i].password), cases[i].privateKey);
    assert.equal(result.address, ADDRESS);
  });
});

test('walletAddress is the address of a key with or without 0x and throws, quoting nothing, on anything else', () => {
  assert.equal(walletAddress(KEY), ADDRESS);
  assert.equal(walletAddress(BARE), ADDRESS);
  const order = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
  for (const value of ['', '0x', `${KEY}0`, KEY.slice(0, -1), `0x${'z'.repeat(64)}`, `0x${'0'.repeat(64)}`, `0x${order}`, ` ${KEY}`]) {
    assert.throws(() => walletAddress(value), { message: 'not a secp256k1 private key' });
  }
  assert.ok(walletAddress(`0x${(BigInt(`0x${order}`) - 1n).toString(16)}`).startsWith('0x'));
});

test('readEnvFile reads the variables a .env file sets, and none without the file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  assert.deepEqual(readEnvFile(file), {});
  fs.writeFileSync(file, `PROJECT_NAME=demo\r\nENC_PRIVATE_KEY=${SDK_PY_ENC}\n`);
  assert.deepEqual(readEnvFile(file), { PROJECT_NAME: 'demo', ENC_PRIVATE_KEY: SDK_PY_ENC });
});

// A terminal stand-in: input is a stream with isTTY and setRawMode, output
// keeps what is written to it.
function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.modes = [];
  input.setRawMode = (on) => {
    input.isRaw = on;
    input.modes.push(on);
    return input;
  };
  const written = [];
  const output = { write: (text) => { written.push(String(text)); return true; } };
  return { input, output, written };
}

test('promptHidden reads a line in raw mode, writes only the question and a newline, and restores the terminal', async () => {
  const { input, output, written } = terminal();
  const answer = promptHidden('Password: ', { input, output });
  input.write('sec');
  input.write('ret\r\n');
  assert.equal(await answer, 'secret');
  assert.deepEqual(written, ['Password: ', '\n']);
  assert.deepEqual(input.modes, [true, false]);
  assert.equal(input.listenerCount('data'), 0);
  assert.ok(input.isPaused());
});

test('promptHidden: Backspace as DEL or BS, an escape sequence and control characters', async () => {
  for (const [typed, line] of [
    ['ab\u007fc\r', 'ac'], ['ab\bc\r', 'ac'], ['\u007fa\r', 'a'],
    ['a\u001b[Db\r', 'ab'], ['a\u001b[3~b\r', 'ab'], ['a\u001bOPb\r', 'ab'],
    ['a\tb\u0004\r', 'ab'], ['päss€\n', 'päss€'],
  ]) {
    const { input, output } = terminal();
    const answer = promptHidden('? ', { input, output });
    input.write(typed);
    assert.equal(await answer, line, JSON.stringify(typed));
  }
});

test('promptHidden reads a character whose bytes arrive in two chunks', async () => {
  const { input, output } = terminal();
  const answer = promptHidden('? ', { input, output });
  const euro = Buffer.from('€', 'utf8');
  input.write(euro.subarray(0, 1));
  input.write(Buffer.concat([euro.subarray(1), Buffer.from('\r')]));
  assert.equal(await answer, '€');
});

test('promptHidden rejects with KeyError(130) on Ctrl-C and restores the terminal', async () => {
  const { input, output, written } = terminal();
  const answer = promptHidden('? ', { input, output });
  input.write('ab\u0003');
  await assert.rejects(answer, (e) => e instanceof KeyError && e.exitCode === 130 && e.message === '');
  assert.deepEqual(input.modes, [true, false]);
  assert.deepEqual(written, ['? ', '\n']);
});

// The dependencies resolvePrivateKey is given, answering the questions from
// `answers` (prompt) and `hidden` (promptHidden), and what it did with them.
function harness({ env = {}, file = {}, isTTY = false, answers = [], hidden = [] } = {}) {
  const calls = { questions: [], hiddenQuestions: [], writes: [], lines: [] };
  const deps = {
    env, file, isTTY,
    prompt: async (question) => {
      calls.questions.push(question);
      assert.ok(answers.length, `an unexpected question: ${question}`);
      return answers.shift();
    },
    promptHidden: async (question) => {
      calls.hiddenQuestions.push(question);
      assert.ok(hidden.length, `an unexpected hidden question: ${question}`);
      return hidden.shift();
    },
    writeEnv: (name, value) => calls.writes.push([name, value]),
    log: (line) => calls.lines.push(String(line)),
  };
  return { deps, calls, answers, hidden };
}

// No PRIVATE_KEY is written, and no line printed, question asked, value
// written or error message holds the key.
function assertKeyKept(calls, error) {
  assert.ok(!calls.writes.some(([name]) => name === 'PRIVATE_KEY'), 'PRIVATE_KEY is written');
  const texts = [
    ...calls.lines, ...calls.questions, ...calls.hiddenQuestions,
    ...calls.writes.map(([name, value]) => `${name}=${value}`), error ? error.message : '',
  ];
  for (const text of texts) assert.ok(!text.toLowerCase().includes(BARE), `the key is in ${JSON.stringify(text)}`);
}

async function resolved(command, options) {
  const h = harness(options);
  const key = await resolvePrivateKey(command, h.deps);
  assertKeyKept(h.calls);
  assert.deepEqual(h.answers, [], 'every answer is used');
  assert.deepEqual(h.hidden, [], 'every hidden answer is used');
  return { key, ...h.calls };
}

async function refused(command, options, exitCode, message) {
  const h = harness(options);
  let error = null;
  try {
    await resolvePrivateKey(command, h.deps);
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof KeyError, `a KeyError, not ${error}`);
  assert.equal(error.exitCode, exitCode);
  assert.match(error.message, message);
  assertKeyKept(h.calls, error);
  return { error, ...h.calls };
}

test('publish: ECLD_PRIVATE_KEY without ECLD_KEY_PASSWORD is used and nothing is stored', async () => {
  const r = await resolved('publish', { env: { ECLD_PRIVATE_KEY: ` ${KEY} ` }, file: { PRIVATE_KEY: BARE }, isTTY: true });
  assert.equal(r.key, KEY);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.questions, []);
});

test('publish: ECLD_PRIVATE_KEY with ECLD_KEY_PASSWORD is used and stored as ENC_PRIVATE_KEY and WALLET_ADDRESS', async () => {
  const r = await resolved('publish', {
    env: { ECLD_PRIVATE_KEY: KEY, ECLD_KEY_PASSWORD: PASSWORD, PRIVATE_KEY: BARE },
    file: { ENC_PRIVATE_KEY: VECTORS[2].encPrivateKey },
  });
  assert.equal(r.key, KEY);
  assert.deepEqual(r.writes.map(([name]) => name), ['ENC_PRIVATE_KEY', 'WALLET_ADDRESS']);
  assert.equal(decryptPrivateKey(r.writes[0][1], PASSWORD), KEY);
  assert.equal(r.writes[1][1], ADDRESS);
  assert.deepEqual(r.lines, [`The private key of ${ADDRESS} is stored encrypted in .env (ENC_PRIVATE_KEY).`]);
});

test('publish: an ECLD_PRIVATE_KEY that is no private key exits 2 and stores nothing', async () => {
  const r = await refused('publish', { env: { ECLD_PRIVATE_KEY: `${BARE}00`, ECLD_KEY_PASSWORD: PASSWORD } }, 2,
    /^ECLD_PRIVATE_KEY is not a usable private key\.$/);
  assert.deepEqual(r.writes, []);
});

test('publish: PRIVATE_KEY of the environment is used as given, without the notice', async () => {
  const r = await resolved('publish', {
    env: { PRIVATE_KEY: BARE },
    file: { PRIVATE_KEY: '0x01', ENC_PRIVATE_KEY: SDK_PY_ENC },
    isTTY: true,
  });
  assert.equal(r.key, BARE);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.hiddenQuestions, []);
});

test('publish: PRIVATE_KEY of the .env file is used as given with the plain-text notice and nothing is written', async () => {
  const r = await resolved('publish', { file: { PRIVATE_KEY: KEY, ENC_PRIVATE_KEY: SDK_PY_ENC }, isTTY: true });
  assert.equal(r.key, KEY);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.lines, [PLAINTEXT_NOTICE]);
  assert.match(PLAINTEXT_NOTICE, /plain text/);
  assert.match(PLAINTEXT_NOTICE, /remove that line and publish again to store the key encrypted/);
});

test('publish: ENC_PRIVATE_KEY of sdk-py is decrypted with ECLD_KEY_PASSWORD', async () => {
  const r = await resolved('publish', { env: { ECLD_KEY_PASSWORD: PASSWORD }, file: { ENC_PRIVATE_KEY: SDK_PY_ENC }, isTTY: true });
  assert.equal(r.key, KEY);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.hiddenQuestions, []);
});

test('publish: an ECLD_KEY_PASSWORD that does not decrypt ENC_PRIVATE_KEY exits 2, asking nothing', async () => {
  const r = await refused('publish', { env: { ECLD_KEY_PASSWORD: 'wrong' }, file: { ENC_PRIVATE_KEY: SDK_PY_ENC }, isTTY: true }, 2,
    /^ECLD_KEY_PASSWORD does not decrypt the stored key \(ENC_PRIVATE_KEY in \.env\)\.$/);
  assert.deepEqual(r.hiddenQuestions, []);
});

test('publish: ENC_PRIVATE_KEY on a terminal asks the password again after a wrong one', async () => {
  const r = await resolved('publish', { file: { ENC_PRIVATE_KEY: SDK_PY_ENC }, isTTY: true, hidden: ['wrong', PASSWORD] });
  assert.equal(r.key, KEY);
  assert.deepEqual(r.hiddenQuestions, ['Enter your private key password: ', 'Enter your private key password: ']);
  assert.deepEqual(r.lines, ['Incorrect password. Please try again.']);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.questions, []);
});

test('publish: ENC_PRIVATE_KEY without ECLD_KEY_PASSWORD or a terminal exits 2', async () => {
  const r = await refused('publish', { file: { ENC_PRIVATE_KEY: SDK_PY_ENC } }, 2,
    /^The stored key \(ENC_PRIVATE_KEY in \.env\) is encrypted and there is no terminal to ask for its password: set ECLD_KEY_PASSWORD, or ECLD_PRIVATE_KEY, for an unattended publish\.$/);
  assert.deepEqual(r.hiddenQuestions, []);
});

test('an ENC_PRIVATE_KEY that is not an encrypted key exits 2 without asking for a password', async () => {
  for (const command of ['publish', 'run']) {
    const r = await refused(command, { file: { ENC_PRIVATE_KEY: 'abc' }, isTTY: true }, 2, /^ENC_PRIVATE_KEY in \.env is not an encrypted key\.$/);
    assert.deepEqual(r.hiddenQuestions, []);
  }
});

test('publish: no key on a terminal: the wallet prompts, then a password set twice, stored as ENC_PRIVATE_KEY and WALLET_ADDRESS', async () => {
  const r = await resolved('publish', {
    isTTY: true,
    answers: ['yes', 'not-a-key', ` ${KEY} `],
    hidden: ['', 'first', 'second', 'chosen', 'chosen'],
  });
  assert.equal(r.key, KEY);
  assert.deepEqual(r.questions, [
    'Do you have an existing wallet? (yes/no) (default value: no) ',
    'Enter your private key: ',
    'Invalid private key. Please enter a valid private key: ',
  ]);
  assert.deepEqual(r.hiddenQuestions, [
    'Set a password for your private key: ',
    'Set a password for your private key: ', 'Repeat the password: ',
    'Set a password for your private key: ', 'Repeat the password: ',
  ]);
  assert.deepEqual(r.lines, [
    '', 'Inputted Private key is valid.', 'The password is empty.', 'The passwords differ.',
    `The private key of ${ADDRESS} is stored encrypted in .env (ENC_PRIVATE_KEY).`,
  ]);
  assert.deepEqual(r.writes.map(([name]) => name), ['ENC_PRIVATE_KEY', 'WALLET_ADDRESS']);
  assert.equal(decryptPrivateKey(r.writes[0][1], 'chosen'), KEY);
  assert.equal(r.writes[1][1], ADDRESS);
});

test('publish: no key on a terminal and no wallet exits 1 and stores nothing', async () => {
  const r = await refused('publish', { isTTY: true, answers: [''] }, 1, /^Without a wallet, you will not be able to publish\.\n/);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.hiddenQuestions, []);
});

test('publish: no key and no terminal exits 2 naming ECLD_PRIVATE_KEY and ECLD_KEY_PASSWORD', async () => {
  const r = await refused('publish', {}, 2,
    /^No wallet is configured and there is no terminal to ask for one: set ECLD_PRIVATE_KEY, and ECLD_KEY_PASSWORD to store it encrypted in \.env, for an unattended publish\.$/);
  assert.deepEqual(r.questions, []);
  assert.deepEqual(r.writes, []);
});

test('publish: ECLD_PRIVATE_KEY and ECLD_KEY_PASSWORD are read from the environment only; an empty variable of the environment hides the file\'s', async () => {
  await refused('publish', { file: { ECLD_PRIVATE_KEY: KEY } }, 2, /^No wallet is configured/);
  await refused('publish', { file: { ENC_PRIVATE_KEY: SDK_PY_ENC, ECLD_KEY_PASSWORD: PASSWORD } }, 2, /^The stored key/);
  await refused('publish', { env: { PRIVATE_KEY: '' }, file: { PRIVATE_KEY: KEY } }, 2, /^No wallet is configured/);
});

test('run: PRIVATE_KEY, else ECLD_PRIVATE_KEY, of the environment or the file, without the notice', async () => {
  for (const [options, key] of [
    [{ env: { PRIVATE_KEY: KEY, ECLD_PRIVATE_KEY: '0x01' } }, KEY],
    [{ file: { PRIVATE_KEY: BARE, ECLD_PRIVATE_KEY: '0x01' } }, BARE],
    [{ env: { ECLD_PRIVATE_KEY: KEY }, file: { ENC_PRIVATE_KEY: SDK_PY_ENC } }, KEY],
    [{ file: { ECLD_PRIVATE_KEY: KEY } }, KEY],
  ]) {
    const r = await resolved('run', { ...options, isTTY: true });
    assert.equal(r.key, key);
    assert.deepEqual(r.lines, []);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(r.hiddenQuestions, []);
  }
});

test('run: ENC_PRIVATE_KEY with ECLD_KEY_PASSWORD, on a terminal after a wrong password, and without either', async () => {
  assert.equal((await resolved('run', { env: { ECLD_KEY_PASSWORD: PASSWORD }, file: { ENC_PRIVATE_KEY: SDK_PY_ENC } })).key, KEY);
  const asked = await resolved('run', { file: { ENC_PRIVATE_KEY: SDK_PY_ENC }, isTTY: true, hidden: ['wrong', PASSWORD] });
  assert.equal(asked.key, KEY);
  assert.deepEqual(asked.lines, ['Incorrect password. Please try again.']);
  assert.deepEqual(asked.writes, []);
  await refused('run', { env: { ECLD_KEY_PASSWORD: 'wrong' }, file: { ENC_PRIVATE_KEY: SDK_PY_ENC } }, 2, /^ECLD_KEY_PASSWORD does not decrypt/);
  await refused('run', { file: { ENC_PRIVATE_KEY: SDK_PY_ENC } }, 2, /there is no terminal to ask for its password: set ECLD_KEY_PASSWORD, or ECLD_PRIVATE_KEY, for an unattended run\.$/);
});

test('run: no key exits 1 naming ECLD_PRIVATE_KEY and ECLD_KEY_PASSWORD, and asks nothing on a terminal', async () => {
  const r = await refused('run', { isTTY: true }, 1, /^no signing key\. Set ECLD_PRIVATE_KEY \(a funded 0x key\), /);
  assert.match(r.error.message, /ECLD_KEY_PASSWORD/);
  assert.doesNotMatch(r.error.message, /ecld-publish stores it/);
  assert.deepEqual(r.questions, []);
  assert.deepEqual(r.hiddenQuestions, []);
  assert.deepEqual(r.writes, []);
});

test('resolvePrivateKey refuses a command it does not know', async () => {
  await assert.rejects(resolvePrivateKey('build', harness().deps), { name: 'TypeError', message: 'unknown command build' });
});
