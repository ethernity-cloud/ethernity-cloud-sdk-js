// The nodenithy securelock's state registry while the node has not yet relayed
// a commit to the chain: a read in the same task sees the commit, a second
// commit builds on it, and a later task reads the committed object even though
// the bucket's state.<key>.enc holds a newer blob. The chain and the bucket are
// esr_local's in-memory stand-ins; commits reach the registry only when relay()
// runs, as they reach the chain only when the node relays them.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../nodenithy/build/securelock/src');
const CALLER = '0x' + '11'.repeat(20);

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
      bucket: 'ecld-local', contractAddress: '0xLOCAL', provider: null, caller: CALLER,
    });
    return new ecldState.StateRegistry();
  };
  return { ecldState, swift, contract, relay, newTask };
}

const increment = (state) => ({ ...(state || {}), n: ((state || {}).n || 0) + 1 });

test('a read after a commit in the same task returns the commit', async () => {
  const { newTask } = setup();
  const registry = newTask();
  await registry.commit('counter', increment);
  assert.deepEqual(await registry.get('counter'), { n: 1 });
});

test('a second commit in the same task builds on the first', async () => {
  const { relay, newTask } = setup();
  const registry = newTask();
  await registry.commit('counter', increment);
  await registry.commit('counter', increment);
  relay();
  assert.deepEqual(await newTask().get('counter'), { n: 2 });
});

test('a later task commits and reads while its commit is unrelayed', async () => {
  const { relay, newTask } = setup();
  await newTask().commit('counter', increment);
  relay();
  const registry = newTask();
  await registry.commit('counter', increment);
  assert.deepEqual(await registry.get('counter'), { n: 2 });
  relay();
  assert.deepEqual(await newTask().get('counter'), { n: 2 });
});

test('the object named by the committed CID is read before the key slot', async () => {
  const { ecldState, swift, relay, newTask } = setup();
  await newTask().commit('counter', increment);
  relay();
  const committed = await swift.getFileContentBytes('ecld-local', 'state.counter.enc');
  await swift.putFileContent('ecld-local', `state.${ecldState.cidv1Raw(committed)}.enc`, '', committed);
  await swift.putFileContent('ecld-local', 'state.counter.enc', '', Buffer.from('unrelayed'));
  assert.deepEqual(await newTask().get('counter'), { n: 1 });
});

test('a blob that matches no committed CID is refused', async () => {
  const { swift, relay, newTask } = setup();
  await newTask().commit('counter', increment);
  relay();
  await swift.putFileContent('ecld-local', 'state.counter.enc', '', Buffer.from('tampered'));
  await assert.rejects(newTask().get('counter'), /does not match the committed CID/);
});
