// The fence in the nodenithy securelock's state module (PHASE-D-PLAN.md
// WS-F.4) on esr_local's emulator: every key of the identity whose container
// as of the bound names the task caller as owner or write member is
// re-committed at its last StateCommitted at or before the bound (a later
// commit not taken), re-wrapped with the fence's own nonce (getNonce + 1) as
// a fresh CID published as state.fence.<key16>.enc / .cid, signed on the
// current version and relay nonce and staged at once as
// esr.commit.<key16>.<relayNonce>.json outside the ledger
// (esr.authorizations.json holds the steps' records alone); a key of another
// holder, an unowned key and a key created after the bound are left alone; a
// key shared with the caller for writing is fenced; a commit landing first
// makes the fence re-sign until it lands, the landing record returned; the
// resumption point of a fenced key is its state as of the bound; the state
// as of the bound is read once the head is RPC_REPLICA_LAG_BLOCKS past it;
// without a task caller nothing is fenced.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { freshModules, objectNames, settle } = require('./helpers/securelock_app');

const BUCKET = 'ecld-local';
const HOLDER = '0x' + '11'.repeat(20);
const OTHER = '0x' + 'cd'.repeat(20);
const KH = (key) => ethers.utils.id(key);
const K16 = (key) => KH(key).slice(2, 18);

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { ecldState, esrLocal } = freshModules();
  const { swift, contract } = esrLocal.install(ecldState, { caller: HOLDER, filePrefix: null });
  const pending = [];
  ecldState.setLocalCommitApply((...commit) => { pending.push(commit); });
  // The node's relay: a commit whose version the chain has moved past reverts
  // and is dropped.
  const relay = () => {
    const landed = [];
    while (pending.length) {
      const commit = pending.shift();
      try { contract.applyCommit(...commit); landed.push(commit); } catch (e) { /* reverted */ }
    }
    return landed;
  };
  const task = (caller) => {
    ecldState.configure({
      identityPriv: Buffer.from('ecld-local-test-identity-key-0001'), swiftStreamService: swift,
      bucket: BUCKET, contractAddress: '0xLOCAL', provider: null, caller,
    });
    return new ecldState.StateRegistry();
  };
  // Stages the last blob published for `key` under its CID, as the node
  // stages historical state objects.
  const stage = async (key) => {
    const blob = await swift.getFileContentBytes(BUCKET, `state.${key}.enc`);
    const cid = ecldState.unixfsCid(blob);
    await swift.putFileContent(BUCKET, `state.${cid}.enc`, '', blob);
    return cid;
  };
  // Commits `key` as `caller` and lands it.
  const land = async (caller, key, mutate) => {
    await task(caller).commit(key, mutate);
    relay();
    return stage(key);
  };
  const enclave = task(HOLDER).walletAddress;
  return { ecldState, swift, contract, pending, relay, task, stage, land, enclave };
}

const set = (n) => () => ({ n });

// Drives a started fence to its landing: the pending signatures relayed
// after each poll.
async function drive(t, env, fencePromise, rounds = 8) {
  let outcome = null;
  fencePromise.then((v) => { outcome = { value: v }; }, (e) => { outcome = { error: e }; });
  for (let i = 0; i < rounds && outcome === null; i += 1) {
    await settle(256);
    env.relay();
    await settle(256);
    t.mock.timers.tick(2000);
  }
  await settle(256);
  if (outcome === null) throw new Error('the fence did not finish');
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

async function chain(env) {
  const { contract, land, task } = env;
  contract.landAt(10);
  const ledger1 = await land(HOLDER, 'ledger', set(1));
  await land(OTHER, 'theirs', set(100));
  await land(null, 'open', set(50));
  contract.landAt(20);
  const ledger2 = await land(HOLDER, 'ledger', set(2));
  const spot = await land(HOLDER, 'spot', set(7));
  contract.landAt(30);
  const ledger3 = await land(HOLDER, 'ledger', set(3));
  await land(OTHER, 'theirs', set(101));
  await land(null, 'open', set(51));
  const late = await land(HOLDER, 'late', set(9));
  contract.landAt(40);
  task(HOLDER);
  return { ledger1, ledger2, ledger3, spot, late };
}

test('the keys the holder may write are re-committed at their state as of the bound, the others left alone', async (t) => {
  const env = setup(t);
  const { ecldState, swift, contract, enclave } = env;
  const cids = await chain(env);
  const ledgerFileBefore = await swift.getFileContent(BUCKET, 'esr.authorizations.json');
  const fenced = await drive(t, env, ecldState.fence(25));
  assert.deepEqual(fenced.map((f) => f.keyHash).sort(), [KH('ledger'), KH('spot')].sort());
  const ledger = fenced.find((f) => f.keyHash === KH('ledger'));
  const spot = fenced.find((f) => f.keyHash === KH('spot'));
  // A fresh CID at the chain's head, signed on the current version.
  assert.notEqual(ledger.cid, cids.ledger2);
  assert.notEqual(ledger.cid, cids.ledger3);
  assert.deepEqual([ledger.expectedVersion, ledger.relayNonce, ledger.nonce, ledger.callerUsed, ledger.owned], [3, 3, 4, HOLDER, true]);
  assert.deepEqual([spot.expectedVersion, spot.relayNonce, spot.nonce, spot.callerUsed, spot.owned], [1, 1, 2, HOLDER, true]);
  assert.deepEqual((await contract.getState(enclave, KH('ledger'))).slice(0, 2).map(String), [ledger.cid, '4']);
  assert.deepEqual((await contract.getState(enclave, KH('spot'))).slice(0, 2).map(String), [spot.cid, '2']);
  // The other holder's key, the unowned key and the key created after the
  // bound stand.
  assert.equal(Number(await contract.getVersion(enclave, KH('theirs'))), 2);
  assert.equal(Number(await contract.getVersion(enclave, KH('open'))), 2);
  assert.equal(Number(await contract.getVersion(enclave, KH('late'))), 1);
  assert.equal(String((await contract.getState(enclave, KH('late')))[0]), cids.late);
  // The re-committed state is the bound's, with the fence's nonce copy.
  const registry = new ecldState.StateRegistry();
  assert.deepEqual(await registry.get('ledger'), { n: 2 });
  assert.deepEqual(await registry.get('spot'), { n: 7 });
  assert.deepEqual(await registry.get('open'), { n: 51 });
  assert.equal(Number(await contract.getNonce(enclave, KH('ledger'))), 4);
  const blob = await swift.getFileContentBytes(BUCKET, `state.fence.${K16('ledger')}.enc`);
  assert.equal(ecldState.unixfsCid(blob), ledger.cid);
  assert.equal(await swift.getFileContent(BUCKET, `state.fence.${K16('ledger')}.cid`), ledger.cid);
  // Each landing record staged at once under the esr.commit name, outside
  // the ledger: esr.authorizations.json as the last plain commit left it,
  // the attestation empty.
  const names = objectNames(swift, BUCKET);
  for (const r of fenced) {
    const name = ecldState.commitFileName('esr.commit', r);
    assert.ok(names.includes(name), name);
    assert.equal(await swift.getFileContent(BUCKET, name), JSON.stringify(r));
  }
  assert.ok(!names.some((n) => n.startsWith('session.commit.')));
  assert.equal(await swift.getFileContent(BUCKET, 'esr.authorizations.json'), ledgerFileBefore);
  assert.deepEqual(ecldState.ledgerAttestation().commits, []);
  // A read of a fenced key resumes at the bound's state before any new commit.
  const log = (await contract.queryFilter(contract.filters.StateCommitted(enclave, KH('ledger')))).pop();
  assert.equal(log.args.cid, ledger.cid);
  assert.equal(log.blockNumber, 40);
});

test('a key another holder shares with the caller for writing is fenced', async (t) => {
  const env = setup(t);
  const { ecldState, contract, relay, task, stage, land, enclave } = env;
  contract.landAt(10);
  task(OTHER);
  await new ecldState.StateRegistry().commit('shared', set(1));
  await ecldState.esrGrant('shared', HOLDER, 'write');
  relay();
  await stage('shared');
  await land(OTHER, 'private', set(2));
  contract.landAt(30);
  task(HOLDER);
  const fenced = await drive(t, env, ecldState.fence(20));
  assert.deepEqual(fenced.map((f) => [f.keyHash, f.expectedVersion, f.callerUsed]), [[KH('shared'), 2, HOLDER]]);
  assert.equal(Number(await contract.getVersion(enclave, KH('shared'))), 3);
  assert.equal(Number(await contract.getVersion(enclave, KH('private'))), 1);
  assert.deepEqual(await new ecldState.StateRegistry().get('shared'), { n: 1 });
});

test('a commit landing first makes the fence re-sign on the fresh version and relay nonce until it lands', async (t) => {
  const env = setup(t);
  const { ecldState, swift, contract, pending, enclave } = env;
  await chain(env);
  const fencePromise = ecldState.fence(25);
  let outcome = null;
  fencePromise.then((v) => { outcome = { value: v }; }, (e) => { outcome = { error: e }; });
  await settle(256);
  // The fence signed its first re-commit of 'ledger' (and of 'spot' not yet:
  // keys are fenced one at a time).
  assert.equal(pending.length, 1);
  const first = JSON.parse(await swift.getFileContent(BUCKET, `esr.commit.${K16('ledger')}.3.json`));
  assert.deepEqual([first.expectedVersion, first.relayNonce, first.nonce], [3, 3, 4]);
  // Another commit to the key lands first: the staged signature reverts.
  contract.landAt(41);
  contract.applyCommit(enclave, KH('ledger'), 'bafy-foreign', 3);
  assert.throws(() => contract.applyCommit(...pending.shift()), /VersionMismatch/);
  t.mock.timers.tick(2000);
  await settle(256);
  // A fresh file on the fresh relay nonce; the earlier file stays.
  const second = JSON.parse(await swift.getFileContent(BUCKET, `esr.commit.${K16('ledger')}.4.json`));
  assert.deepEqual([second.expectedVersion, second.relayNonce, second.nonce], [4, 4, 5]);
  assert.notEqual(second.cid, first.cid, 'the nonce copy changed, so the blob and its CID did');
  assert.equal(await swift.getFileContent(BUCKET, `esr.commit.${K16('ledger')}.3.json`), JSON.stringify(first));
  const fenced = await drive(t, env, fencePromise);
  const ledger = fenced.find((f) => f.keyHash === KH('ledger'));
  assert.deepEqual(ledger, second, 'the landing record is returned');
  assert.equal(String((await contract.getState(enclave, KH('ledger')))[1]), '5');
  assert.deepEqual(await new ecldState.StateRegistry().get('ledger'), { n: 2 });
  assert.deepEqual(ecldState.ledgerAttestation().commits, []);
});

test('a bound before every commit fences nothing, and a bound that is not a block number is refused', async (t) => {
  const env = setup(t);
  const { ecldState } = env;
  await chain(env);
  assert.deepEqual(await drive(t, env, ecldState.fence(5)), []);
  await assert.rejects(ecldState.fence(-1), /not a block number/);
  await assert.rejects(ecldState.fence('toBlock'), /not a block number/);
});

test('without a task caller nothing is fenced', async (t) => {
  const env = setup(t);
  const { ecldState, contract, task, enclave } = env;
  await chain(env);
  task(null);
  assert.deepEqual(await ecldState.fence(25), []);
  assert.equal(Number(await contract.getVersion(enclave, KH('ledger'))), 3);
});

test('the state as of the bound is read once the head is RPC_REPLICA_LAG_BLOCKS past it', async (t) => {
  const env = setup(t);
  const { ecldState, contract, pending, land, task } = env;
  contract.landAt(10);
  await land(HOLDER, 'ledger', set(1));
  contract.landAt(30);
  task(HOLDER);
  const fencePromise = ecldState.fence(25);
  let outcome = null;
  fencePromise.then((v) => { outcome = { value: v }; }, (e) => { outcome = { error: e }; });
  for (let i = 0; i < 3; i += 1) {
    await settle(256);
    t.mock.timers.tick(2000);
  }
  await settle(256);
  assert.equal(pending.length, 0, 'nothing signed while the head is 30, 5 blocks past the bound');
  contract.landAt(33);
  t.mock.timers.tick(2000);
  await settle(256);
  assert.equal(pending.length, 1, 'signed once the head reached bound + 8');
  const fenced = await drive(t, env, fencePromise);
  assert.deepEqual(fenced.map((f) => [f.keyHash, f.expectedVersion]), [[KH('ledger'), 1]]);
});

test('a re-commit the node never relays fails the fence after its landing wait', async (t) => {
  const env = setup(t);
  const { ecldState } = env;
  await chain(env);
  const fencePromise = ecldState.fence(25);
  let outcome = null;
  fencePromise.then((v) => { outcome = { value: v }; }, (e) => { outcome = { error: e }; });
  for (let i = 0; i < 62 && outcome === null; i += 1) {
    await settle(256);
    t.mock.timers.tick(2000);
  }
  await settle(256);
  assert.ok(outcome && outcome.error, 'the fence failed');
  assert.match(outcome.error.message, /did not land within 120 s/);
});

test('the chain is read in spans of at most 3000 blocks and never to "latest", as the LitVM LiteForge RPC serves it', async (t) => {
  const env = setup(t);
  const { ecldState, contract, land, task } = env;
  contract.landAt(10);
  await land(HOLDER, 'ledger', set(1));
  await land(HOLDER, 'spot', set(7));
  contract.landAt(5000);
  await land(HOLDER, 'ledger', set(2));
  contract.landAt(20000);
  task(HOLDER);
  // The Zeeve RPC's answer to a range wider than 3000 blocks.
  const ranges = [];
  const queryFilter = contract.queryFilter.bind(contract);
  contract.queryFilter = async (filter, from, to) => {
    ranges.push([from, to]);
    if (!Number.isInteger(to) || to - from + 1 > 3000) throw new Error('eth_getLogs range exceeds 3000 blocks; split the range');
    return queryFilter(filter, from, to);
  };
  const fenced = await drive(t, env, ecldState.fence(7000));
  assert.deepEqual(fenced.map((f) => [f.keyHash, f.expectedVersion]), [[KH('ledger'), 2], [KH('spot'), 1]]);
  const registry = new ecldState.StateRegistry();
  assert.deepEqual(await registry.get('ledger'), { n: 2 });
  assert.deepEqual(await registry.get('spot'), { n: 7 });
  // The commits after the bound are read forward from it to the pinned head
  // (19992) in 3000-block spans, the state as of the bound backwards from the
  // bound to block 0, and the landing forward from the bound to the head.
  for (const span of [[7001, 10000], [19001, 19992], [4001, 7000], [1001, 4000], [0, 1000], [19001, 20000]]) {
    assert.ok(ranges.some(([from, to]) => from === span[0] && to === span[1]), `a read of [${span}]`);
  }
});
