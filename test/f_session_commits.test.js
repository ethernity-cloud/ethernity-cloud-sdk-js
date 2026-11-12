// A session step's commit hold and output envelope (PHASE-D-PLAN.md WS-F.2)
// against test/fixtures/session-commits.json: the commits a step signs stay
// out of the bucket until its output, then land as
// session.commit.<n>.<key16>.<relayNonce>.json beside the signed envelope
// {ack, code, data, commits, esr: {wallet, commits}} and the rewritten
// esr.authorizations.json, byte for byte the fixture's; a step without
// commits carries the empty lists and leaves the ledger as it was; a fence's
// commit keeps the esr.commit name and stays out of the ledger; a step
// without ESR carries wallet null; a discarded step rolls the relay-nonce
// memo back; a closed registry refuses every later commit.
// The records are signed with the fixture's ESR wallet over the registry's
// commitDigest (chain 31337, registry 0x1dc5...), both put in through the
// module's local-testing hooks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { SRC, freshModules, p384KeyPair, StubApp } = require('./helpers/securelock_app');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'session-commits.json'), 'utf8'));
const BUCKET = 'ecld-local';
const CALLER = FIXTURE.steps.withCommits.envelope.esr.commits[0].callerUsed;
const WALLET = new ethers.Wallet(FIXTURE.esr.enclaveWalletPrivateKey);

// EnclaveStateRegistry.commitDigest as the fixture's digestRule gives it.
function commitDigest(enclave, keyHash, cid, expectedVersion, relayNonce, nonce) {
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
    ['string', 'uint256', 'address', 'address', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256'],
    ['EnclaveStateRegistry.commitFor', FIXTURE.chainId, FIXTURE.registry, enclave, keyHash, ethers.utils.id(cid),
      expectedVersion, relayNonce, nonce]));
}

function setup() {
  const mods = freshModules();
  const { ecldState, esrLocal, sessionExec } = mods;
  // The signer is the fixture's ESR wallet: esr_wallet derives the key from
  // the identity, and the module reads the derivation through esr_wallet.
  const esrWallet = require(path.join(SRC, 'esr_wallet.js'));
  esrWallet._deriveWalletPrivateKey = () => WALLET.privateKey;
  esrWallet.deriveWalletAddress = () => WALLET.address;
  const { swift, contract } = esrLocal.install(ecldState, { caller: CALLER, filePrefix: null });
  ecldState.setLocalCommitApply(null);
  contract.commitDigest = async (...args) => commitDigest(...args);
  // The chain's relay nonces as the fixture's records carry them.
  const chainRelayNonce = {};
  contract.relayNonce = async (enclave, keyHash) => ethers.BigNumber.from(chainRelayNonce[String(keyHash).toLowerCase()] || 0);
  const app = new StubApp({
    swift, bucket: BUCKET, orderId: FIXTURE.orderId, challenge: 'k7p2x9qv4m1zr8t3hw6n', caller: CALLER,
    trustedzone: p384KeyPair(), securelock: p384KeyPair(),
  });
  const session = new sessionExec.SecureLockSession(app, { order_id: FIXTURE.orderId, close_after_seconds: 3600, input_cutoff_seconds: 3600 });
  return { ...mods, swift, contract, chainRelayNonce, app, session, registry: new ecldState.StateRegistry() };
}

test('a two-commit step stages nothing before its output, then exactly the fixture\'s names, contents, envelope and ledger', async () => {
  const { ecldState, chainRelayNonce, app, session, registry } = setup();
  const [ledger, audit] = FIXTURE.steps.withCommits.envelope.esr.commits;
  chainRelayNonce[ledger.keyHash] = ledger.relayNonce;
  ecldState.beginStep();
  await registry._sendCommit(ledger.keyHash, ledger.cid, ledger.expectedVersion, CALLER, ledger.nonce);
  await registry._sendCommit(audit.keyHash, audit.cid, audit.expectedVersion, CALLER, audit.nonce);
  assert.deepEqual(await app.names(), [], 'no commit file and no ledger in the bucket before the output');
  assert.deepEqual(ecldState.ledgerAttestation().commits, [], 'the ledger holds nothing of an open step');

  session.emitted = FIXTURE.steps.withCommits.outputObject;
  await session.emit(FIXTURE.steps.withCommits.envelope.ack, FIXTURE.steps.withCommits.envelope.code, FIXTURE.steps.withCommits.envelope.data);
  const names = await app.names();
  for (const file of FIXTURE.steps.withCommits.commitFiles) {
    assert.ok(names.includes(file.name), file.name);
    assert.equal(await app.object(file.name), file.content);
  }
  assert.equal(await app.object('esr.authorizations.json'), FIXTURE.authorizations.afterSteps[0].content);
  assert.equal(await app.object(`session.output.${FIXTURE.steps.withCommits.outputObject}.securelock`), FIXTURE.steps.withCommits.envelopeJson);
  assert.ok(names.includes(`session.output.${FIXTURE.steps.withCommits.outputObject}.sig.securelock`));
  assert.ok(!names.some((n) => n.startsWith('esr.commit.')), 'a step commit never takes the esr.commit name');
  assert.equal(session.emitted, FIXTURE.steps.withCommits.outputObject + 1);
  // The ledger's records are the envelope's, in staging order.
  assert.deepEqual(ecldState.ledgerAttestation().commits, FIXTURE.steps.withCommits.envelope.esr.commits);
  assert.equal(JSON.stringify(ecldState.ledgerAttestation().commits), FIXTURE.authorizations.ledgerJson);
  assert.equal(ecldState.cidv1Raw(Buffer.from(await app.object('esr.authorizations.json'), 'utf8')), FIXTURE.authorizations.ledgerCid);
  // The signature over the envelope binds the challenge, the order and the object.
  const { cryptoStub } = require('./helpers/securelock_app');
  const sig = await app.object(`session.output.${FIXTURE.steps.withCommits.outputObject}.sig.securelock`);
  assert.ok(cryptoStub.verifySignature(app.securelock.publicKeyPem,
    `k7p2x9qv4m1zr8t3hw6n:${FIXTURE.orderId}:session.output.${FIXTURE.steps.withCommits.outputObject}:${FIXTURE.steps.withCommits.envelopeJson}`, sig));

  /* the step without commits */
  session.emitted = FIXTURE.steps.withoutCommits.outputObject;
  await session.emit(FIXTURE.steps.withoutCommits.envelope.ack, FIXTURE.steps.withoutCommits.envelope.code, FIXTURE.steps.withoutCommits.envelope.data);
  assert.equal(await app.object(`session.output.${FIXTURE.steps.withoutCommits.outputObject}.securelock`), FIXTURE.steps.withoutCommits.envelopeJson);
  assert.equal(await app.object('esr.authorizations.json'), FIXTURE.authorizations.afterSteps[1].content);
  assert.equal((await app.names()).filter((n) => n.startsWith('session.commit.')).length, 2);

  /* the fence's commit: staged at once under the esr.commit name beside
     them, outside the ledger (envelope.rules[4]: esr.authorizations.json
     holds the steps' records alone) */
  const fence = JSON.parse(FIXTURE.fence.content);
  const fenceAuth = await registry._sendCommit(fence.keyHash, fence.cid, fence.expectedVersion, CALLER, fence.nonce, true);
  assert.equal(ecldState.commitFileName('esr.commit', fenceAuth), FIXTURE.fence.name);
  assert.equal(await app.object(FIXTURE.fence.name), FIXTURE.fence.content);
  assert.equal(await app.object('esr.authorizations.json'), FIXTURE.authorizations.afterSteps[1].content);
  assert.deepEqual(ecldState.ledgerAttestation().commits, FIXTURE.steps.withCommits.envelope.esr.commits);
  assert.equal((await app.names()).filter((n) => n.startsWith('session.commit.')).length, 2);
  // The step stayed open: a commit after the fence is held, not staged.
  await registry._sendCommit(audit.keyHash, audit.cid, 1, CALLER, 0);
  assert.equal((await app.names()).filter((n) => n.startsWith('esr.commit.')).length, 1);
});

test('the names and the records keep the commit order, a second commit to a key following the first', async () => {
  const { ecldState, app, session, registry } = setup();
  const [ledger, audit] = FIXTURE.steps.withCommits.envelope.esr.commits;
  ecldState.beginStep();
  await registry._sendCommit(audit.keyHash, audit.cid, 0, CALLER, 0);
  await registry._sendCommit(ledger.keyHash, ledger.cid, 0, CALLER, 0);
  await registry._sendCommit(audit.keyHash, audit.cid, 1, CALLER, 0);
  await session.emit(0, 0, 'x');
  const envelope = JSON.parse(await app.object('session.output.0.securelock'));
  assert.deepEqual(envelope.commits, [
    `session.commit.0.${audit.keyHash.slice(2, 18)}.0.json`,
    `session.commit.0.${ledger.keyHash.slice(2, 18)}.0.json`,
    `session.commit.0.${audit.keyHash.slice(2, 18)}.1.json`,
  ]);
  assert.deepEqual(envelope.esr.commits.map((r) => [r.keyHash, r.relayNonce]), [[audit.keyHash, 0], [ledger.keyHash, 0], [audit.keyHash, 1]]);
  assert.deepEqual(Object.keys(envelope), ['ack', 'code', 'data', 'commits', 'esr']);
  assert.deepEqual(Object.keys(envelope.esr), ['wallet', 'commits']);
  assert.deepEqual(Object.keys(envelope.esr.commits[0]), FIXTURE.record.fields);
});

test('a step whose record was given another caller is restamped with the attested one and its envelope carries SECURITY_VIOLATION', async () => {
  const { ecldState, TaskStatus, app, session, registry } = setup();
  const [ledger] = FIXTURE.steps.withCommits.envelope.esr.commits;
  ecldState.beginStep();
  ecldState.setTaskCaller('0x' + 'ee'.repeat(20));
  await registry._sendCommit(ledger.keyHash, ledger.cid, 0, '0x' + 'ee'.repeat(20), 0);
  await session.emit(0, 0, 'x');
  const envelope = JSON.parse(await app.object('session.output.0.securelock'));
  assert.equal(envelope.code, TaskStatus.SECURITY_VIOLATION);
  assert.match(envelope.data, /^SECURITY_VIOLATION: the task attempted to forge the state commit caller/);
  assert.equal(envelope.esr.commits[0].callerUsed, CALLER);
  assert.equal(JSON.parse(await app.object(envelope.commits[0])).callerUsed, CALLER);
  // The ledger was restamped with the envelope: the task's final restamp
  // finds nothing more.
  assert.equal(await ecldState.restampLedgerCaller(CALLER), false);
});

test('a session step without a state registry carries wallet null and empty lists', async () => {
  const { sessionExec, ecldState, esrLocal } = freshModules();
  const swift = new esrLocal.MemSwift(null);
  const app = new StubApp({
    swift, bucket: BUCKET, orderId: 7, challenge: 'c', caller: null, trustedzone: p384KeyPair(), securelock: p384KeyPair(),
  });
  const session = new sessionExec.SecureLockSession(app, { order_id: 7 });
  ecldState.beginStep();
  await session.emit(0, 0, 'plain');
  assert.equal(await app.object('session.output.0.securelock'), '{"ack":0,"code":0,"data":"plain","commits":[],"esr":{"wallet":null,"commits":[]}}');
  assert.deepEqual((await app.names()).sort(), ['session.output.0.securelock', 'session.output.0.sig.securelock']);
});

test('a session that ends before any output stages its held commits as a plain task does', async () => {
  const { ecldState, app, registry } = setup();
  const [ledger] = FIXTURE.steps.withCommits.envelope.esr.commits;
  ecldState.beginStep();
  await registry._sendCommit(ledger.keyHash, ledger.cid, 0, CALLER, 0);
  assert.deepEqual(await app.names(), []);
  const flushed = await ecldState.flushStepCommits(CALLER);
  assert.equal(flushed.records.length, 1);
  assert.equal(flushed.tampered, false);
  assert.deepEqual((await app.names()).sort(), ['esr.authorizations.json', `esr.commit.${ledger.keyHash.slice(2, 18)}.0.json`]);
  assert.deepEqual(ecldState.ledgerAttestation().commits, flushed.records);
  // The hold is closed: the next commit is staged at once.
  await registry._sendCommit(ledger.keyHash, ledger.cid, 1, CALLER, 0);
  assert.ok((await app.names()).includes(`esr.commit.${ledger.keyHash.slice(2, 18)}.1.json`));
  assert.equal(ecldState.ledgerAttestation().commits.length, 2);
});

test('a discarded step leaves no record and rolls the relay-nonce memo back', async () => {
  const { ecldState, app, registry } = setup();
  const [ledger] = FIXTURE.steps.withCommits.envelope.esr.commits;
  ecldState.beginStep();
  const held = await registry._sendCommit(ledger.keyHash, ledger.cid, 0, CALLER, 0);
  assert.equal(held.relayNonce, 0);
  const discarded = ecldState.discardStepCommits();
  assert.deepEqual(discarded, [held]);
  assert.deepEqual(await app.names(), []);
  assert.deepEqual(ecldState.ledgerAttestation().commits, []);
  // The next commit to the key signs the chain's relay nonce, not the
  // discarded commit's successor.
  ecldState.beginStep();
  const next = await registry._sendCommit(ledger.keyHash, ledger.cid, 0, CALLER, 0);
  assert.equal(next.relayNonce, 0);
});

test('a closed registry refuses every later commit, held or not, and the fence\'s', async () => {
  const { ecldState, esrLocal, app, registry } = setup();
  const [ledger] = FIXTURE.steps.withCommits.envelope.esr.commits;
  ecldState.beginStep();
  ecldState.closeCommits();
  await assert.rejects(registry._sendCommit(ledger.keyHash, ledger.cid, 0, CALLER, 0), ecldState.StatePermissionError);
  await assert.rejects(registry._sendCommit(ledger.keyHash, ledger.cid, 0, CALLER, 0, true), ecldState.StatePermissionError);
  await assert.rejects(registry.commit('ledger', () => ({ n: 1 })), /accepts no further commits/);
  ecldState.discardStepCommits();
  await assert.rejects(registry.commit('ledger', () => ({ n: 1 })), ecldState.StatePermissionError);
  assert.deepEqual(await app.names(), [], 'nothing reaches the bucket, not even a state blob');
  // configure() reopens it for the next task.
  esrLocal.install(ecldState, { caller: CALLER, filePrefix: null });
  ecldState.setLocalCommitApply(null);
  await registry._sendCommit(ledger.keyHash, ledger.cid, 0, CALLER, 0);
  assert.equal(ecldState.ledgerAttestation().commits.length, 1);
});

test('the commit cap counts the held records of the open step', async () => {
  const { ecldState, registry } = setup();
  const [ledger] = FIXTURE.steps.withCommits.envelope.esr.commits;
  ecldState.beginStep();
  for (let i = 0; i < 256; i += 1) await registry._sendCommit(ledger.keyHash, ledger.cid, i, CALLER, 0);
  await assert.rejects(registry.commit('ledger', () => ({})), ecldState.StateLimitError);
});
