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
try {
    backendFunctions = { ...require('./serverless/backend') };
} catch (e) {
    backendFunctions = {};
}

function ___etny_result___(data) {
    return [0, data];
}

function executeTask(payload, input) {
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
        if (error instanceof ReferenceError) {
            return [TaskStatus.SYSTEM_ERROR, error.message];
        } else if (error instanceof EvalError) {
            return [TaskStatus.KEY_ERROR, error.message];
        } else if (error instanceof SyntaxError) {
            return [TaskStatus.SYNTAX_WARNING, error.message];
        } else if (error instanceof Error) {
            try {
                if (error.args[0][0] === 0) {
                    return [TaskStatus.SUCCESS, error.args[0][1]];
                } else {
                    return [TaskStatus.BASE_EXCEPTION, error.args[0]];
                }
            } catch (e) {
                return [TaskStatus.BASE_EXCEPTION, error.message];
            }
        } else {
            return [TaskStatus.BASE_EXCEPTION, error.message];
        }
    }
}

module.exports = {
    executeTask
};
