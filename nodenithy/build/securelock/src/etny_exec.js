const fs = require('fs');
const path = require('path');
const { TaskStatus } = require('./task_status');

// Load EVERY export of ./serverless/backend into the payload's scope. The
// backend is copied next to this file by ecld-build (and staged the same way
// by ecld-test locally), so one code path serves both the enclave and local
// testing. Previously only a function literally named `hello` was reachable
// (hardcoded destructure); any other exported function threw ReferenceError.
// A missing backend leaves only ___etny_result___ in scope, which is the
// stock-enclave behaviour.
let backendFunctions = {};
// If the backend fails to load, remember WHY. A silently-swallowed failure
// (missing npm module, bad require inside backend.js) makes every task die
// later with a misleading "X is not defined". Only a genuinely absent backend
// stays silent — that is the stock-enclave configuration.
let backendImportError = null;
try {
    backendFunctions = { ...require('./serverless/backend') };
} catch (e) {
    backendFunctions = {};
    // MODULE_NOT_FOUND messages embed the whole require stack (which always
    // mentions serverless/backend.js), so parse out WHICH module is missing:
    // only a missing backend module itself means "no backend shipped".
    const m = /Cannot find module '([^']+)'/.exec(e.message || '');
    const missingBackendItself =
        e.code === 'MODULE_NOT_FOUND' && m && /serverless[\\/]backend/.test(m[1]);
    if (!missingBackendItself) {
        backendImportError = `${e.name || 'Error'}: ${(e.message || '').split('\n')[0]}`;
    }
}

/**
 * Automatic encoding for task results (single code path for all results):
 * JSON-serializable values ride as JSON, strings as text, bytes-like as
 * base64. Anything else is JSON-stringified with a String() fallback -- a
 * task result never fails on encoding.
 */
function encodeResultData(data) {
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
        return ['base64', Buffer.from(data).toString('base64')];
    }
    if (typeof data === 'string') {
        return ['text', data];
    }
    try {
        JSON.stringify(data);
        return ['json', data === undefined ? null : data];
    } catch (e) {
        try {
            return ['json', JSON.parse(JSON.stringify(data, (k, v) =>
                typeof v === 'bigint' || typeof v === 'function' ? String(v) : v))];
        } catch (e2) {
            return ['text', String(data)];
        }
    }
}

/**
 * Return a task result (THE way to end a task).
 *
 * Builds the structured result envelope:
 *   { ecld: 1, type: 'json'|'text'|'base64', data: ..., esr: ... }
 *
 * - `data` is encoded automatically (see encodeResultData).
 * - `state: true` (default) attaches the ESR state of every key this task
 *   touched; `state: 'meta'` attaches {key, version, cid} without the state
 *   payload; `state: false` attaches nothing.
 * - `keys: [...]` restricts the attachment to those keys (already-touched
 *   only -- to attach an untouched key, use the async esrFetch helper).
 *
 * ESR attachment is best-effort: an ESR-disabled build (or any attachment
 * error) yields esr: null, never a failed task.
 */
function ecldResult(data = null, { state = true, keys = null } = {}) {
    const [type, encoded] = encodeResultData(data);
    const envelope = { ecld: 1, type, data: encoded, esr: null };
    if (state || keys) {
        try {
            // eslint-disable-next-line global-require
            const ecldState = require('./ecld_state');
            envelope.esr = ecldState.ledgerSnapshot(state === true, keys);
        } catch (e) {
            envelope.esr = null;
        }
    }
    return [0, JSON.stringify(envelope)];
}

/** Legacy alias: same builder, ESR attachment off -- today's behavior. */
function ___etny_result___(data) {
    return ecldResult(data, { state: false });
}

/**
 * Standard state-fetch task body: awaits the reads (populating the task
 * ledger), then attaches them. The runner's cache-gated read submits this on
 * a cache miss: `await esrFetch('profile-7')`.
 */
async function esrFetch(...keys) {
    try {
        // eslint-disable-next-line global-require
        const { StateRegistry } = require('./ecld_state');
        const reg = new StateRegistry();
        for (const k of keys) {
            // eslint-disable-next-line no-await-in-loop
            await reg.get(k);
        }
    } catch (e) { /* ESR-disabled build: esr stays null */ }
    return ecldResult(null, { keys: keys.length ? keys : null });
}

// Names of *_ADDRESS-style enclave config vars that are set but EMPTY.
// The enclave is sealed: env can only come from the image, so a present-but-
// empty required value is always a build/render defect, never a runtime
// choice. ESR_* vars only exist when the project enabled ESR at build time.
function emptyRequiredConfig() {
    const required = ['ESR_CONTRACT_ADDRESS'];
    return required.filter(
        (name) => name in process.env && !String(process.env[name]).trim()
    );
}

async function executeTask(payload, input) {
    const missing = emptyRequiredConfig();
    if (missing.length) {
        return [
            TaskStatus.CONFIG_ERROR,
            'ENCLAVE CONFIG ERROR: required value(s) empty inside the enclave: ' +
            missing.join(', ') +
            ' | The enclave is sealed, so this value had to be baked at build' +
            ' time and was not. Re-run ecld-build (it validates ESR config)' +
            ' and republish.'
        ];
    }
    if (backendImportError !== null) {
        return [
            TaskStatus.IMPORT_ERROR,
            'BACKEND IMPORT ERROR: ' + backendImportError +
            ' | The serverless backend failed to load inside the enclave, so none of its' +
            ' functions are available. Common causes: a module missing from the enclave' +
            ' image dependencies, or a bad require() inside backend.js.'
        ];
    }
    const scope = {
        '___etny_result___': ___etny_result___,   // legacy alias (no ESR)
        'ecldResult': ecldResult,                 // the result API
        'esrFetch': esrFetch,                     // standard state-fetch task
        ...backendFunctions,
    };
    // State ownership / ACL API (present only in ESR-enabled builds). Enforced
    // inside ecld_state against the trustedzone-attested caller.
    try {
        // eslint-disable-next-line global-require
        const ecldState = require('./ecld_state');
        for (const name of ['taskCaller', 'esrGrant', 'esrRevoke',
            'esrSetPublicRead', 'esrTransfer', 'esrOwner', 'esrAcl', 'esrNonce']) {
            if (!(name in scope)) scope[name] = ecldState[name];
        }
    } catch (e) { /* non-ESR build */ }
    return exec(payload, input, scope);
}

async function exec(payload, input, globals = null) {
    try {
        if (payload && payload !== "") {
            const scope = globals || {};
            if (input && input !== "") {
                scope['___etny_data_set___'] = input;
            }
            // `with` exposes every backend function and ___etny_data_set___ to
            // the payload by bare name — matching how payloads are written
            // (e.g. `processData(___etny_data_set___)`).
            with (scope) {
                // ESR reads/commits are async, so a state-using payload
                // (`esrIncrement()`, `await reg.commit(...)`) evaluates to a
                // Promise. Await it so the finished value -- not the pending
                // Promise -- is what gets wrapped. Non-async payloads await to
                // themselves, so this is transparent for plain results.
                const value = await eval(payload);
                // A payload that called ecldResult/___etny_result___ itself
                // already holds the finished [0, envelopeJson] tuple -- pass
                // it through instead of wrapping the result a second time.
                if (Array.isArray(value) && value.length === 2 &&
                    value[0] === 0 && typeof value[1] === 'string') {
                    return value;
                }
                return ___etny_result___(value);
            }
        } else {
            return [TaskStatus.PAYLOAD_NOT_DEFINED, 'Could not find the source file to execute'];
        }

        // return [TaskStatus.SUCCESS, 'TASK EXECUTED SUCCESSFULLY'];
    } catch (error) {
        // A task returns its result by RETURNING (via ___etny_result___), not by
        // throwing, so anything caught here is a genuine failure. In every branch
        // deliver the FULL stack trace to the data owner AS THE RESULT (visible in
        // their runner output) and never crash the enclave -- always return a
        // normal [code, data] tuple so the trustedzone stops waiting. Honor the
        // embedded-result SUCCESS (code 0) case first.
        try {
            if (error && error.args && error.args[0] && error.args[0][0] === 0) {
                return [TaskStatus.SUCCESS, error.args[0][1]];
            }
        } catch (e) { /* fall through to failure reporting */ }

        // A duplicate-suppressed commit (StateNonceError) gets its own task
        // code so the dApp can distinguish "already applied" from a failure.
        if (error && error.constructor && error.constructor.name === 'StateNonceError') {
            return [TaskStatus.ESR_NONCE_VIOLATION, 'ESR_NONCE_VIOLATION: ' + error.message];
        }
        // Over the per-run commit cap (100): the over-limit commit was NOT
        // applied; the earlier commits stand and will be relayed.
        if (error && error.constructor && error.constructor.name === 'StateLimitError') {
            return [TaskStatus.ESR_COMMIT_LIMIT_EXCEEDED, 'ESR_COMMIT_LIMIT_EXCEEDED: ' + error.message];
        }
        const detail = (error && (error.stack || error.message)) || String(error);
        console.error('Error in payload execution -- full stack follows:\n' + detail);

        if (error instanceof ReferenceError) {
            return [TaskStatus.SYSTEM_ERROR, 'SYSTEM_ERROR (ReferenceError): ' + detail];
        } else if (error instanceof EvalError) {
            return [TaskStatus.KEY_ERROR, 'KEY_ERROR (EvalError): ' + detail];
        } else if (error instanceof SyntaxError) {
            return [TaskStatus.SYNTAX_WARNING, 'SYNTAX_WARNING (SyntaxError): ' + detail];
        } else {
            return [TaskStatus.BASE_EXCEPTION, 'BASE_EXCEPTION: ' + detail];
        }
    }
}

module.exports = {
    executeTask
};
