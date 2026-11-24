import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { securelockNodeFlags, heapBytes, JIT_HEAP_BYTES, FIXED_NODE_FLAGS, OPENSSL_CONFIG } = require('../nodenithy/nodeFlags.js');

const FIXED = ['--disable-sigusr1', '--openssl-config=/etny-securelock/fixed-start/openssl.cnf'];

test('every securelock runs node without a SIGUSR1 handler and with the image\'s empty OpenSSL configuration', () => {
  assert.deepEqual([...FIXED_NODE_FLAGS], FIXED);
  assert.equal(OPENSSL_CONFIG, '/etny-securelock/fixed-start/openssl.cnf');
  assert.ok(Object.isFrozen(FIXED_NODE_FLAGS));
  for (const heap of ['256M', '1024M', '4G']) {
    for (const override of ['', '0', '1']) assert.deepEqual(securelockNodeFlags(heap, override).slice(-2), FIXED);
  }
});

test('a heap under 1024M runs node jitless, 1024M and above with the JIT', () => {
  assert.deepEqual(securelockNodeFlags('256M', ''), ['--jitless', ...FIXED]);
  assert.deepEqual(securelockNodeFlags('512M', ''), ['--jitless', ...FIXED]);
  assert.deepEqual(securelockNodeFlags('1024M', ''), FIXED);
  assert.deepEqual(securelockNodeFlags('1G', ''), FIXED);
  assert.deepEqual(securelockNodeFlags('2G', ''), FIXED);
});

test('ECLD_NODE_JITLESS overrides the derivation either way', () => {
  assert.deepEqual(securelockNodeFlags('256M', '0'), FIXED);
  assert.deepEqual(securelockNodeFlags('1024M', '1'), ['--jitless', ...FIXED]);
  assert.deepEqual(securelockNodeFlags('1024M', 'true'), ['--jitless', ...FIXED]);
});

test('heap values are read with their unit', () => {
  assert.equal(heapBytes('1024M'), JIT_HEAP_BYTES);
  assert.equal(heapBytes('1G'), JIT_HEAP_BYTES);
  assert.equal(heapBytes('4096K'), 4 * 1024 * 1024);
  assert.equal(heapBytes('1048576'), 1024 * 1024);
  assert.throws(() => heapBytes('lots'), /expected <n>/);
});
