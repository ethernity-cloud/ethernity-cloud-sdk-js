// ecld-info's StateCommitted listing reads the chain in spans the LitVM
// LiteForge RPC serves (eth_getLogs ranges of at most 3000 blocks), from the
// head backwards, and stops once it holds the events wanted.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lastLogs, LOG_CHUNK_BLOCKS } = require('../info.js');

// A contract whose queryFilter refuses a range wider than the RPC's cap, as
// the Zeeve RPC does, and answers the logs of `blocks` inside [from, to].
function registry(blocks) {
  const calls = [];
  return {
    calls,
    async queryFilter(filter, from, to) {
      calls.push([from, to]);
      if (to - from + 1 > LOG_CHUNK_BLOCKS) throw new Error('eth_getLogs range exceeds 3000 blocks; split the range');
      return blocks.filter((b) => b >= from && b <= to).map((blockNumber) => ({ blockNumber, filter }));
    },
  };
}

test('the registry stub refuses the one-call read of a wide range', async () => {
  await assert.rejects(registry([]).queryFilter('f', 0, 9999), /exceeds 3000 blocks/);
});

test('lastLogs reads a wide range in spans of at most LOG_CHUNK_BLOCKS blocks, newest span first', async () => {
  const reg = registry([10, 2990, 3005, 7000, 9999]);
  const logs = await lastLogs(reg, 'f', 0, 9999, 10);
  assert.deepEqual(logs.map((l) => l.blockNumber), [10, 2990, 3005, 7000, 9999]);
  assert.ok(logs.every((l) => l.filter === 'f'));
  assert.deepEqual(reg.calls, [[7000, 9999], [4000, 6999], [1000, 3999], [0, 999]]);
});

test('lastLogs stops at the spans that hold the logs wanted and answers the last ones, oldest first', async () => {
  const two = registry([10, 2990, 3005, 7000, 9999]);
  assert.deepEqual((await lastLogs(two, 'f', 0, 9999, 2)).map((l) => l.blockNumber), [7000, 9999]);
  assert.deepEqual(two.calls, [[7000, 9999]]);
  const three = registry([10, 2990, 3005, 7000, 9999]);
  assert.deepEqual((await lastLogs(three, 'f', 0, 9999, 3)).map((l) => l.blockNumber), [3005, 7000, 9999]);
  assert.deepEqual(three.calls, [[7000, 9999], [4000, 6999], [1000, 3999]]);
});

test('lastLogs reads nothing below `from` and answers [] for a range without logs', async () => {
  const reg = registry([10, 5000]);
  assert.deepEqual((await lastLogs(reg, 'f', 4500, 5100, 5)).map((l) => l.blockNumber), [5000]);
  assert.deepEqual(reg.calls, [[4500, 5100]]);
  const empty = registry([]);
  assert.deepEqual(await lastLogs(empty, 'f', 0, 6500, 5), []);
  assert.deepEqual(empty.calls, [[3501, 6500], [501, 3500], [0, 500]]);
});
