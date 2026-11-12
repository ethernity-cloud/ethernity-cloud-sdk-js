// esr_local's MemContract as the chain the fence reads: StateCommitted logs
// with block numbers served through filters.StateCommitted + queryFilter, the
// entry enumeration (getEntriesFrom / entryCount / commitSeq), the relay nonce
// advanced by the landing and not by the signing, and landAt(block) moving the
// landings that follow. The state registry drives it through esr_local.install
// with the relay deferred, as ecldStateRelayLag.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');

const SRC = path.join(__dirname, '../nodenithy/build/securelock/src');
const CALLER = '0x' + '11'.repeat(20);
const ENCLAVE = '0x' + 'Ab'.repeat(20);
const OTHER = '0x' + 'Cd'.repeat(20);
const K1 = ethers.utils.id('counter');
const K2 = ethers.utils.id('log');

function fresh() {
  for (const name of ['ecld_state.js', 'esr_local.js']) delete require.cache[path.join(SRC, name)];
  return { ecldState: require(path.join(SRC, 'ecld_state.js')), esrLocal: require(path.join(SRC, 'esr_local.js')) };
}

function setup() {
  const { ecldState, esrLocal } = fresh();
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
  return { ecldState, contract, relay, newTask };
}

const increment = (state) => ({ ...(state || {}), n: ((state || {}).n || 0) + 1 });

test('a landed commit emits StateCommitted with the block, the version, the seq and the effective nonce', async () => {
  const { esrLocal } = fresh();
  const contract = new esrLocal.MemContract(null);
  contract.landAt(10);
  contract.applyCommit(ENCLAVE, K1, 'bafy-1', 0);
  contract.applyCommit(ENCLAVE, K1, 'bafy-2', 1, 2);
  contract.landAt(25);
  contract.applyCommit(ENCLAVE, K2, 'bafy-3', 0);
  const events = await contract.queryFilter(contract.filters.StateCommitted(ENCLAVE, K1));
  assert.equal(events.length, 2);
  assert.equal(events[0].blockNumber, 10);
  assert.equal(events[0].event, 'StateCommitted');
  assert.equal(events[0].args.enclave, ENCLAVE);
  assert.equal(events[0].args.key, K1);
  assert.equal(events[0].args.cid, 'bafy-1');
  assert.equal(Number(events[0].args.version), 1);
  assert.equal(Number(events[0].args.seq), 1);
  assert.equal(Number(events[0].args.nonce), 1);
  assert.equal(events[0].args[2], 'bafy-1');
  assert.equal(events[1].args.cid, 'bafy-2');
  assert.equal(Number(events[1].args.version), 2);
  assert.equal(Number(events[1].args.seq), 2);
  assert.equal(Number(events[1].args.nonce), 2);
  assert.equal(events[0].logIndex, 0);
  assert.equal(events[1].logIndex, 1);
  assert.notEqual(events[0].transactionHash, events[1].transactionHash);
  const all = await contract.queryFilter(contract.filters.StateCommitted());
  assert.deepEqual(all.map((e) => [e.blockNumber, Number(e.args.seq)]), [[10, 1], [10, 2], [25, 3]]);
  assert.equal(Number(await contract.commitSeq()), 3);
});

test('queryFilter bounds the logs by block range and by the indexed arguments', async () => {
  const { esrLocal } = fresh();
  const contract = new esrLocal.MemContract(null);
  contract.landAt(5);
  contract.applyCommit(ENCLAVE, K1, 'a', 0);
  contract.landAt(15);
  contract.applyCommit(ENCLAVE, K1, 'b', 1);
  contract.applyCommit(OTHER, K1, 'c', 0);
  contract.landAt(30);
  contract.applyCommit(ENCLAVE, K1, 'd', 2);
  const upTo15 = await contract.queryFilter(contract.filters.StateCommitted(ENCLAVE, K1), 0, 15);
  assert.deepEqual(upTo15.map((e) => e.args.cid), ['a', 'b']);
  const from15 = await contract.queryFilter(contract.filters.StateCommitted(ENCLAVE, K1), 15, 'latest');
  assert.deepEqual(from15.map((e) => e.args.cid), ['b', 'd']);
  const exact = await contract.queryFilter(contract.filters.StateCommitted(ENCLAVE.toLowerCase(), K1), 15, 15);
  assert.deepEqual(exact.map((e) => e.args.cid), ['b']);
  const anyEnclave = await contract.queryFilter(contract.filters.StateCommitted(null, K1), 15, 15);
  assert.deepEqual(anyEnclave.map((e) => e.args.cid), ['b', 'c']);
  const other = await contract.queryFilter(contract.filters.StateCommitted(OTHER));
  assert.deepEqual(other.map((e) => e.args.cid), ['c']);
});

test('landAt never moves the chain back', () => {
  const { esrLocal } = fresh();
  const contract = new esrLocal.MemContract(null);
  assert.equal(contract.blockNumber, 1);
  contract.landAt(7);
  contract.landAt(7);
  assert.equal(contract.blockNumber, 7);
  assert.throws(() => contract.landAt(6), /before the current block 7/);
  assert.throws(() => contract.landAt(1.5), /block 1.5 is not an integer/);
});

test('getEntriesFrom pages the entries in first-commit order without duplicates', async () => {
  const { esrLocal } = fresh();
  const contract = new esrLocal.MemContract(null);
  contract.applyCommit(ENCLAVE, K1, 'a', 0);
  contract.applyCommit(OTHER, K2, 'b', 0);
  contract.applyCommit(ENCLAVE, K1, 'c', 1);
  contract.applyCommit(ENCLAVE, K2, 'd', 0);
  assert.equal(Number(await contract.entryCount()), 3);
  const page = await contract.getEntriesFrom(0, 2);
  assert.equal(Number(page.total), 3);
  assert.deepEqual(page.enclaves, [ENCLAVE, OTHER]);
  assert.deepEqual(page.keys, [K1, K2]);
  assert.deepEqual(page.cids, ['c', 'b']);
  assert.deepEqual(page.versions.map(Number), [2, 1]);
  assert.deepEqual(page.updatedAts.map(Number), [0, 0]);
  assert.deepEqual(page[2], ['c', 'b']);
  const rest = await contract.getEntriesFrom(2, 10);
  assert.deepEqual(rest.enclaves, [ENCLAVE]);
  assert.deepEqual(rest.keys, [K2]);
  assert.deepEqual(rest.cids, ['d']);
  const past = await contract.getEntriesFrom(3, 10);
  assert.deepEqual(past.enclaves, []);
  assert.equal(Number(past.total), 3);
  const none = await contract.getEntriesFrom(0, 0);
  assert.deepEqual(none.cids, []);
  const second = await contract.entryAt(1);
  assert.deepEqual([second.enclave, second.key], [OTHER, K2]);
  assert.deepEqual([...second], [OTHER, K2]);
  await assert.rejects(contract.entryAt(3), /out of range/);
});

test('relay applies a staged authorization at its relay nonce and refuses another', async () => {
  const { ecldState, contract, newTask } = setup();
  const registry = newTask();
  const enclave = registry.walletAddress;
  await registry.commit('counter', increment);
  await registry.commit('counter', increment);
  assert.equal(Number(await contract.relayNonce(enclave, K1)), 0);
  const ledger = ecldState.ledgerAttestation().commits;
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger.map((a) => a.relayNonce), [0, 1]);
  assert.throws(() => contract.relay(ledger[1]), /RelayNonceMismatch: expected 0, given 1/);
  assert.equal(Number(await contract.relayNonce(enclave, K1)), 0);
  contract.relay(ledger[0]);
  assert.equal(Number(await contract.relayNonce(enclave, K1)), 1);
  assert.throws(() => contract.relay(ledger[0]), /RelayNonceMismatch: expected 1, given 0/);
  contract.relay(ledger[1]);
  assert.equal(Number(await contract.relayNonce(enclave, K1)), 2);
  const events = await contract.queryFilter(contract.filters.StateCommitted(enclave, K1));
  assert.deepEqual(events.map((e) => Number(e.args.version)), [1, 2]);
  assert.equal(events[1].args.cid, ledger[1].cid);
});

test('the relay nonce advances when the commit lands, not when the securelock signs it', async () => {
  const { contract, relay, newTask } = setup();
  const registry = newTask();
  const enclave = registry.walletAddress;
  await registry.commit('counter', increment);
  assert.equal(Number(await contract.relayNonce(enclave, K1)), 0);
  assert.deepEqual(await contract.queryFilter(contract.filters.StateCommitted(enclave, K1)), []);
  contract.landAt(42);
  relay();
  assert.equal(Number(await contract.relayNonce(enclave, K1)), 1);
  const events = await contract.queryFilter(contract.filters.StateCommitted(enclave, K1));
  assert.equal(events.length, 1);
  assert.equal(events[0].blockNumber, 42);
  assert.equal(Number(events[0].args.version), 1);
  const [cid] = await contract.getState(enclave, K1);
  assert.equal(events[0].args.cid, cid);
});

test('logs, block and seq survive a reload from the registry file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esr-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'registry.json');
  const { esrLocal } = fresh();
  const first = new esrLocal.MemContract(file);
  first.landAt(3);
  first.applyCommit(ENCLAVE, K1, 'a', 0);
  first.applyCommit(ENCLAVE, K1, 'b', 1);
  const second = new esrLocal.MemContract(file);
  assert.equal(second.blockNumber, 3);
  assert.equal(Number(await second.commitSeq()), 2);
  const events = await second.queryFilter(second.filters.StateCommitted(ENCLAVE, K1));
  assert.deepEqual(events.map((e) => [e.blockNumber, e.args.cid, Number(e.args.seq)]), [[3, 'a', 1], [3, 'b', 2]]);
  const page = await second.getEntriesFrom(0, 10);
  assert.deepEqual(page.enclaves, [ENCLAVE]);
  assert.deepEqual(page.cids, ['b']);
  second.applyCommit(ENCLAVE, K1, 'c', 2);
  assert.equal(Number(await second.commitSeq()), 3);
});
