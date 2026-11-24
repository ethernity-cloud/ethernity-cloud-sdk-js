// The CAS client key of a publishing wallet (cas/client_key.js), derived as
// docs/cas-client-key.md specifies.
//
// test/vectors/cas-client-key.json holds test wallets with the public key
// each derives; ethernity-cloud-sdk-py holds the same bytes as
// tests/vectors/cas-client-key.json and derives the same keys, and both
// suites pin the SHA-256 of the file and of the specification. Beside the
// vectors: the seed against RFC 5869 computed here with HMAC, the primes
// against OpenSSL's primality test (crypto.checkPrimeSync), and the three
// tests a prime passes on starts where each one decides.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Parser } = require('acorn');

const clientKey = require('../cas/client_key.js');

const ROOT = path.join(__dirname, '..');
const VECTOR_FILE = path.join(__dirname, 'vectors', 'cas-client-key.json');
const SPECIFICATION = path.join(ROOT, 'docs', 'cas-client-key.md');
// The same two values are pinned in ethernity-cloud-sdk-py
// (tests/test_cas_client_key.py).
const VECTOR_FILE_SHA256 = 'a322c0ded36e3786a1fce86aa9e4c1485fbeddb19a3bbc8c1456c7938c14a7b7';
const SPECIFICATION_SHA256 = '45f25b14dc81b31851805a55bf16f3ab8f4d8c29c0cdc31809c45d42d4b0150f';

const { vectors, scheme } = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8'));
// The wallet whose primes are found soonest.
const QUICK = vectors.find((v) => v.walletPrivateKey === `0x${'ee'.repeat(32)}`);
const E = 65537n;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const bits = (value) => value.toString(2).length;
const spki = (key) => crypto.createPublicKey(clientKey.keyObject(key)).export({ type: 'spki', format: 'der' });
const bytesOf = (walletPrivateKey) => Buffer.from(walletPrivateKey.slice(2), 'hex');

// HKDF-SHA256 as RFC 5869 writes it: extract, then expand.
function hkdf(ikm, salt, info, length) {
  const prk = hmac(salt, ikm);
  const blocks = [];
  let block = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(blocks).length < length; counter++) {
    block = hmac(prk, Buffer.concat([block, info, Buffer.from([counter])]));
    blocks.push(block);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

// c0 of the specification for one half of a seed.
const firstCandidate = (half) => BigInt(`0x${half.toString('hex')}`) | (3n << BigInt(8 * half.length - 2)) | 1n;

// The first of start, start + 2, ... that OpenSSL finds prime and that is not
// 1 modulo 65537.
function firstPrime(start) {
  for (let c = start; ; c += 2n) {
    if (c % E !== 1n && crypto.checkPrimeSync(c)) return c;
  }
}

// The integers each vector's wallet derives, computed once.
const derived = new Map();
function keyOf(vector) {
  if (!derived.has(vector)) derived.set(vector, clientKey.keyFromSeed(clientKey.seed(vector.walletPrivateKey)));
  return derived.get(vector);
}

test('the vector file and the specification are the bytes ethernity-cloud-sdk-py holds', () => {
  for (const [file, pinned] of [[VECTOR_FILE, VECTOR_FILE_SHA256], [SPECIFICATION, SPECIFICATION_SHA256]]) {
    const content = fs.readFileSync(file);
    assert.ok(!content.includes(0x0d), `${file} holds a CR`);
    assert.equal(sha256(content), pinned, `${file} is not the pinned file; the copy in ethernity-cloud-sdk-py changes with it`);
  }
});

test('the vector file holds at least three test wallets, each with its own public key', () => {
  assert.equal(scheme, 'ecld-cas-client-v1');
  assert.ok(vectors.length >= 3);
  for (const v of vectors) {
    assert.match(v.walletPrivateKey, /^0x[0-9a-f]{64}$/);
    assert.equal(sha256(Buffer.from(v.publicKeySpkiDer, 'hex')), v.publicKeySha256);
    const publicKey = crypto.createPublicKey({ key: Buffer.from(v.publicKeySpkiDer, 'hex'), format: 'der', type: 'spki' });
    assert.equal(publicKey.asymmetricKeyType, 'rsa');
    assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 4096);
    assert.equal(publicKey.asymmetricKeyDetails.publicExponent, E);
  }
  assert.equal(new Set(vectors.map((v) => v.walletPrivateKey)).size, vectors.length);
  assert.equal(new Set(vectors.map((v) => v.publicKeySpkiDer)).size, vectors.length);
});

for (const vector of vectors) {
  test(`${vector.walletPrivateKey.slice(0, 10)}: the wallet derives the public key of the vector`, () => {
    const key = keyOf(vector);
    const der = spki(key);
    assert.equal(der.toString('hex'), vector.publicKeySpkiDer);
    assert.equal(sha256(der), vector.publicKeySha256);
  });

  test(`${vector.walletPrivateKey.slice(0, 10)}: each prime is the first candidate of its half of the seed that OpenSSL finds prime`, () => {
    const key = keyOf(vector);
    const seed = clientKey.seed(vector.walletPrivateKey);
    const starts = [firstCandidate(seed.subarray(0, 256)), firstCandidate(seed.subarray(256))];
    const primes = starts.map((c0, i) => c0 + 2n * BigInt(vector.primeOffsets[i]));
    assert.deepEqual([key.p, key.q], primes[0] > primes[1] ? primes : [primes[1], primes[0]]);
    starts.forEach((c0, i) => assert.equal(firstPrime(c0), primes[i]));
  });

  test(`${vector.walletPrivateKey.slice(0, 10)}: the integers are those of a 4096-bit RSA key with e = 65537`, () => {
    const { n, e, d, p, q, dp, dq, qi } = keyOf(vector);
    assert.equal(e, E);
    assert.equal(n, p * q);
    assert.equal(bits(n), 4096);
    for (const prime of [p, q]) {
      assert.equal(prime >> 2046n, 3n, 'a prime of 2048 bits with its two highest bits set');
      assert.notEqual(prime % E, 1n);
    }
    assert.ok(p > q);
    let [a, b] = [p - 1n, q - 1n];
    while (b !== 0n) [a, b] = [b, a % b];
    const lambda = ((p - 1n) * (q - 1n)) / a;
    assert.ok(d > 0n && d < lambda);
    assert.equal((d * e) % lambda, 1n);
    assert.equal(dp, d % (p - 1n));
    assert.equal(dq, d % (q - 1n));
    assert.ok(qi > 0n && qi < p);
    assert.equal((qi * q) % p, 1n);
    const privateKey = clientKey.keyObject(keyOf(vector));
    const signature = crypto.sign('sha256', Buffer.from('ecld'), privateKey);
    const publicKey = crypto.createPublicKey({ key: Buffer.from(vector.publicKeySpkiDer, 'hex'), format: 'der', type: 'spki' });
    assert.ok(crypto.verify('sha256', Buffer.from('ecld'), publicKey, signature));
  });
}

test('casClientKey gives the same private key at each call, the one of the wallet\'s vector', () => {
  const pkcs8 = () => clientKey.casClientKey(QUICK.walletPrivateKey).export({ type: 'pkcs8', format: 'der' });
  const first = pkcs8();
  assert.ok(first.equals(pkcs8()));
  const publicKey = crypto.createPublicKey(crypto.createPrivateKey({ key: first, format: 'der', type: 'pkcs8' }));
  assert.equal(publicKey.export({ type: 'spki', format: 'der' }).toString('hex'), QUICK.publicKeySpkiDer);
});

test('a key is read with or without 0x and in either case of its digits; anything else is refused without being quoted', () => {
  const hex = vectors[1].walletPrivateKey.slice(2);
  const seed = clientKey.seed(`0x${hex}`);
  assert.ok(seed.equals(clientKey.seed(hex)));
  assert.ok(seed.equals(clientKey.seed(`0x${hex.toUpperCase()}`)));
  assert.ok(seed.equals(clientKey.seed(hex.toUpperCase())));
  for (const refused of [hex.slice(1), `0x${hex}00`, `0X${hex}`, ` ${hex}`, `${hex.slice(0, 63)}g`, '', undefined, null]) {
    assert.throws(() => clientKey.seed(refused), (error) => {
      assert.equal(error.message, 'the publishing wallet\'s private key is not 64 hexadecimal digits');
      return true;
    });
  }
});

test('the seed is HKDF-SHA256 of the 32 key bytes under the salt ecld-cas-client-v1 and the info rsa-4096, 512 bytes', () => {
  assert.equal(clientKey.SALT, 'ecld-cas-client-v1');
  assert.equal(clientKey.INFO, 'rsa-4096');
  for (const { walletPrivateKey } of vectors) {
    const ikm = bytesOf(walletPrivateKey);
    assert.equal(ikm.length, 32);
    const seed = clientKey.seed(walletPrivateKey);
    assert.equal(seed.length, 512);
    assert.ok(seed.equals(hkdf(ikm, Buffer.from('ecld-cas-client-v1'), Buffer.from('rsa-4096'), 512)));
  }
});

test('another salt or another info gives another seed and another key', () => {
  const ikm = bytesOf(QUICK.walletPrivateKey);
  const seed = clientKey.seed(QUICK.walletPrivateKey);
  const otherSalt = hkdf(ikm, Buffer.from('ecld-cas-client-v2'), Buffer.from('rsa-4096'), 512);
  const otherInfo = hkdf(ikm, Buffer.from('ecld-cas-client-v1'), Buffer.from('rsa-2048'), 512);
  assert.ok(!seed.equals(otherSalt) && !seed.equals(otherInfo) && !otherSalt.equals(otherInfo));
  // No half is shared either: each prime starts from other bytes.
  for (const [a, b] of [[seed, otherSalt], [seed, otherInfo], [otherSalt, otherInfo]]) {
    assert.ok(!a.subarray(0, 256).equals(b.subarray(0, 256)) && !a.subarray(256).equals(b.subarray(256)));
  }
  const keys = [QUICK.publicKeySpkiDer, ...[otherSalt, otherInfo].map((s) => spki(clientKey.keyFromSeed(s)).toString('hex'))];
  assert.equal(new Set(keys).size, 3);
});

test('primeFrom gives the first candidate OpenSSL finds prime, from starts of 48 to 384 bits', () => {
  let passedOver = 0;
  for (const size of [48, 64, 96, 128, 192, 256, 384]) {
    // An odd number of `size` bits.
    const digest = crypto.createHash('sha512').update(`ecld-cas-client-v1 start ${size}`).digest('hex');
    const start = (BigInt(`0x${digest}`) >> BigInt(512 - size)) | (1n << BigInt(size - 1)) | 1n;
    const found = clientKey.primeFrom(start);
    assert.equal(found, firstPrime(start), `${size} bits`);
    assert.ok(found >= start && (found - start) % 2n === 0n);
    passedOver += Number((found - start) / 2n);
  }
  // The searches pass over composites: no start is its own answer throughout.
  assert.ok(passedOver > 100, `${passedOver} candidates passed over`);
});

test('primeFrom passes over a prime that is 1 modulo 65537', () => {
  // The least prime 65537 * k + 1 above 2^24.
  let prime = E * (2n ** 24n / E + 1n) + 1n;
  while (prime % 2n === 0n || !crypto.checkPrimeSync(prime)) prime += E;
  assert.equal(prime % E, 1n);
  const found = clientKey.primeFrom(prime);
  assert.ok(found > prime);
  assert.equal(found, firstPrime(prime));
});

test('primeFrom passes over a product of two primes above 2^20, which no prime below 2^20 divides', () => {
  const r1 = firstPrime(2n ** 20n + 1n);
  const r2 = firstPrime(r1 + 2n);
  const product = r1 * r2;
  assert.notEqual(product % E, 1n);
  const found = clientKey.primeFrom(product);
  assert.ok(found > product);
  assert.equal(found, firstPrime(product));
});

test('a seed of two equal halves, and one whose search leaves the bits of its half, give no key', () => {
  const half = crypto.createHash('sha256').update('ecld-cas-client-v1 half').digest();
  assert.throws(() => clientKey.keyFromSeed(Buffer.concat([half, half])), /^Error: the seed gives two equal primes$/);
  // 2^128 - 1 is composite, and every later candidate has 129 bits.
  assert.throws(() => clientKey.keyFromSeed(Buffer.alloc(32, 0xff)), /^Error: the seed gives a prime of more than its half's bits$/);
  // Two halves that differ give a key: here of 512 bits.
  const key = clientKey.keyFromSeed(crypto.createHash('sha512').update('ecld-cas-client-v1 seed').digest());
  assert.equal(bits(key.n), 512);
  assert.ok(crypto.checkPrimeSync(key.p) && crypto.checkPrimeSync(key.q));
});

test('cas/client_key.js loads crypto and no other module: it has no file to write a key to', () => {
  const tree = Parser.parse(fs.readFileSync(path.join(ROOT, 'cas', 'client_key.js'), 'utf8'), { ecmaVersion: 'latest', sourceType: 'script' });
  const required = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node.type !== 'string') return undefined;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      required.push(node.arguments[0].value);
    }
    if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration') required.push(node.source.value);
    return Object.values(node).forEach((value) => value && typeof value === 'object' && walk(value));
  };
  walk(tree);
  assert.deepEqual(required, ['crypto']);
});
