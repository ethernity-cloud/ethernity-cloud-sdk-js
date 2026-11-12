'use strict';
// The securelock's heartbeat and ready object (spec/heartbeat.json). At boot
// the securelock draws a 32-byte key, announces it to the trustedzone in
// securelock.ready (encrypted for the trustedzone, signed over the task
// binding) and then overwrites securelock.heartbeat once per second with a
// fixed-size AES-256-GCM record under that key: the trustedzone reads busy,
// runs and phase from it to gate its probes. Nothing here starts a timer on
// require: a probe runs only once start() is called.

const crypto = require('crypto');

const HEARTBEAT_BASE = 'securelock.heartbeat';
const READY_BASE = 'securelock.ready';
// Every object the JS securelock writes carries the .securelock suffix.
const HEARTBEAT_OBJECT = `${HEARTBEAT_BASE}.securelock`;
const READY_OBJECT = `${READY_BASE}.securelock`;
const READY_SIGNATURE_OBJECT = `${READY_BASE}.sig.securelock`;

const HEARTBEAT_PERIOD_MS = 1000;
// Beats with busy 0 and phase E written before the process exits, one per
// second (PHASE-D-PLAN.md section 12, IDLE_TAIL_SECONDS).
const IDLE_TAIL_SECONDS = 10;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const PLAINTEXT_BYTES = 32;
const TAG_BYTES = 16;
const BODY_BYTES = NONCE_BYTES + PLAINTEXT_BYTES + TAG_BYTES;
const SEQ0 = 1;
const SEQ_CHARS = 10;
const RUNS_CHARS = 6;
const PHASES = new Set(['B', 'T', 'S', 'E']);

// <challenge>:<order_id>:securelock.heartbeat, the same in both stacks.
function aad(challenge, orderId) {
    return `${challenge}:${orderId}:${HEARTBEAT_BASE}`;
}

// ecld-hb|v1|<seq 10>|<busy 1>|<runs 6>|<phase 1>, 32 bytes.
function beatRecord(seq, busy, runs, phase) {
    if (!Number.isInteger(seq) || seq < 0 || seq >= 10 ** SEQ_CHARS) throw new Error(`heartbeat seq ${seq} does not fit ${SEQ_CHARS} digits`);
    if (busy !== 0 && busy !== 1) throw new Error(`heartbeat busy ${busy} is not 0 or 1`);
    if (!Number.isInteger(runs) || runs < 0 || runs >= 10 ** RUNS_CHARS) throw new Error(`heartbeat runs ${runs} does not fit ${RUNS_CHARS} digits`);
    if (!PHASES.has(phase)) throw new Error(`heartbeat phase ${phase} is not one of B, T, S, E`);
    const record = `ecld-hb|v1|${String(seq).padStart(SEQ_CHARS, '0')}|${busy}|${String(runs).padStart(RUNS_CHARS, '0')}|${phase}`;
    if (Buffer.byteLength(record, 'utf8') !== PLAINTEXT_BYTES) throw new Error('heartbeat record is not 32 bytes');
    return record;
}

// The nonce of beat `seq`: seq as a big-endian unsigned integer in the low 8
// bytes, the 4 leading bytes zero.
function beatNonce(seq) {
    const nonce = Buffer.alloc(NONCE_BYTES);
    nonce.writeBigUInt64BE(BigInt(seq), 4);
    return nonce;
}

// nonce (12) || ciphertext (32) || tag (16): the 60-byte beat body.
function encryptBeat(key, seq, record, aadText) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('heartbeat key is not 32 bytes');
    const nonce = beatNonce(seq);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(String(aadText), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(record, 'utf8')), cipher.final()]);
    const body = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
    if (body.length !== BODY_BYTES) throw new Error(`heartbeat body is ${body.length} bytes, not ${BODY_BYTES}`);
    return body;
}

// The securelock.ready plaintext: compact JSON with the keys order_id, key,
// seq0 in that order.
function readyPlaintext(orderId, keyHex, seq0) {
    return JSON.stringify({ order_id: orderId, key: keyHex, seq0 });
}

function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

class SecurelockProbe {
    // swiftStreamService and bucket take the beats; challenge and orderId are
    // the task binding the trustedzone forwarded in task.securelock.
    constructor({ swiftStreamService, bucket, challenge, orderId, key = null }) {
        this.swift = swiftStreamService;
        this.bucket = bucket;
        this.orderId = Number(orderId);
        this.key = key || crypto.randomBytes(KEY_BYTES);
        if (!Buffer.isBuffer(this.key) || this.key.length !== KEY_BYTES) throw new Error('heartbeat key is not 32 bytes');
        this.aad = aad(challenge, this.orderId);
        this.seq = SEQ0;
        this.busy = 0;
        this.runs = 0;
        this.phase = 'B';
        this._timer = null;
        this._pending = null;
        this._stopped = false;
    }

    readyPlaintext() {
        return readyPlaintext(this.orderId, this.key.toString('hex'), SEQ0);
    }

    // Stages securelock.ready through `push(data, baseName)`, the securelock's
    // signed and encrypted put for the trustedzone, before any beat is written.
    async publishReady(push) {
        await push(this.readyPlaintext(), READY_BASE);
    }

    // The first beat at once, then one per second, as the Python securelock
    // beats. A tick that finds the previous put still in flight is skipped,
    // never queued.
    start() {
        if (this._timer || this._stopped) return;
        this._tick();
        this._timer = setInterval(() => this._tick(), HEARTBEAT_PERIOD_MS);
    }

    _tick() {
        if (this._pending) return;
        this._pending = this._put().catch((e) => {
            console.log('heartbeat: put failed:', e && e.message ? e.message : e);
        }).finally(() => { this._pending = null; });
    }

    // Writes the beat of the current seq and advances it: a seq is never
    // reused under one key, whether or not the put succeeds.
    async _put() {
        const record = beatRecord(this.seq, this.busy, this.runs, this.phase);
        const body = encryptBeat(this.key, this.seq, record, this.aad);
        this.seq += 1;
        await this.swift.putFileContent(this.bucket, HEARTBEAT_OBJECT, '', body.toString('base64'));
    }

    // A payload run starts: busy 1, runs + 1, the run's phase (T or S).
    busyStart(phase) {
        this.phase = phase;
        this.busy = 1;
        this.runs += 1;
    }

    busyEnd() {
        this.busy = 0;
    }

    // Ends the periodic beats and writes the idle tail: IDLE_TAIL_SECONDS
    // beats with busy 0 and phase E, each awaited and followed by a second's
    // wait, IDLE_TAIL_SECONDS of beats in all. Runs once; later calls return
    // at once.
    async stop() {
        if (this._stopped) return;
        this._stopped = true;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._pending) await this._pending;
        this.busy = 0;
        this.phase = 'E';
        for (let i = 0; i < IDLE_TAIL_SECONDS; i += 1) {
            try {
                await this._put();
            } catch (e) {
                console.log('heartbeat: tail put failed:', e && e.message ? e.message : e);
            }
            await sleep(HEARTBEAT_PERIOD_MS);
        }
    }
}

module.exports = {
    SecurelockProbe,
    HEARTBEAT_OBJECT,
    READY_OBJECT,
    READY_SIGNATURE_OBJECT,
    READY_BASE,
    HEARTBEAT_PERIOD_MS,
    IDLE_TAIL_SECONDS,
    BODY_BYTES,
    SEQ0,
    aad,
    beatRecord,
    beatNonce,
    encryptBeat,
    readyPlaintext,
};
