

const fs = require('fs');
const { TaskStatus } = require('./task_status');

function ___etny_result___(data) {
    return [0, data];
}
function executeTask(payload, input) {
    return exec(payload, input, { '___etny_result___': ___etny_result___ });
}

function exec(payload, input, globals = null) {
    try {
        if (payload && payload !== "") {
            if (input && input !== "") {
                if (globals) {
                    globals['___etny_data_set___'] = input;
                }
                return eval(payload);
            } else {
                return eval(payload);
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
