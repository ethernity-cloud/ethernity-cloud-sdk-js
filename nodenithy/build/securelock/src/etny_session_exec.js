"use strict";
/*
 * Interactive session executor for the securelock enclave (JS).
 *
 * Runs when the trustedzone staged 'session.config.securelock'. The payload
 * runs once to create its context; a handler it registered:
 *
 *     ___etny_on_input___ = async (data) => { ...; return "reply"; }
 *
 * is invoked per streamed input. A payload that defines no handler is not
 * session-aware: each input is answered with an explicit error output (no
 * silent re-execution fallback), so the developer sees the problem on the
 * first message.
 *
 * The TIMEOUT GUARD makes the running period ending a COMPLETION, not a
 * failure: armed from the attested close_after_seconds delta on the local
 * monotonic clock, it stops pulling inputs at the cutoff, bounds a hung
 * async handler with a grace race, and finalizes through the ordinary
 * result path with task code SUCCESS and a session summary (reason
 * RUNNING_PERIOD_COMPLETE / CLOSED / MESSAGE_CAP). Only a guard that never
 * returns is a genuine fault, refunded via the operator-fault flow.
 */

const etny_exec = require('./etny_exec');
const etny_crypto = require('./etny_crypto');
const { TaskStatus } = require('./task_status');

const HANDLER_NAME = '___etny_on_input___';
const HANDLER_GRACE_MS = 30000;
const TICK_MS = 2000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* THE HANDOFF INVARIANT (mirror of the trustedzone side): everything this
   enclave pushes for the trustedzone is SIGNED with its identity key, so the
   trustedzone authors metadata rows only from verified securelock material;
   everything read from the trustedzone is verified against the trustedzone's
   registry certificate before it is trusted. */

async function pushSignedForTrustedzone(app, data, baseName) {
    await app.encryptFileAndPushToSwiftStream(data, baseName);
    const sigHex = etny_crypto.signData(app.privateKeyMaterial(), data);
    await app.encryptFileAndPushToSwiftStream(sigHex, baseName + '.sig');
}

async function getVerifiedTrustedzoneObject(app, baseName) {
    const data = await app.getFileContentAndDecrypt(app.etny_bucket, baseName + '.securelock');
    if (data === false || data === null || data === undefined) return false;
    const sigHex = await app.getFileContentAndDecrypt(app.etny_bucket, baseName + '.sig.securelock');
    if (sigHex === false || sigHex === null || sigHex === undefined) {
        console.log(`session: no signature for ${baseName} -- refusing`);
        return false;
    }
    if (!etny_crypto.verifySignature(app.trustedZonePublicKey, String(data), String(sigHex))) {
        console.log(`session: trustedzone signature INVALID for ${baseName} -- refusing`);
        return false;
    }
    return String(data);
}

function render(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
}

class SecureLockSession {
    constructor(app, config) {
        this.app = app;
        this.orderId = Number(config.order_id);
        this.maxMessages = Number(config.max_messages || 256);
        const started = Date.now();
        this.closeAt = started + Number(config.close_after_seconds || 0) * 1000;
        this.cutoffAt = started + Number(config.input_cutoff_seconds || 0) * 1000;
        this.seen = 0;
        this.processed = 0;
        this.emitted = 0;
        this.unprocessed = [];
        this.reason = 'RUNNING_PERIOD_COMPLETE';
        this.scope = etny_exec.sessionBaseScope();
    }

    async initialRun(payloadData, inputData) {
        const [code, result] = await etny_exec.exec(payloadData, inputData, this.scope);
        console.log(`session: payload context created (code ${code})`);
        if (Number(code) !== Number(TaskStatus.SUCCESS)) {
            this.reason = 'PAYLOAD_SETUP_FAILED';
            return [code, result];
        }
        return null;
    }

    async handle(seq, data, payloadData) {
        const handler = etny_exec.resolveSessionHandler(this.scope);
        if (typeof handler !== 'function') {
            // No silent fallback: a payload without a handler is not
            // session-aware, so every input gets an explicit, acked error.
            return [Number(TaskStatus.PAYLOAD_NOT_DEFINED),
                'SESSION_HANDLER_NOT_DEFINED: this payload defines no session ' +
                'input handler, so streamed inputs cannot be processed. Set ' +
                'ecld.onInput = async (data) => ... (or the legacy ' +
                '___etny_on_input___) in the payload and republish.'];
        }
        const budget = Math.max(HANDLER_GRACE_MS, this.closeAt - Date.now());
        const work = (async () => {
            return [Number(TaskStatus.SUCCESS), render(await handler(data))];
        })();
        const timeout = sleep(budget).then(() => 'TIMEOUT');
        let outcome;
        try {
            outcome = await Promise.race([work, timeout]);
        } catch (e) {
            return [Number(TaskStatus.SYSTEM_ERROR), `SESSION HANDLER ERROR: ${e && e.message ? e.message : e}`];
        }
        if (outcome === 'TIMEOUT') {
            console.log(`session: handler hung on input ${seq}; abandoning`);
            this.unprocessed.push(seq);
            return null;
        }
        return outcome;
    }

    async emit(ackSeq, code, data) {
        const envelope = JSON.stringify({ ack: ackSeq, code: Number(code), data });
        await pushSignedForTrustedzone(this.app, envelope, `session.output.${this.emitted}`);
        this.emitted += 1;
    }

    async closeRequested() {
        try {
            const r = await this.app.swiftStreamService.isObjectInBucket(
                this.app.etny_bucket, 'session.control.securelock');
            if (!r[1]) return false;
        } catch (e) {
            return false;
        }
        // An unauthenticated close signal is ignored: the node could place an
        // object in the bucket, but only the trustedzone can SIGN one.
        const control = await getVerifiedTrustedzoneObject(this.app, 'session.control');
        return control !== false && String(control).trim() === 'close';
    }

    async run(payloadData, inputData) {
        const setupFailure = await this.initialRun(payloadData, inputData);
        if (setupFailure !== null) return setupFailure;
        // READINESS HANDSHAKE: tell the trustedzone this securelock speaks
        // the session protocol AND whether the payload defined an input
        // handler. A pre-session securelock never writes this (the
        // trustedzone answers every input with an explicit error), and a
        // handler-less payload is announced by the trustedzone as a signed
        // code-5 error row on the DP-request metadata side before any input
        // is even sent.
        try {
            const ready = JSON.stringify({
                ready: true,
                handler: typeof etny_exec.resolveSessionHandler(this.scope) === 'function',
            });
            await pushSignedForTrustedzone(this.app, ready, 'session.ready');
        } catch (e) {
            console.error('session: could not publish readiness:', e && e.message ? e.message : e);
        }
        let nextSeq = 0;
        for (;;) {
            const now = Date.now();
            if (now >= this.closeAt) { this.reason = 'RUNNING_PERIOD_COMPLETE'; break; }
            if (await this.closeRequested()) { this.reason = 'CLOSED'; break; }
            if (nextSeq >= this.maxMessages) { this.reason = 'MESSAGE_CAP'; break; }
            const obj = `session.input.${nextSeq}.securelock`;
            let present;
            try {
                const r = await this.app.swiftStreamService.isObjectInBucket(this.app.etny_bucket, obj);
                present = r[1];
            } catch (e) { present = false; }
            if (!present) { await sleep(TICK_MS); continue; }
            if (now >= this.cutoffAt) {
                // Delivered past the cutoff: the trustedzone answers these
                // with signed late notices; we only stop consuming.
                this.reason = 'RUNNING_PERIOD_COMPLETE';
                break;
            }
            const data = await getVerifiedTrustedzoneObject(this.app, `session.input.${nextSeq}`);
            if (data === false) {
                console.log(`session: input ${nextSeq} not verifiable yet; retrying`);
                await sleep(TICK_MS);
                continue;
            }
            this.seen += 1;
            const outcome = await this.handle(nextSeq, String(data), payloadData);
            if (outcome !== null) {
                const [code, out] = outcome;
                // Only successful handling counts as processed; error outputs
                // are still emitted+acked so the dApp sees them.
                if (Number(code) === Number(TaskStatus.SUCCESS)) this.processed += 1;
                await this.emit(nextSeq, code, out);
            }
            nextSeq += 1;
        }
        const summary = {
            session: 'v1',
            reason: this.reason,
            seen: this.seen,
            processed: this.processed,
            emitted: this.emitted,
            unprocessed: this.unprocessed,
        };
        console.log('session: finalizing --', JSON.stringify(summary));
        return [TaskStatus.SUCCESS, JSON.stringify(summary)];
    }
}

/* Entry point used by securelock.execute(). Any unexpected failure degrades
   to an ordinary task error, never a hang. */
async function runSession(app, payloadData, inputData) {
    try {
        // The trustedzone certificate anchors every verification below.
        if (!app.trustedZonePublicKey) {
            await app.getTrustedZonePublicKey();
        }
        const raw = await getVerifiedTrustedzoneObject(app, 'session.config');
        if (raw === false) throw new Error('session config not verifiable');
        const config = JSON.parse(String(raw));
        return await new SecureLockSession(app, config).run(payloadData, inputData);
    } catch (e) {
        console.error('session executor failed:', e && e.message ? e.message : e);
        return [TaskStatus.SYSTEM_ERROR, `SESSION EXECUTOR ERROR: ${e && e.message ? e.message : e}`];
    }
}

module.exports = { runSession, SecureLockSession };
