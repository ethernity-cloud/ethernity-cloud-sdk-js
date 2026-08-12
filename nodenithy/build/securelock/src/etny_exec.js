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

function ___etny_result___(data) {
    return [0, data];
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

function executeTask(payload, input) {
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
    return exec(payload, input, { '___etny_result___': ___etny_result___, ...backendFunctions });
}

function exec(payload, input, globals = null) {
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
                return ___etny_result___(eval(payload));
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
