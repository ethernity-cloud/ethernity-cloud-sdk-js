// A read of state committed by an earlier task waits for the node to stage the
// object the chain names, for STATE_STAGE_WAIT_MS, instead of failing on its
// first look at the bucket (bloxberg testnet orders 2027-2030: the node staged
// the object after the securelock had read). The chain and the bucket are
// esr_local's in-memory stand-ins; the clock and the timers are node:test's.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../nodenithy/build/securelock/src');
const CALLER = '0x' + '11'.repeat(20);
const BUCKET = 'ecld-local';

function setup() {
  for (const name of ['ecld_state.js', 'esr_local.js']) delete require.cache[path.join(SRC, name)];
  const ecldState = require(path.join(SRC, 'ecld_state.js'));
  const esrLocal = require(path.join(SRC, 'esr_local.js'));
  const { swift, contract } = esrLocal.install(ecldState, { caller: CALLER, filePrefix: null });
  const pending = [];
  ecldState.setLocalCommitApply((...commit) => { pending.push(commit); });
  const relay = () => { while (pending.length) contract.applyCommit(...pending.shift()); };
  const newTask = () => {
    ecldState.configure({
      identityPriv: Buffer.from('ecld-local-test-identity-key-0001'), swiftStreamService: swift,
      bucket: BUCKET, contractAddress: '0xLOCAL', provider: null, caller: CALLER,
    });
    return new ecldState.StateRegistry();
  };
  return { ecldState, swift, relay, newTask };
}

const increment = (state) => ({ ...(state || {}), n: ((state || {}).n || 0) + 1 });

// Lets a started read run up to its wait for the next look at the bucket.
const settle = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };

// Commits the counter once and relays it; returns the committed object,
// leaving the key slot with an unrelayed blob, as a later commit does, and the
// object the chain names absent from the bucket.
const committedAndRelayed = async ({ swift, relay, newTask }) => {
  await newTask().commit('counter', increment);
  relay();
  const blob = await swift.getFileContentBytes(BUCKET, 'state.counter.enc');
  await swift.putFileContent(BUCKET, 'state.counter.enc', '', Buffer.from('unrelayed'));
  return blob;
};

test('a state object staged after the read began is returned', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const env = setup();
  const blob = await committedAndRelayed(env);
  const read = env.newTask().get('counter');
  await settle();
  await env.swift.putFileContent(BUCKET, `state.${env.ecldState.cidv1Raw(blob)}.enc`, '', blob);
  t.mock.timers.tick(2000);
  assert.deepEqual(await read, { n: 1 });
});

test('a state object the node never stages fails after the wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const env = setup();
  await committedAndRelayed(env);
  const read = env.newTask().get('counter');
  for (let i = 0; i < 61; i++) {
    await settle();
    t.mock.timers.tick(2000);
  }
  await assert.rejects(read, /does not match the committed CID/);
});

test('a read with nothing in the bucket says so after the wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const env = setup();
  await committedAndRelayed(env);
  await env.swift.putFileContent(BUCKET, 'state.counter.enc', '', Buffer.alloc(0));
  const read = env.newTask().get('counter');
  for (let i = 0; i < 61; i++) {
    await settle();
    t.mock.timers.tick(2000);
  }
  await assert.rejects(read, /not staged within/);
});
