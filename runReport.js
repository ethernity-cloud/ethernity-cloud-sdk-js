'use strict';

/* ecld-run's report of a finished run.
 *
 * A run that delivered a result prints it; a task the enclave reported with a
 * non-zero task code (an exception in the dApp, a checksum mismatch, ...)
 * prints that code and its result, which is the enclave's error report. The
 * runner signals such a task with its ERROR event, carrying getLastError().
 */

/**
 * Print the outcome of a run and return the exit code.
 * outcome: 'SUCCESS', or { error } from the ERROR event or a rejected run().
 */
async function reportRun(runner, outcome, { json = false, out = console.log, err = console.error } = {}) {
  // { code, name } of the enclave's task code, or null when no result came.
  const taskCode = runner.getResultTaskCode();
  const error = outcome && outcome.error;
  if (!taskCode && error) {
    err('\nstatus     : ERROR');
    err(`error      : ${error}`);
    return 1;
  }
  const result = await runner.getResult();
  const typed = (runner.getStructuredResult && runner.getStructuredResult()) || null;
  if (json) {
    out(JSON.stringify({
      task_code: taskCode ? taskCode.code : undefined,
      task_code_name: taskCode ? taskCode.name : undefined,
      value: result,
      structured: typed,
    }, null, 2));
  } else {
    if (taskCode && taskCode.code !== 0) out(`task code  : ${taskCode.code} (${taskCode.name})`);
    out('result     :');
    out(result);
  }
  if (taskCode && taskCode.code !== 0) {
    err(`error      : ${runner.getLastError() || error || taskCode.name}`);
    return 1;
  }
  return error ? 1 : 0;
}

module.exports = { reportRun };
