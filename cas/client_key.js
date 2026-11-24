'use strict';
// The CAS client key of a publishing wallet, ecld-cas-client-v1: the RSA key
// pair of the TLS client certificate a securelock session is uploaded under
// at the Scontain CAS, derived from the wallet's private key as
// docs/cas-client-key.md specifies. ethernity-cloud-sdk-py derives the same
// key pair from the same wallet (test/vectors/cas-client-key.json). The key
// pair is returned to the caller and written nowhere.

const crypto = require('crypto');

// HKDF-SHA256's salt and info, as ASCII, and the seed's length in bytes: one
// half of the seed gives each prime.
const SALT = 'ecld-cas-client-v1';
const INFO = 'rsa-4096';
const SEED_LENGTH = 512;

const E = 65537n;
// A prime is divisible by no odd prime below SIEVE_LIMIT.
const SIEVE_LIMIT = 2 ** 20;
// The Miller-Rabin bases.
const BASES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
// The candidates sieved at a time: base + 2 * j for j below WINDOW.
const WINDOW = 1024;

// The 32 bytes of a private key given as 64 hexadecimal digits with or
// without the 0x prefix. Throws, without quoting the key, for anything else.
function walletKeyBytes(privateKey) {
  const text = String(privateKey);
  const hex = text.startsWith('0x') ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('the publishing wallet\'s private key is not 64 hexadecimal digits');
  }
  return Buffer.from(hex, 'hex');
}

// The seed of the wallet's CAS client key: HKDF-SHA256 over the 32 key bytes.
function seed(privateKey) {
  return Buffer.from(crypto.hkdfSync('sha256', walletKeyBytes(privateKey),
    Buffer.from(SALT, 'ascii'), Buffer.from(INFO, 'ascii'), SEED_LENGTH));
}

let oddPrimes = null;

// The odd primes below SIEVE_LIMIT, in ascending order.
function smallOddPrimes() {
  if (oddPrimes === null) {
    const composite = new Uint8Array(SIEVE_LIMIT);
    const found = [];
    for (let i = 3; i < SIEVE_LIMIT; i += 2) {
      if (composite[i]) continue;
      found.push(i);
      for (let j = i * i; j < SIEVE_LIMIT; j += 2 * i) composite[j] = 1;
    }
    oddPrimes = Uint32Array.from(found);
  }
  return oddPrimes;
}

// a^exponent mod modulus, for an exponent of 1 or more.
function modPow(a, exponent, modulus) {
  const bits = exponent.toString(2);
  let x = a % modulus;
  for (let i = 1; i < bits.length; i++) {
    x = (x * x) % modulus;
    if (bits[i] === '1') x = (x * a) % modulus;
  }
  return x;
}

// Whether the odd c is a strong probable prime to the base a (Miller-Rabin).
function strongProbablePrime(c, a) {
  let d = c - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s += 1;
  }
  let x = modPow(a, d, c);
  if (x === 1n || x === c - 1n) return true;
  for (let i = 1; i < s; i++) {
    x = (x * x) % c;
    if (x === c - 1n) return true;
  }
  return false;
}

// The first of start, start + 2, start + 4, ... that is divisible by no odd
// prime below SIEVE_LIMIT, is not 1 modulo E and is a strong probable prime
// to every base of BASES. `start` is odd.
function primeFrom(start) {
  const primes = smallOddPrimes();
  // residues[k] is base mod primes[k].
  const residues = new Uint32Array(primes.length);
  for (let k = 0; k < primes.length; k++) residues[k] = Number(start % BigInt(primes[k]));
  for (let base = start; ; base += BigInt(2 * WINDOW)) {
    const composite = new Uint8Array(WINDOW);
    for (let k = 0; k < primes.length; k++) {
      const r = primes[k];
      const residue = residues[k];
      // The least j with base + 2 * j divisible by r: (r - residue) / 2 mod r,
      // 1 / 2 mod r being (r + 1) / 2.
      let j = residue === 0 ? 0 : ((r - residue) * ((r + 1) / 2)) % r;
      for (; j < WINDOW; j += r) composite[j] = 1;
      residues[k] = (residue + 2 * WINDOW) % r;
    }
    for (let j = 0; j < WINDOW; j++) {
      if (composite[j]) continue;
      const c = base + BigInt(2 * j);
      if (c % E !== 1n && BASES.every((a) => strongProbablePrime(c, a))) return c;
    }
  }
}

// The inverse of a modulo m, which is coprime to a.
function modInverse(a, m) {
  let [r0, r1] = [a % m, m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const quotient = r0 / r1;
    [r0, r1] = [r1, r0 - quotient * r1];
    [s0, s1] = [s1, s0 - quotient * s1];
  }
  return ((s0 % m) + m) % m;
}

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

// The RSA key of a seed: each half of the seed gives one prime of as many
// bits as the half holds. The integers of the RSAPrivateKey, as BigInt:
// n, e, d, p, q, dp, dq, qi.
function keyFromSeed(seedBytes) {
  const half = seedBytes.length / 2;
  const bits = BigInt(8 * half);
  const prime = (bytes) => {
    const found = primeFrom(BigInt(`0x${bytes.toString('hex')}`) | (3n << (bits - 2n)) | 1n);
    if (found >> bits !== 0n) throw new Error('the seed gives a prime of more than its half\'s bits');
    return found;
  };
  const first = prime(seedBytes.subarray(0, half));
  const second = prime(seedBytes.subarray(half));
  if (first === second) throw new Error('the seed gives two equal primes');
  const [p, q] = first > second ? [first, second] : [second, first];
  const d = modInverse(E, ((p - 1n) * (q - 1n)) / gcd(p - 1n, q - 1n));
  return { n: p * q, e: E, d, p, q, dp: d % (p - 1n), dq: d % (q - 1n), qi: modInverse(q, p) };
}

const base64url = (value) => {
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex').toString('base64url');
};

// The private KeyObject of the integers keyFromSeed gives.
function keyObject(key) {
  const jwk = { kty: 'RSA' };
  for (const [name, value] of Object.entries(key)) jwk[name] = base64url(value);
  return crypto.createPrivateKey({ format: 'jwk', key: jwk });
}

// The CAS client key of the wallet whose private key is `privateKey` (64
// hexadecimal digits, with or without 0x): a private RSA KeyObject.
function casClientKey(privateKey) {
  return keyObject(keyFromSeed(seed(privateKey)));
}

module.exports = { SALT, INFO, seed, primeFrom, keyFromSeed, keyObject, casClientKey };
