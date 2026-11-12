// The nodenithy securelock's heartbeat and ready object (PHASE-D-PLAN.md
// WS-F.1) against test/fixtures/heartbeat.json: the beats reproduced from
// key, seq, record and AAD, the 60-byte body, the nonce equal to the seq, the
// ready plaintext; a MemSwift-backed probe under node:test's mock timers: the
// first beat at start, then one per second, a tick skipped while a put is in
// flight, the busy edges, the idle tail on stop (ten beats over ten
// seconds); and the template's wiring: the binding and the probe before the
// payload wait, the put awaited, the tail on every exit path.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { SRC, freshModules, settle } = require('./helpers/securelock_app');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'heartbeat.json'), 'utf8'));
const KEY = Buffer.from(FIXTURE.key.hex, 'hex');
const AAD = FIXTURE.aad.value;
const BUCKET = 'ecld-local';

// The trustedzone's reading of a beat: the nonce from the body, the AAD, the
// plaintext's fixed widths.
function decodeBeat(bodyBase64, key, aad) {
  const body = Buffer.from(bodyBase64, 'base64');
  assert.equal(body.length, 60);
  const nonce = body.subarray(0, 12);
  const ciphertext = body.subarray(12, 44);
  const tag = body.subarray(44);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const m = /^ecld-hb\|v1\|([0-9]{10})\|([01])\|([0-9]{6})\|([BTSE])$/.exec(text);
  assert.ok(m, `not a heartbeat record: ${text}`);
  const seq = Number(m[1]);
  assert.equal(nonce.readUInt32BE(0), 0);
  assert.equal(nonce.readBigUInt64BE(4), BigInt(seq));
  return { seq, busy: Number(m[2]), runs: Number(m[3]), phase: m[4], text };
}

test('the fixture beats are reproduced from key, seq, record and AAD', () => {
  const { probe } = freshModules();
  assert.equal(probe.aad(FIXTURE.order.challenge, FIXTURE.order.orderId), AAD);
  for (const name of ['idle', 'busy']) {
    const beat = FIXTURE.beats[name];
    const record = probe.beatRecord(beat.seq, beat.busy, beat.runs, beat.phase);
    assert.equal(record, beat.plaintext);
    assert.equal('0x' + Buffer.from(record, 'utf8').toString('hex'), beat.plaintextHex);
    assert.equal('0x' + probe.beatNonce(beat.seq).toString('hex'), beat.nonceHex);
    const body = probe.encryptBeat(KEY, beat.seq, record, AAD);
    assert.equal(body.length, beat.bodyBytes);
    assert.equal(body.length, probe.BODY_BYTES);
    assert.equal('0x' + body.subarray(12, 44).toString('hex'), beat.ciphertextHex);
    assert.equal('0x' + body.subarray(44).toString('hex'), beat.tagHex);
    const base64 = body.toString('base64');
    assert.equal(base64.length, 80);
    assert.equal(base64, beat.bodyBase64);
    assert.deepEqual(decodeBeat(base64, KEY, AAD), { seq: beat.seq, busy: beat.busy, runs: beat.runs, phase: beat.phase, text: beat.plaintext });
  }
});

test('the ready plaintext is the fixture\'s bytes and names the fixture objects', () => {
  const { probe } = freshModules();
  assert.equal(probe.readyPlaintext(FIXTURE.ready.fields.order_id, FIXTURE.ready.fields.key, FIXTURE.ready.fields.seq0), FIXTURE.ready.plaintext);
  assert.equal(probe.SEQ0, FIXTURE.ready.fields.seq0);
  assert.equal(probe.HEARTBEAT_OBJECT, FIXTURE.objects.nodenithy.heartbeat);
  assert.equal(probe.READY_OBJECT, FIXTURE.objects.nodenithy.ready);
  assert.equal(probe.READY_SIGNATURE_OBJECT, FIXTURE.objects.nodenithy.readySignature);
  const p = new probe.SecurelockProbe({ swiftStreamService: null, bucket: BUCKET, challenge: FIXTURE.order.challenge, orderId: FIXTURE.order.orderId, key: KEY });
  assert.equal(p.readyPlaintext(), FIXTURE.ready.plaintext);
  assert.equal(p.aad, AAD);
});

test('a record outside the widths or the phases is refused', () => {
  const { probe } = freshModules();
  assert.throws(() => probe.beatRecord(10 ** 10, 0, 0, 'B'), /seq/);
  assert.throws(() => probe.beatRecord(1, 2, 0, 'B'), /busy/);
  assert.throws(() => probe.beatRecord(1, 0, 10 ** 6, 'B'), /runs/);
  assert.throws(() => probe.beatRecord(1, 0, 0, 'X'), /phase/);
  assert.throws(() => probe.encryptBeat(Buffer.alloc(16), 1, probe.beatRecord(1, 0, 0, 'B'), AAD), /32 bytes/);
});

function probeSetup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { probe, esrLocal } = freshModules();
  const swift = new esrLocal.MemSwift(null);
  const puts = [];
  const put = swift.putFileContent.bind(swift);
  swift.putFileContent = async (bucket, name, prefix, data) => {
    puts.push({ name, data });
    return put(bucket, name, prefix, data);
  };
  const p = new probe.SecurelockProbe({ swiftStreamService: swift, bucket: BUCKET, challenge: FIXTURE.order.challenge, orderId: FIXTURE.order.orderId, key: KEY });
  const beats = () => puts.filter((x) => x.name === probe.HEARTBEAT_OBJECT).map((x) => decodeBeat(x.data, KEY, AAD));
  return { probe, swift, p, puts, beats };
}

test('requiring the module and building a probe starts no timer and writes nothing', (t) => {
  const { p, puts } = probeSetup(t);
  assert.equal(p._timer, null);
  t.mock.timers.tick(5000);
  assert.deepEqual(puts, []);
});

test('the ready object is staged through the signed push before any beat, then the first beat at start and one per second', async (t) => {
  const { probe, p, puts, beats } = probeSetup(t);
  const pushed = [];
  await p.publishReady(async (data, baseName) => { pushed.push([baseName, data]); });
  assert.deepEqual(pushed, [[probe.READY_BASE, FIXTURE.ready.plaintext]]);
  assert.deepEqual(puts, []);
  p.start();
  await settle();
  assert.deepEqual(beats().map((b) => b.seq), [1], 'the first beat is written at start');
  for (let i = 0; i < 2; i += 1) {
    t.mock.timers.tick(1000);
    await settle();
  }
  const seen = beats();
  assert.deepEqual(seen.map((b) => [b.seq, b.busy, b.runs, b.phase]), [[1, 0, 0, 'B'], [2, 0, 0, 'B'], [3, 0, 0, 'B']]);
  // The object is overwritten in place: one object, its size never changing.
  assert.equal(puts.filter((x) => x.name === probe.HEARTBEAT_OBJECT).every((x) => x.data.length === 80), true);
});

test('a tick while the previous put is in flight is skipped, never queued', async (t) => {
  const { swift, p, beats } = probeSetup(t);
  const put = swift.putFileContent;
  let release = null;
  swift.putFileContent = (bucket, name, prefix, data) => new Promise((resolve) => {
    release = () => resolve(put(bucket, name, prefix, data));
  });
  p.start();
  await settle();
  assert.equal(typeof release, 'function');
  const first = release;
  release = null;
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(release, null, 'no second put while the first is in flight');
  first();
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(typeof release, 'function');
  release();
  await settle();
  // The skipped ticks consumed no seq: the beats are 1 and 2.
  assert.deepEqual(beats().map((b) => b.seq), [1, 2]);
});

test('busy turns 1 with runs + 1 at a payload start and 0 at its end, the phase that of the run', async (t) => {
  const { p, beats } = probeSetup(t);
  p.start();
  await settle();
  p.busyStart('T');
  t.mock.timers.tick(1000);
  await settle();
  p.busyEnd();
  t.mock.timers.tick(1000);
  await settle();
  p.busyStart('S');
  t.mock.timers.tick(1000);
  await settle();
  p.busyEnd();
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(beats().map((b) => [b.seq, b.busy, b.runs, b.phase]),
    [[1, 0, 0, 'B'], [2, 1, 1, 'T'], [3, 0, 1, 'T'], [4, 1, 2, 'S'], [5, 0, 2, 'S']]);
});

test('stop ends the beats with the idle tail: ten beats of busy 0 and phase E, each followed by a second', async (t) => {
  const { probe, p, beats } = probeSetup(t);
  p.start();
  await settle();
  p.busyStart('T');
  t.mock.timers.tick(1000);
  await settle();
  const stopped = p.stop();
  let done = false;
  stopped.then(() => { done = true; });
  await settle();
  assert.equal(beats().length, 3, 'the first tail beat is written at once');
  for (let i = 0; i < probe.IDLE_TAIL_SECONDS - 1; i += 1) {
    t.mock.timers.tick(1000);
    await settle();
  }
  assert.equal(beats().length, 2 + probe.IDLE_TAIL_SECONDS, 'the tenth beat written after nine seconds');
  assert.equal(done, false, 'the tail ends a second after its last beat');
  t.mock.timers.tick(1000);
  await stopped;
  const seen = beats();
  assert.equal(seen.length, 2 + probe.IDLE_TAIL_SECONDS);
  assert.deepEqual(seen.slice(0, 2).map((b) => [b.busy, b.phase]), [[0, 'B'], [1, 'T']]);
  const tail = seen.slice(2);
  assert.deepEqual(tail.map((b) => [b.busy, b.runs, b.phase]), Array(probe.IDLE_TAIL_SECONDS).fill([0, 1, 'E']));
  assert.deepEqual(tail.map((b) => b.seq), Array.from({ length: probe.IDLE_TAIL_SECONDS }, (_, i) => 3 + i));
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(beats().length, seen.length, 'no beat after the tail');
  await p.stop();
  assert.equal(beats().length, seen.length, 'a second stop writes nothing');
});

test('a failed put is logged and the next beat follows with the next seq', async (t) => {
  const { swift, p, beats } = probeSetup(t);
  const put = swift.putFileContent;
  let fail = true;
  swift.putFileContent = async (...args) => {
    if (fail) { fail = false; throw new Error('store down'); }
    return put(...args);
  };
  const logs = [];
  t.mock.method(console, 'log', (...a) => { logs.push(a.join(' ')); });
  p.start();
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.ok(logs.some((l) => /heartbeat: put failed: store down/.test(l)));
  assert.deepEqual(beats().map((b) => b.seq), [2]);
});

test('the template loads the binding and starts the probe before the payload wait, awaits its puts and ends with the tail', () => {
  const tmpl = fs.readFileSync(path.join(SRC, 'securelock.js.tmpl'), 'utf8');
  const rendered = tmpl
    .replace(/__ETNY_CHAIN_ID__/g, '80002')
    .replace(/__ETNY_WEB3_PROVIDER__/g, 'http://rpc')
    .replace(/__ETNY_[A-Z_]+__/g, 'x')
    .replace(/__ENCLAVE_NAME_SECURELOCK__/g, 'name');
  assert.doesNotThrow(() => new vm.Script(rendered, { filename: 'securelock.js' }));
  assert.match(tmpl, /require\("\.\/securelock_probe"\)/);
  const main = tmpl.slice(tmpl.indexOf('async function execute()'));
  const at = (re) => { const i = main.search(re); assert.ok(i >= 0, String(re)); return i; };
  assert.ok(at(/await app\.loadTaskBinding\(\)/) < at(/await app\.startProbe\(\)/));
  assert.ok(at(/await app\.startProbe\(\)/) < at(/await app\.waitForPayloadAndInput\(\)/));
  assert.ok(at(/await app\.waitForPayloadAndInput\(\)/) < at(/await app\.execute\(\)/));
  assert.ok(at(/await reportFailure\(currentApp, e\)/) < at(/await currentApp\.stopProbe\(\)/));
  assert.match(main, /if \(app\.transferred\) \{/);
  assert.match(main, /currentApp\.transferred\) process\.exit\(0\)/);
  const push = tmpl.slice(tmpl.indexOf('async encryptFileAndPushToSwiftStream'), tmpl.indexOf('async getDORequestMetadata'));
  assert.match(push, /await this\.swiftStreamService\.putFileContent\(/);
  assert.doesNotMatch(push, /try \{/);
  const exec = tmpl.slice(tmpl.indexOf('async execute() {'), tmpl.indexOf('async function execute()'));
  assert.match(exec, /task_result === TRANSFERRED/);
  assert.match(exec, /this\.probe\.busyStart\('T'\)/);
  assert.match(exec, /this\.probe\.busyEnd\(\)/);
  assert.doesNotMatch(exec, /loadOrderMetadata/, 'the metadata is loaded before the payload wait, not in execute()');
  const binding = tmpl.slice(tmpl.indexOf('async loadTaskBinding()'), tmpl.indexOf('async startProbe()'));
  assert.match(binding, /await this\.loadOrderMetadata\(\)/);
  assert.match(binding, /await this\.getTrustedZonePublicKey\(\)/);
  assert.match(binding, /isObjectInBucket\(this\.etny_bucket, 'task\.securelock'\)/);
  const probe = tmpl.slice(tmpl.indexOf('async startProbe()'), tmpl.indexOf('async stopProbe()'));
  assert.match(probe, /if \(!this\.task_binding\) return;/);
  assert.match(probe, /await probe\.publishReady\(/);
  assert.match(probe, /probe\.start\(\)/);
});
