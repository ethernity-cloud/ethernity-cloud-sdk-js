import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { securelockNodeFlags, heapBytes, JIT_HEAP_BYTES } = require('../nodenithy/nodeFlags.js');

test('a heap under 1024M runs node jitless, 1024M and above with the JIT', () => {
  assert.deepEqual(securelockNodeFlags('256M', ''), ['--jitless']);
  assert.deepEqual(securelockNodeFlags('512M', ''), ['--jitless']);
  assert.deepEqual(securelockNodeFlags('1024M', ''), []);
  assert.deepEqual(securelockNodeFlags('1G', ''), []);
  assert.deepEqual(securelockNodeFlags('2G', ''), []);
});

test('ECLD_NODE_JITLESS overrides the derivation either way', () => {
  assert.deepEqual(securelockNodeFlags('256M', '0'), []);
  assert.deepEqual(securelockNodeFlags('1024M', '1'), ['--jitless']);
  assert.deepEqual(securelockNodeFlags('1024M', 'true'), ['--jitless']);
});

test('heap values are read with their unit', () => {
  assert.equal(heapBytes('1024M'), JIT_HEAP_BYTES);
  assert.equal(heapBytes('1G'), JIT_HEAP_BYTES);
  assert.equal(heapBytes('4096K'), 4 * 1024 * 1024);
  assert.equal(heapBytes('1048576'), 1024 * 1024);
  assert.throws(() => heapBytes('lots'), /expected <n>/);
});
