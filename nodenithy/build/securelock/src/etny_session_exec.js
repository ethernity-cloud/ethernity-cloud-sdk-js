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
 *
 * A step's ESR commits are held (ecld_state.beginStep) and staged with the
 * step's output as session.commit.<n>.<key16>.<relayNonce>.json, named in
 * the output's signed envelope {ack, code, data, commits, esr: {wallet,
 * commits}} with their signed records (spec/session-commits.json). The
 * trustedzone writes one control on session.control: 'close' ends the
 * session after the step in hand, 'transfer' stops the step in hand, its
 * held commits discarded, and the securelock exits without a result. The
 * registry is closed to commits (ecld_state.closeCommits) when a step is cut
 * and when the session ends, so a handler still running writes nothing
 * more. On a reserved order the trustedzone writes session.fence before
 * session.input.0 (spec/session-fence.json) and marks session.config
 * reserved: the session waits for the fence, bounded by READY_WINDOW, and
 * ends the task without it; without the mark it waits for the fence, or
 * for the first input or a control without one, before reading its first
 * input; a fence with a bound re-commits the identity's keys at their
 * state as of it (ecld_state.fence) first.
 */

const etny_exec = require('./etny_exec');
const etny_crypto = require('./etny_crypto');
const { TaskStatus } = require('./task_status');

const HANDLER_GRACE_MS = 30000;
const TICK_MS = 2000;
// How long the session waits for session.fence before its first input
// (session-fence.json timing.readyWindowSeconds); session.input.0 or a
// control present without it ends the wait, the order being unreserved.
const READY_WINDOW_SECONDS = 180;
const FENCE_BASE = 'session.fence';
const FENCE_KEYS = ['order_id', 'bound', 'kind'];
const FENCE_KINDS = new Set(['toBlock', 'resultBlock', 'none']);
const CONTROLS = new Set(['close', 'transfer']);

// What runSession returns when the transfer control stopped the session:
// the securelock then exits without a result.
const TRANSFERRED = Object.freeze({ transferred: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* THE HANDOFF INVARIANT (mirror of the trustedzone side): everything this
   enclave pushes for the trustedzone is SIGNED with its identity key, so the
   trustedzone authors metadata rows only from verified securelock material;
   everything read from the trustedzone is verified against the trustedzone's
   registry certificate before it is trusted. Each signature covers
   "<challenge>:<order_id>:<object>:" ahead of the data -- the task binding
   the trustedzone forwarded in task.securelock, extended with the object's
   own name -- so the trustedzone can refuse a session object captured from
   another order, another run, or another sequence position. Without a
   binding (older trustedzone) the bare data is signed, which that trustedzone
   verifies. */

function sessionBinding(app, baseName) {
    return app.task_binding
        ? `${app.task_binding.challenge}:${app.task_binding.order_id}:${baseName}:` : '';
}

/* The signature is stored before the data: the trustedzone acts on the
   presence of the data object and reads the signature right after it. */
async function pushSignedForTrustedzone(app, data, baseName) {
    const sigHex = etny_crypto.signData(app.privateKeyMaterial(), sessionBinding(app, baseName) + data);
    await app.encryptFileAndPushToSwiftStream(sigHex, baseName + '.sig');
    await app.encryptFileAndPushToSwiftStream(data, baseName);
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

/* The fence signal is signed over the task binding
   ("<challenge>:<order_id>:session.fence:" ahead of the plaintext), not over
   the plaintext alone as session.config and session.control are. Returns the
   parsed signal, false when the object is absent; throws when it does not
   verify or its plaintext is malformed, as the Python securelock's
   get_and_verify_trustedzone_object raises. */
async function getVerifiedFence(app) {
    const data = await app.getFileContentAndDecrypt(app.etny_bucket, FENCE_BASE + '.securelock');
    if (data === false || data === null || data === undefined) return false;
    const sigHex = await app.getFileContentAndDecrypt(app.etny_bucket, FENCE_BASE + '.sig.securelock');
    if (sigHex === false || sigHex === null || sigHex === undefined) {
        throw new Error(`${FENCE_BASE} carries no signature`);
    }
    if (!app.task_binding) {
        throw new Error(`no task binding to verify ${FENCE_BASE} against`);
    }
    if (!etny_crypto.verifySignature(app.trustedZonePublicKey,
            sessionBinding(app, FENCE_BASE) + String(data), String(sigHex))) {
        throw new Error(`trustedzone signature INVALID for ${FENCE_BASE}`);
    }
    return parseFence(String(data), app.task_binding.order_id);
}

/* {"order_id":<n>,"bound":<block>,"kind":"toBlock"|"resultBlock"|"none"}:
   exactly these keys in this order, the order id this task's, the bound a
   block number, 0 with kind none and only then. */
function parseFence(json, orderId) {
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('session.fence is not an object');
    const keys = Object.keys(value);
    if (keys.length !== FENCE_KEYS.length || keys.some((k, i) => k !== FENCE_KEYS[i])) {
        throw new Error('session.fence does not have exactly the keys order_id, bound, kind in that order');
    }
    if (!Number.isInteger(value.order_id) || value.order_id !== Number(orderId)) {
        throw new Error(`session.fence names order ${value.order_id}, not ${orderId}`);
    }
    if (!Number.isInteger(value.bound) || value.bound < 0) throw new Error('session.fence bound is not a block number');
    if (!FENCE_KINDS.has(value.kind)) throw new Error(`session.fence kind ${value.kind} is not toBlock, resultBlock or none`);
    if ((value.bound === 0) !== (value.kind === 'none')) throw new Error('session.fence bound 0 goes with kind none alone');
    return { order_id: value.order_id, bound: value.bound, kind: value.kind };
}

function render(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function stateModule() {
    // eslint-disable-next-line global-require
    return require('./ecld_state');
}

class SecureLockSession {
    constructor(app, config) {
        this.app = app;
        this.orderId = Number(config.order_id);
        this.maxMessages = Number(config.max_messages || 256);
        // Written true by the trustedzone of a reserved order (caller.securelock
        // resolved to a holder), as the Python securelock reads it: the fence
        // is then awaited whatever else is staged and the task ends without
        // it. Absent from an older trustedzone's config, the fence is told
        // from the write order alone (awaitFence).
        this.reserved = config.reserved === true;
        const started = Date.now();
        this.closeAt = started + Number(config.close_after_seconds || 0) * 1000;
        this.cutoffAt = started + Number(config.input_cutoff_seconds || 0) * 1000;
        this.seen = 0;
        this.processed = 0;
        this.emitted = 0;
        this.unprocessed = [];
        this.reason = 'RUNNING_PERIOD_COMPLETE';
        this.control = null;
        this.scope = etny_exec.sessionBaseScope();
    }

    busy() {
        if (this.app.probe) this.app.probe.busyStart('S');
    }

    idle() {
        if (this.app.probe) this.app.probe.busyEnd();
    }

    async initialRun(payloadData, inputData) {
        this.busy();
        let code;
        let result;
        try {
            [code, result] = await etny_exec.exec(payloadData, inputData, this.scope);
        } finally {
            this.idle();
        }
        console.log(`session: payload context created (code ${code})`);
        if (Number(code) !== Number(TaskStatus.SUCCESS)) {
            this.reason = 'PAYLOAD_SETUP_FAILED';
            return [code, result];
        }
        return null;
    }

    /* Runs the handler on one input. Returns [code, output], null for a
       handler that hung past its grace, or TRANSFERRED when the transfer
       control arrived while the handler ran: the step in hand is abandoned,
       its held commits discarded and the registry closed to commits. A
       synchronous handler cannot be interrupted; the control is seen when it
       yields. busy stays 1 on an outcome until its envelope is staged
       (run), and when the step was cut until the idle tail. */
    async handle(seq, data) {
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
        const startedAt = Date.now();
        this.busy();
        const work = (async () => {
            return [Number(TaskStatus.SUCCESS), render(await handler(data))];
        })();
        let outcome;
        for (;;) {
            const remaining = Math.max(0, startedAt + budget - Date.now());
            const tick = sleep(Math.min(TICK_MS, remaining)).then(() => 'TICK');
            try {
                outcome = await Promise.race([work, tick]);
            } catch (e) {
                return [Number(TaskStatus.SYSTEM_ERROR), `SESSION HANDLER ERROR: ${e && e.message ? e.message : e}`];
            }
            if (outcome !== 'TICK') break;
            if (await this.controlRequested() === 'transfer') {
                console.log(`session: transfer control while input ${seq} ran; stopping the step`);
                work.catch(() => {});
                stateModule().discardStepCommits();
                stateModule().closeCommits();
                return TRANSFERRED;
            }
            if (Date.now() >= startedAt + budget) {
                console.log(`session: handler hung on input ${seq}; abandoning`);
                work.catch(() => {});
                this.unprocessed.push(seq);
                // The abandoned step is never emitted: its commits leave with
                // it. The budget is the session's remaining time, so the
                // session ends on the next turn and closes the registry.
                stateModule().discardStepCommits();
                stateModule().beginStep();
                return null;
            }
        }
        return outcome;
    }

    /* Output n of the session: the step's held commits staged as
       session.commit.<n>.<key16>.<relayNonce>.json in commit order, each the
       record's JSON, esr.authorizations.json rewritten as every staged step's
       records, then the signed envelope {ack, code, data, commits, esr:
       {wallet, commits}}; wallet null with no commits when ESR is not
       configured. A record whose callerUsed the payload forged makes the
       output a SECURITY_VIOLATION, as the Python securelock's _emit does.
       The next step opens once the envelope is staged. */
    async emit(ackSeq, code, data) {
        const n = this.emitted;
        const ecld_state = stateModule();
        const { records, tampered } = await ecld_state.takeStepCommits(this.app.task_caller || null);
        if (tampered) {
            code = TaskStatus.SECURITY_VIOLATION;
            data = 'SECURITY_VIOLATION: the task attempted to forge the state ' +
                'commit caller. The attested submitter was re-asserted.';
        }
        const names = [];
        for (const auth of records) {
            const name = ecld_state.commitFileName(`session.commit.${n}`, auth);
            await this.app.swiftStreamService.putFileContent(
                this.app.etny_bucket, name, '', Buffer.from(JSON.stringify(auth), 'utf8'));
            names.push(name);
        }
        const wallet = ecld_state.ledgerAttestation().wallet;
        if (wallet) await ecld_state.writeAuthorizations();
        const envelope = JSON.stringify({
            ack: ackSeq,
            code: Number(code),
            data,
            commits: names,
            esr: { wallet: wallet ? wallet.toLowerCase() : null, commits: records },
        });
        await pushSignedForTrustedzone(this.app, envelope, `session.output.${n}`);
        this.emitted += 1;
        ecld_state.beginStep();
    }

    /* The control the trustedzone wrote on session.control: 'close',
       'transfer' or null. One control is ever written, so the first one
       read is kept. An unauthenticated object is ignored: the node could
       place one in the bucket, but only the trustedzone can SIGN one. */
    async controlRequested() {
        if (this.control !== null) return this.control;
        try {
            const r = await this.app.swiftStreamService.isObjectInBucket(
                this.app.etny_bucket, 'session.control.securelock');
            if (!r[1]) return null;
        } catch (e) {
            return null;
        }
        const control = await getVerifiedTrustedzoneObject(this.app, 'session.control');
        if (control === false) return null;
        const value = String(control).trim();
        if (!CONTROLS.has(value)) {
            console.log(`session: unknown control ${JSON.stringify(value)} -- ignoring`);
            return null;
        }
        this.control = value;
        console.log(`session: ${value} control received`);
        return value;
    }

    async present(name) {
        try {
            const r = await this.app.swiftStreamService.isObjectInBucket(this.app.etny_bucket, name);
            return Boolean(r[1]);
        } catch (e) {
            return false;
        }
    }

    /* Before the first input: waits for session.fence for READY_WINDOW at
       most (session-fence.json timing). On an order the config marks
       reserved the fence is awaited whatever else is staged, and false is
       returned when it did not come in time. Otherwise session.input.0 or a
       control present without a fence ends the wait: the trustedzone writes
       the fence before session.input.0 on every reserved order, so an input
       without one means an unreserved order. A fence present is verified
       and, with a bound, applied. */
    async awaitFence() {
        const deadline = Math.min(Date.now() + READY_WINDOW_SECONDS * 1000, this.closeAt);
        const fenceObject = FENCE_BASE + '.securelock';
        for (;;) {
            if (await this.present(fenceObject)) break;
            if (!this.reserved
                    && (await this.present('session.input.0.securelock') || await this.controlRequested() !== null)) {
                // The fence is looked for once more: the trustedzone writes it
                // right before the input.
                if (await this.present(fenceObject)) break;
                return true;
            }
            if (Date.now() >= deadline) return !this.reserved;
            await sleep(TICK_MS);
        }
        const signal = await getVerifiedFence(this.app);
        if (signal === false) throw new Error(`${FENCE_BASE} vanished from the bucket`);
        console.log(`session: fence ${signal.kind} at ${signal.bound}`);
        if (signal.kind !== 'none') await this.applyFence(signal.bound);
        return true;
    }

    async applyFence(bound) {
        const ecld_state = stateModule();
        if (!ecld_state.ledgerAttestation().wallet) {
            console.log('session: fence with no state registry configured; nothing to fence');
            return;
        }
        const fenced = await ecld_state.fence(bound);
        console.log(`session: fenced ${fenced.length} key(s) as of block ${bound}`);
    }

    async run(payloadData, inputData) {
        const ecld_state = stateModule();
        // Commits of the payload's initial run are held for the first
        // output's envelope; a session that ends before any output stages
        // them as a plain task does (closeHeld).
        ecld_state.beginStep();
        const setupFailure = await this.initialRun(payloadData, inputData);
        if (setupFailure !== null) {
            await this.closeHeld();
            return setupFailure;
        }
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
        if (!(await this.awaitFence())) {
            console.error(`session: no fence signal within ${READY_WINDOW_SECONDS} s; ending the task`);
            await this.closeHeld();
            return [Number(TaskStatus.SYSTEM_ERROR),
                `SESSION FENCE ERROR: session.fence not staged within ${READY_WINDOW_SECONDS} s`];
        }
        let nextSeq = 0;
        for (;;) {
            const now = Date.now();
            if (now >= this.closeAt) { this.reason = 'RUNNING_PERIOD_COMPLETE'; break; }
            const control = await this.controlRequested();
            if (control === 'close') { this.reason = 'CLOSED'; break; }
            if (control === 'transfer') {
                ecld_state.discardStepCommits();
                ecld_state.closeCommits();
                return TRANSFERRED;
            }
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
            const outcome = await this.handle(nextSeq, String(data));
            if (outcome === TRANSFERRED) return TRANSFERRED;
            if (outcome !== null) {
                const [code, out] = outcome;
                // Only successful handling counts as processed; error outputs
                // are still emitted+acked so the dApp sees them.
                if (Number(code) === Number(TaskStatus.SUCCESS)) this.processed += 1;
                await this.emit(nextSeq, code, out);
                this.idle();
            }
            nextSeq += 1;
        }
        if (await this.closeHeld()) {
            return [TaskStatus.SECURITY_VIOLATION,
                'SECURITY_VIOLATION: the task attempted to forge the state ' +
                'commit caller. The attested submitter was re-asserted and ' +
                'the task was terminated.'];
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

    /* The session's end: the commits still held are staged as a plain
       task's when no output was emitted (esr.commit.<key16>.<relayNonce>.json
       each) and dropped after an output, a step never emitted contributing
       nothing; then the registry is closed to commits. Returns whether a
       staged record carried a forged caller. */
    async closeHeld() {
        const ecld_state = stateModule();
        let tampered = false;
        try {
            if (this.emitted === 0) {
                tampered = (await ecld_state.flushStepCommits(this.app.task_caller || null)).tampered;
            } else {
                ecld_state.discardStepCommits();
            }
        } finally {
            ecld_state.closeCommits();
        }
        return tampered;
    }
}

/* Entry point used by securelock.execute(). Returns TRANSFERRED when the
   transfer control ended the session; any unexpected failure degrades to an
   ordinary task error, never a hang. */
async function runSession(app, payloadData, inputData) {
    let session = null;
    try {
        // The trustedzone certificate anchors every verification below.
        if (!app.trustedZonePublicKey) {
            await app.getTrustedZonePublicKey();
        }
        const raw = await getVerifiedTrustedzoneObject(app, 'session.config');
        if (raw === false) throw new Error('session config not verifiable');
        session = new SecureLockSession(app, JSON.parse(String(raw)));
        return await session.run(payloadData, inputData);
    } catch (e) {
        console.error('session executor failed:', e && e.message ? e.message : e);
        if (session !== null) {
            try {
                await session.closeHeld();
            } catch (closeError) {
                console.error('session: held commits not staged:', closeError && closeError.message ? closeError.message : closeError);
            }
        }
        stateModule().closeCommits();
        return [TaskStatus.SYSTEM_ERROR, `SESSION EXECUTOR ERROR: ${e && e.message ? e.message : e}`];
    }
}

module.exports = {
    runSession,
    SecureLockSession,
    pushSignedForTrustedzone,
    getVerifiedFence,
    parseFence,
    TRANSFERRED,
    READY_WINDOW_SECONDS,
    TICK_MS,
};
