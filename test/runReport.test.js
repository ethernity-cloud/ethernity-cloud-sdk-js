// ecld-run's report: a delivered result is printed; a task the enclave
// reported with a non-zero task code prints that code and its error report and
// exits 1; a run that failed before any result prints the error and exits 1.
// The runner is a stand-in exposing the accessors ecld-run reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reportRun } = require('../runReport.js');

const runnerWith = (taskCode, result, lastError = null) => ({
  getResultTaskCode: () => taskCode,
  getResult: async () => result,
  getStructuredResult: () => null,
  getLastError: () => lastError,
});

const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, out: (l) => lines.out.push(String(l)), err: (l) => lines.err.push(String(l)) };
};

test('a successful task prints its result and exits 0', async () => {
  const c = capture();
  const code = await reportRun(runnerWith({ code: 0, name: 'SUCCESS' }, 'Hello World'), 'SUCCESS', c);
  assert.equal(code, 0);
  assert.deepEqual(c.lines.out, ['result     :', 'Hello World']);
  assert.deepEqual(c.lines.err, []);
});

test('a task that raised prints its task code and report and exits 1', async () => {
  const c = capture();
  const report = "BASE_EXCEPTION: RuntimeError('boom')\nTraceback ...";
  const runner = runnerWith({ code: 4, name: 'BASE_EXCEPTION' }, report,
    'The task failed in the enclave with BASE_EXCEPTION (4)');
  const code = await reportRun(runner, { error: 'The task failed in the enclave with BASE_EXCEPTION (4)' }, c);
  assert.equal(code, 1);
  assert.deepEqual(c.lines.out, ['task code  : 4 (BASE_EXCEPTION)', 'result     :', report]);
  assert.match(c.lines.err[0], /BASE_EXCEPTION \(4\)/);
});

test('a run that failed before any result prints the error and exits 1', async () => {
  const c = capture();
  const code = await reportRun(runnerWith(null, null), { error: 'Unable to find enclave in registry' }, c);
  assert.equal(code, 1);
  assert.deepEqual(c.lines.out, []);
  assert.match(c.lines.err.join('\n'), /Unable to find enclave in registry/);
});

test('--json carries the task code of a failed task', async () => {
  const c = capture();
  const code = await reportRun(runnerWith({ code: 4, name: 'BASE_EXCEPTION' }, 'report'), { error: 'x' }, { ...c, json: true });
  assert.equal(code, 1);
  const printed = JSON.parse(c.lines.out[0]);
  assert.equal(printed.task_code, 4);
  assert.equal(printed.task_code_name, 'BASE_EXCEPTION');
  assert.equal(printed.value, 'report');
});
