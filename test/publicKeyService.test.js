import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { queueImage, CHAIN_ROW_GRACE_SECONDS, POLL_SECONDS } = require('../nodenithy/run/public_key_service.js');

// A service whose checkHash answers each entry in turn (404 as null, the last
// one repeatedly) and records the posts; the clock advances only in sleep.
const service = (answers) => {
  const posts = [];
  let n = 0;
  const clock = { t: 1000 };
  return {
    posts,
    check: async () => answers[Math.min(n++, answers.length - 1)],
    submit: async (hash, ...args) => { posts.push([hash, ...args]); return { queueId: 'q1' }; },
    sleep: async (s) => { clock.t += s; },
    now: () => clock.t,
    clock,
  };
};
const args = { submitArgs: ['canary', 'v3', 'sepolia', '1', 'QmCompose'], log: () => {} };

test('a chain row that appears within the grace period is never posted', async () => {
  const s = service([null, null, { status: 'running', percent: 40, publicKey: 0 }]);
  const first = await queueImage({ hash: 'QmHash', chainRegistered: true, ...s, ...args });
  assert.deepEqual(first, { status: 'running', percent: 40, publicKey: 0 });
  assert.deepEqual(s.posts, []);
  assert.equal(s.clock.t - 1000, 2 * POLL_SECONDS);
});

test('the hash is posted once the grace period passes with no row', async () => {
  const s = service([null]);
  const first = await queueImage({ hash: 'QmHash', chainRegistered: true, ...s, ...args });
  assert.equal(first, null);
  assert.deepEqual(s.posts, [['QmHash', 'canary', 'v3', 'sepolia', '1', 'QmCompose']]);
  assert.ok(s.clock.t - 1000 >= CHAIN_ROW_GRACE_SECONDS);
});

test('an image not registered on chain is posted at once', async () => {
  const s = service([{ status: 'queued', publicKey: 0 }]);
  const first = await queueImage({ hash: 'QmHash', chainRegistered: false, ...s, ...args });
  assert.equal(first, null);
  assert.equal(s.posts.length, 1);
  assert.equal(s.clock.t, 1000);
});
