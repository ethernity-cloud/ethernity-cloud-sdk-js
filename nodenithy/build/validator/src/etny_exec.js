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
