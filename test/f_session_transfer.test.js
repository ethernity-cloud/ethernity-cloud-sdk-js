// The transfer control and the fence signal in the nodenithy securelock's
// session executor (PHASE-D-PLAN.md WS-F.3, the securelock side of F.4): a
// signed transfer on session.control mid-step stops the step, stages no
// output, no commit file and no result, discards the held records and closes
// the registry, so a commit the cut handler issues afterwards is refused; a
// transfer between inputs does the same; a close after a finished step keeps
// the summary result and closes the registry, so a handler hung past the
// close writes nothing more; a control that does not verify is ignored; the
// held commits of a session that fails before any output are staged as a
// plain task's (A25); before its first input the session waits for
// session.fence, bounded by READY_WINDOW: on an order the config marks
// reserved whatever else is staged, ending the task without it; otherwise
// until session.input.0 or a control is present without one (the
// trustedzone writes the fence before the input on every reserved order);
// a fence with a bound is applied; a fence that does not verify ends the
// session; the fence verifier reproduces
// test/fixtures/session-fence.json. The chain and the bucket are esr_local's
// stand-ins, the clock node:test's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshModules, p384KeyPair, StubApp, settle, cryptoStub } = require('./helpers/securelock_app');

const BUCKET = 'ecld-local';
const CALLER = '0x5d4e1b3cf4ad01a7c7a9c1f6a2d4e8b9c0f1a2b3';
const ORDER_ID = 4101;
const CHALLENGE = 'k7p2x9qv4m1zr8t3hw6n';
const FENCE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'session-fence.json'), 'utf8'));
const TZ_KEY = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'capability-record.json'), 'utf8')).trustedzoneKey;

// A session payload: the handler commits once per input and, on 'slow',
// holds the step for five seconds.
const PAYLOAD = `
ecld.onInput = async (data) => {
  await ecld.state.commit('counter', (s) => ({ n: ((s || {}).n || 0) + 1 }));
  if (data === 'slow') await new Promise((r) => setTimeout(r, 5000));
  return 'done ' + data;
};
'context'`;

// A handler that commits only after the given wait.
const lateCommitPayload = (waitMs) => `
ecld.onInput = async (data) => {
  await new Promise((r) => setTimeout(r, ${waitMs}));
  await ecld.state.commit('counter', (s) => ({ n: ((s || {}).n || 0) + 1 }));
  return 'late ' + data;
};
'context'`;

// A payload that commits while its context is created, then fails.
const FAILING_BOOT_PAYLOAD = `
(async () => {
  await ecld.state.commit('boot', () => ({ ready: true }));
  throw new Error('boot failed');
})()`;

// A payload that commits while its context is created and defines a handler.
const COMMITTING_BOOT_PAYLOAD = `
ecld.onInput = async (data) => 'done ' + data;
(async () => { await ecld.state.commit('boot', () => ({ ready: true })); })()`;

async function setup(t, { maxMessages = 256, closeAfterSeconds = 3600, inputCutoffSeconds = 3000, reserved = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const mods = freshModules();
  const { ecldState, esrLocal } = mods;
  const { swift, contract } = esrLocal.install(ecldState, { caller: CALLER, filePrefix: null });
  const pending = [];
  ecldState.setLocalCommitApply((...commit) => { pending.push(commit); });
  const app = new StubApp({
    swift, bucket: BUCKET, orderId: ORDER_ID, challenge: CHALLENGE, caller: CALLER,
    trustedzone: p384KeyPair(), securelock: p384KeyPair(),
  });
  const config = { order_id: ORDER_ID, close_after_seconds: closeAfterSeconds, input_cutoff_seconds: inputCutoffSeconds, max_messages: maxMessages };
  if (reserved) config.reserved = true;
  await app.stageFromTrustedzone(JSON.stringify(config), 'session.config');
  return { ...mods, swift, contract, pending, app };
}

const outputs = (names) => names.filter((n) => /^session\.output\.\d+\.securelock$/.test(n));
const commitFiles = (names) => names.filter((n) => n.startsWith('session.commit.') || n.startsWith('esr.'));
const stateBlobs = (names) => names.filter((n) => n.startsWith('state.'));

async function ticks(t, n, ms = 2000) {
  for (let i = 0; i < n; i += 1) {
    t.mock.timers.tick(ms);
    await settle();
  }
}

async function assertClosed(ecldState) {
  await assert.rejects(new ecldState.StateRegistry().commit('counter', () => ({ n: 0 })), ecldState.StatePermissionError);
}

test('a transfer staged mid-step stops the step: no output, no commit file, no result, the held records discarded, the registry closed', async (t) => {
  const { ecldState, sessionExec, app } = await setup(t);
  await app.stageFromTrustedzone('slow', 'session.input.0');
  const result = sessionExec.runSession(app, PAYLOAD, '');
  await settle();
  let names = await app.names();
  assert.ok(names.includes('session.ready.securelock'));
  assert.deepEqual(commitFiles(names), [], 'the step\'s commit is held');
  await app.stageFromTrustedzone('transfer', 'session.control');
  await ticks(t, 1);
  assert.equal(await result, sessionExec.TRANSFERRED);
  names = await app.names();
  assert.deepEqual(outputs(names), []);
  assert.deepEqual(commitFiles(names), []);
  assert.deepEqual(ecldState.ledgerAttestation().commits, []);
  await assertClosed(ecldState);
});

test('a commit the cut handler issues after the transfer is refused and nothing more is staged', async (t) => {
  const { ecldState, sessionExec, app } = await setup(t);
  await app.stageFromTrustedzone('x', 'session.input.0');
  const result = sessionExec.runSession(app, lateCommitPayload(5000), '');
  await settle();
  const before = await app.names();
  await app.stageFromTrustedzone('transfer', 'session.control');
  await ticks(t, 1);
  assert.equal(await result, sessionExec.TRANSFERRED);
  // The handler's wait ends during the idle tail; its commit is refused.
  await ticks(t, 4);
  const after = await app.names();
  assert.deepEqual(after.filter((n) => !before.includes(n)), ['session.control.sig.securelock', 'session.control.securelock']);
  assert.deepEqual(commitFiles(after), []);
  assert.deepEqual(stateBlobs(after), []);
  assert.deepEqual(ecldState.ledgerAttestation().commits, []);
});

test('a transfer between inputs ends the session the same way', async (t) => {
  const { ecldState, sessionExec, app } = await setup(t);
  await app.stageFromTrustedzone('transfer', 'session.control');
  const result = sessionExec.runSession(app, PAYLOAD, '');
  await settle();
  assert.equal(await result, sessionExec.TRANSFERRED);
  const names = await app.names();
  assert.deepEqual(outputs(names), []);
  assert.deepEqual(commitFiles(names), []);
  await assertClosed(ecldState);
});

test('a close after a finished step keeps the summary result, the step\'s commit staged with its output, the registry closed', async (t) => {
  const { ecldState, sessionExec, TaskStatus, app } = await setup(t);
  await app.stageFromTrustedzone('fast', 'session.input.0');
  const result = sessionExec.runSession(app, PAYLOAD, '');
  await settle();
  let names = await app.names();
  assert.deepEqual(outputs(names), ['session.output.0.securelock']);
  const envelope = JSON.parse(await app.object('session.output.0.securelock'));
  assert.equal(envelope.ack, 0);
  assert.equal(envelope.code, 0);
  assert.equal(envelope.data, 'done fast');
  assert.equal(envelope.commits.length, 1);
  assert.match(envelope.commits[0], /^session\.commit\.0\.[0-9a-f]{16}\.0\.json$/);
  assert.ok(names.includes(envelope.commits[0]));
  assert.equal(await app.object(envelope.commits[0]), JSON.stringify(envelope.esr.commits[0]));
  assert.equal(await app.object('esr.authorizations.json'), JSON.stringify(envelope.esr.commits));
  assert.equal(envelope.esr.wallet, new ecldState.StateRegistry().walletAddress.toLowerCase());
  await app.stageFromTrustedzone('close', 'session.control');
  await ticks(t, 1);
  const [code, summary] = await result;
  assert.equal(code, TaskStatus.SUCCESS);
  assert.deepEqual(JSON.parse(summary), { session: 'v1', reason: 'CLOSED', seen: 1, processed: 1, emitted: 1, unprocessed: [] });
  names = await app.names();
  assert.equal(commitFiles(names).length, 2, 'the commit file and esr.authorizations.json, nothing more');
  await assertClosed(ecldState);
});

test('a handler hung past the close leaves its input unprocessed; its commit after the session ended is refused', async (t) => {
  const { ecldState, sessionExec, TaskStatus, app } = await setup(t, { closeAfterSeconds: 40, inputCutoffSeconds: 30 });
  await app.stageFromTrustedzone('x', 'session.input.0');
  const result = sessionExec.runSession(app, lateCommitPayload(60000), '');
  await settle();
  await ticks(t, 21);
  const [code, summary] = await result;
  assert.equal(code, TaskStatus.SUCCESS);
  assert.deepEqual(JSON.parse(summary), { session: 'v1', reason: 'RUNNING_PERIOD_COMPLETE', seen: 1, processed: 0, emitted: 0, unprocessed: [0] });
  await ticks(t, 12);
  const names = await app.names();
  assert.deepEqual(outputs(names), []);
  assert.deepEqual(commitFiles(names), []);
  assert.deepEqual(stateBlobs(names), []);
  assert.deepEqual(ecldState.ledgerAttestation().commits, []);
});

test('a control that does not verify against the trustedzone key is ignored', async (t) => {
  const { sessionExec, TaskStatus, app } = await setup(t, { maxMessages: 1 });
  await app.stageFromTrustedzone('transfer', 'session.control', { signer: p384KeyPair() });
  await app.stageFromTrustedzone('fast', 'session.input.0');
  const result = sessionExec.runSession(app, PAYLOAD, '');
  await settle();
  const [code, summary] = await result;
  assert.equal(code, TaskStatus.SUCCESS);
  assert.equal(JSON.parse(summary).reason, 'MESSAGE_CAP');
  assert.deepEqual(outputs(await app.names()), ['session.output.0.securelock']);
});

test('a failing initial run that committed stages its commits as a plain task does', async (t) => {
  const { ecldState, sessionExec, TaskStatus, app } = await setup(t);
  const [code, message] = await sessionExec.runSession(app, FAILING_BOOT_PAYLOAD, '');
  assert.equal(code, TaskStatus.BASE_EXCEPTION);
  assert.match(message, /boot failed/);
  const names = await app.names();
  assert.deepEqual(commitFiles(names).sort(), ['esr.authorizations.json', `esr.commit.${require('ethers').ethers.utils.id('boot').slice(2, 18)}.0.json`]);
  assert.deepEqual(outputs(names), []);
  const records = ecldState.ledgerAttestation().commits;
  assert.equal(records.length, 1);
  assert.equal(await app.object('esr.authorizations.json'), JSON.stringify(records));
  await assertClosed(ecldState);
});

test('a session the executor fails before any output stages the held commits', async (t) => {
  const { ecldState, sessionExec, TaskStatus, app } = await setup(t);
  await stageFence(app, { order_id: ORDER_ID, bound: 5, kind: 'none' });
  const [code, message] = await sessionExec.runSession(app, COMMITTING_BOOT_PAYLOAD, '');
  assert.equal(code, TaskStatus.SYSTEM_ERROR);
  assert.match(message, /bound 0 goes with kind none alone/);
  assert.equal(commitFiles(await app.names()).length, 2);
  assert.equal(ecldState.ledgerAttestation().commits.length, 1);
  await assertClosed(ecldState);
});

test('with neither fence nor input the session waits READY_WINDOW, then serves an input staged without a fence', async (t) => {
  const { sessionExec, TaskStatus, app } = await setup(t, { maxMessages: 1 });
  const result = sessionExec.runSession(app, PAYLOAD, '');
  await settle();
  await ticks(t, 91);
  assert.deepEqual(outputs(await app.names()), []);
  await app.stageFromTrustedzone('fast', 'session.input.0');
  await ticks(t, 2);
  const [code, summary] = await result;
  assert.equal(code, TaskStatus.SUCCESS);
  assert.equal(JSON.parse(summary).reason, 'MESSAGE_CAP');
  assert.deepEqual(outputs(await app.names()), ['session.output.0.securelock']);
});

async function stageFence(app, signal) {
  const plaintext = JSON.stringify(signal);
  await app.stageFromTrustedzone(plaintext, 'session.fence', { binding: `${CHALLENGE}:${ORDER_ID}:session.fence:` });
}

test('an order the config marks reserved waits for the fence whatever else is staged and ends the task when the window passes without it', async (t) => {
  const { ecldState, sessionExec, TaskStatus, app } = await setup(t, { reserved: true });
  await app.stageFromTrustedzone('fast', 'session.input.0');
  const result = sessionExec.runSession(app, COMMITTING_BOOT_PAYLOAD, '');
  await settle();
  await ticks(t, 80);
  assert.deepEqual(outputs(await app.names()), [], 'no input read before the fence');
  await ticks(t, 11);
  const [code, message] = await result;
  assert.equal(code, TaskStatus.SYSTEM_ERROR);
  assert.match(message, /SESSION FENCE ERROR: session\.fence not staged within 180 s/);
  const names = await app.names();
  assert.deepEqual(outputs(names), []);
  // The boot commit is staged as a plain task's (A25) and the registry closed.
  assert.equal(commitFiles(names).length, 2);
  await assertClosed(ecldState);
});

test('an order the config marks reserved reads its first input once the fence is staged after it', async (t) => {
  const { ecldState, sessionExec, app } = await setup(t, { reserved: true, maxMessages: 1 });
  const fence = t.mock.method(ecldState, 'fence', async () => []);
  await app.stageFromTrustedzone('fast', 'session.input.0');
  const result = sessionExec.runSession(app, PAYLOAD, '');
  await settle();
  await ticks(t, 3);
  assert.deepEqual(outputs(await app.names()), []);
  await stageFence(app, { order_id: ORDER_ID, bound: 52646961, kind: 'resultBlock' });
  await ticks(t, 2);
  const [code] = await result;
  assert.equal(code, 0);
  assert.deepEqual(fence.mock.calls[0].arguments, [52646961]);
  assert.deepEqual(outputs(await app.names()), ['session.output.0.securelock']);
});

test('the fence staged before the first input is applied: kind none fences nothing and the input follows', async (t) => {
  const { ecldState, sessionExec, app } = await setup(t, { maxMessages: 1 });
  const fence = t.mock.method(ecldState, 'fence');
  const result = sessionExec.runSession(app, PAYLOAD, '');
  await settle();
  await ticks(t, 1);
  await stageFence(app, { order_id: ORDER_ID, bound: 0, kind: 'none' });
  await ticks(t, 1);
  assert.deepEqual(outputs(await app.names()), []);
  await app.stageFromTrustedzone('fast', 'session.input.0');
  await ticks(t, 2);
  const [code] = await result;
  assert.equal(code, 0);
  assert.equal(fence.mock.callCount(), 0);
  assert.deepEqual(outputs(await app.names()), ['session.output.0.securelock']);
});

test('a fence with a bound re-commits the registry before the first input', async (t) => {
  const { ecldState, sessionExec, app } = await setup(t, { maxMessages: 1 });
  const fence = t.mock.method(ecldState, 'fence', async () => []);
  await stageFence(app, { order_id: ORDER_ID, bound: 52646961, kind: 'toBlock' });
  await app.stageFromTrustedzone('fast', 'session.input.0');
  const result = sessionExec.runSession(app, PAYLOAD, '');
  await settle();
  const [code] = await result;
  assert.equal(code, 0);
  assert.equal(fence.mock.callCount(), 1);
  assert.deepEqual(fence.mock.calls[0].arguments, [52646961]);
  assert.deepEqual(outputs(await app.names()), ['session.output.0.securelock']);
});

test('a fence signed over the plaintext alone ends the session with an executor error at once', async (t) => {
  const { sessionExec, TaskStatus, app } = await setup(t);
  await app.stageFromTrustedzone(JSON.stringify({ order_id: ORDER_ID, bound: 0, kind: 'none' }), 'session.fence');
  const result = sessionExec.runSession(app, PAYLOAD, '');
  await settle();
  const [code, message] = await result;
  assert.equal(code, TaskStatus.SYSTEM_ERROR);
  assert.match(message, /SESSION EXECUTOR ERROR: trustedzone signature INVALID for session\.fence/);
  assert.deepEqual(outputs(await app.names()), []);
});

test('a malformed fence ends the session with an executor error', async (t) => {
  const { sessionExec, TaskStatus, app } = await setup(t);
  await stageFence(app, { order_id: ORDER_ID, bound: 5, kind: 'none' });
  const result = sessionExec.runSession(app, PAYLOAD, '');
  await settle();
  const [code, message] = await result;
  assert.equal(code, TaskStatus.SYSTEM_ERROR);
  assert.match(message, /bound 0 goes with kind none alone/);
});

test('the fence verifier reproduces session-fence.json under the fixture trustedzone key', async () => {
  const { sessionExec, esrLocal } = freshModules();
  for (const name of ['toBlock', 'resultBlock', 'none']) {
    const example = FENCE.examples[name];
    const swift = new esrLocal.MemSwift(null);
    const app = new StubApp({
      swift, bucket: BUCKET, orderId: example.orderId, challenge: CHALLENGE, caller: CALLER,
      trustedzone: TZ_KEY, securelock: p384KeyPair(),
    });
    assert.equal(`${CHALLENGE}:${example.orderId}:session.fence:${example.plaintext}`, example.signedText);
    assert.ok(cryptoStub.verifySignature(TZ_KEY.publicKeyPem, example.signedText, example.signatureDerHex));
    assert.equal(await sessionExec.getVerifiedFence(app), false, 'absent');
    await swift.putFileContent(BUCKET, FENCE.objects.nodenithy.signature, '', example.signatureDerHex);
    await swift.putFileContent(BUCKET, FENCE.objects.nodenithy.fence, '', example.plaintext);
    assert.deepEqual(await sessionExec.getVerifiedFence(app), { order_id: example.orderId, bound: example.bound, kind: example.kind });
    app.task_binding = { order_id: example.orderId, challenge: 'another-challenge' };
    await assert.rejects(sessionExec.getVerifiedFence(app), /signature INVALID/);
    app.task_binding = null;
    await assert.rejects(sessionExec.getVerifiedFence(app), /no task binding/);
  }
  assert.equal(FENCE.objects.nodenithy.fence, 'session.fence.securelock');
  assert.equal(FENCE.objects.nodenithy.signature, 'session.fence.sig.securelock');
  assert.equal(sessionExec.READY_WINDOW_SECONDS, FENCE.timing.readyWindowSeconds);
});

test('parseFence refuses any other key set, type or kind', () => {
  const { sessionExec } = freshModules();
  const { parseFence } = sessionExec;
  assert.deepEqual(parseFence('{"order_id":4101,"bound":7,"kind":"resultBlock"}', 4101), { order_id: 4101, bound: 7, kind: 'resultBlock' });
  assert.throws(() => parseFence('{"bound":7,"order_id":4101,"kind":"toBlock"}', 4101), /exactly the keys/);
  assert.throws(() => parseFence('{"order_id":4101,"bound":7,"kind":"toBlock","x":1}', 4101), /exactly the keys/);
  assert.throws(() => parseFence('{"order_id":4100,"bound":7,"kind":"toBlock"}', 4101), /names order 4100/);
  assert.throws(() => parseFence('{"order_id":4101,"bound":"7","kind":"toBlock"}', 4101), /not a block number/);
  assert.throws(() => parseFence('{"order_id":4101,"bound":7,"kind":"later"}', 4101), /kind later/);
  assert.throws(() => parseFence('{"order_id":4101,"bound":0,"kind":"toBlock"}', 4101), /bound 0 goes with kind none alone/);
  assert.throws(() => parseFence('[]', 4101), /not an object/);
});
