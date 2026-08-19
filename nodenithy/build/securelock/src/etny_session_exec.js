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
const { TaskStatus } = require('./task_status');

const HANDLER_NAME = '___etny_on_input___';
const HANDLER_GRACE_MS = 30000;
const TICK_MS = 2000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
        const handler = this.scope[HANDLER_NAME];
        if (typeof handler !== 'function') {
            // No silent fallback: a payload without a handler is not
            // session-aware, so every input gets an explicit, acked error.
            return [Number(TaskStatus.PAYLOAD_NOT_DEFINED),
                'SESSION_HANDLER_NOT_DEFINED: this payload defines no ' +
                '___etny_on_input___ handler, so streamed inputs cannot be ' +
                'processed. Define ___etny_on_input___ = async (data) => ... ' +
                'in the payload and republish.'];
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
        await this.app.encryptFileAndPushToSwiftStream(envelope, `session.output.${this.emitted}`);
        this.emitted += 1;
    }

    async closeRequested() {
        try {
            const r = await this.app.swiftStreamService.isObjectInBucket(
                this.app.etny_bucket, 'session.control.securelock');
            return Boolean(r[1]);
        } catch (e) {
            return false;
        }
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
                handler: typeof this.scope[HANDLER_NAME] === 'function',
            });
            await this.app.encryptFileAndPushToSwiftStream(ready, 'session.ready');
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
            const data = await this.app.getFileContentAndDecrypt(this.app.etny_bucket, obj);
            if (data === false) {
                console.log(`session: input ${nextSeq} failed to decrypt; retrying`);
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
        const raw = await app.getFileContentAndDecrypt(app.etny_bucket, 'session.config.securelock');
        if (raw === false) throw new Error('session config not readable');
        const config = JSON.parse(String(raw));
        return await new SecureLockSession(app, config).run(payloadData, inputData);
    } catch (e) {
        console.error('session executor failed:', e && e.message ? e.message : e);
        return [TaskStatus.SYSTEM_ERROR, `SESSION EXECUTOR ERROR: ${e && e.message ? e.message : e}`];
    }
}

module.exports = { runSession, SecureLockSession };
