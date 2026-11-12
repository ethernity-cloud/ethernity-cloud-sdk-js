// ecld-run's flags: --task-price takes a fractional ECLD amount and refuses
// anything that is not a non-negative number; the execution flags override
// the EXEC_* keys of .env, --duration maps to durationHours, and the
// relays-per-hour default follows execution.js unless the flag names it.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, executionFor, relaysPerHourFor, UsageError } = require('../run.js');
const { DEFAULTS } = require('../execution.js');

test('--task-price takes a fractional amount and keeps an integer one', () => {
  assert.equal(parseArgs(['--task-price', '2.5']).opts.taskPrice, 2.5);
  assert.equal(parseArgs(['--task-price', '3']).opts.taskPrice, 3);
  assert.equal(parseArgs([]).opts.taskPrice, 3);
});

test('--task-price refuses a non-number, a negative amount and a missing value', () => {
  assert.throws(() => parseArgs(['--task-price', 'x']), UsageError);
  assert.throws(() => parseArgs(['--task-price', 'x']), { message: '--task-price takes a non-negative number, got "x"' });
  assert.throws(() => parseArgs(['--task-price', '-1']), UsageError);
  assert.throws(() => parseArgs(['--task-price']), UsageError);
});

test('--mode without a value, or followed by another flag, is a usage error and overrides nothing', () => {
  assert.throws(() => parseArgs(['--mode']), UsageError);
  assert.throws(() => parseArgs(['--mode']), { message: '--mode takes a value, got undefined' });
  assert.throws(() => parseArgs(['--mode', '']), UsageError);
  assert.throws(() => parseArgs(['--mode', '--json', 'x']), { message: '--mode takes a value, got "--json"' });
  assert.equal(parseArgs(['--mode', ' session ']).opts.execution.mode, 'session');
  const env = { EXEC_MODE: 'session', EXEC_SESSION_EXPECTED_INPUTS: '5' };
  assert.equal(executionFor(parseArgs([]).opts, env).mode, 'session');
});

test('the count flags take integers only', () => {
  assert.equal(parseArgs(['--cpu', '2']).opts.cpu, 2);
  assert.throws(() => parseArgs(['--cpu', '1.5']), { message: '--cpu takes a non-negative integer, got "1.5"' });
  assert.throws(() => parseArgs(['--timeout', 'soon']), UsageError);
});

test('the execution flags fill the nested execution; --duration maps to durationHours', () => {
  const { opts } = parseArgs([
    '--mode', 'session', '--duration', '3', '--parallelism', '2', '--max-cu', '1500', '--headroom', '10',
    '--expected-inputs', '5', '--keep-open', '--renew', '--max-renewals', '2', '--expected-commits', '4',
    '--relays-per-hour', '20', 'hello()',
  ]);
  assert.deepEqual(opts.execution, {
    mode: 'session', durationHours: 3, parallelism: 2, maxCu: 1500, headroomPercent: 10,
    session: { expectedInputs: 5, keepOpen: true, renew: true, maxRenewals: 2 },
    esr: { expectedCommits: 4 },
  });
  assert.equal(opts.relaysPerHour, 20);
  assert.equal(parseArgs(['--duration-hours', '4']).opts.execution.durationHours, 4);
  assert.deepEqual(parseArgs(['--no-keep-open', '--no-renew']).opts.execution.session, { keepOpen: false, renew: false });
  assert.equal('duration' in parseArgs([]).opts, false);
});

test('executionFor reads .env and lets a flag override its key', () => {
  const env = { EXEC_MODE: 'session', EXEC_DURATION_HOURS: '2', EXEC_SESSION_EXPECTED_INPUTS: '5', EXEC_SESSION_KEEP_OPEN: 'true' };
  assert.deepEqual(executionFor(parseArgs([]).opts, env), {
    ...DEFAULTS, mode: 'session', durationHours: 2,
    session: { ...DEFAULTS.session, expectedInputs: 5, keepOpen: true },
  });
  const over = executionFor(parseArgs(['--duration', '4', '--expected-inputs', '1', '--no-keep-open']).opts, env);
  assert.equal(over.durationHours, 4);
  assert.deepEqual(over.session, { ...DEFAULTS.session, expectedInputs: 1, keepOpen: false });
  assert.equal(over.mode, 'session');
  assert.deepEqual(executionFor(parseArgs([]).opts, {}), DEFAULTS);
});

test('executionFor refuses an invalid value with the fixture message, from .env or a flag', () => {
  assert.throws(() => executionFor(parseArgs([]).opts, { EXEC_DURATION_HOURS: '0' }),
    { message: 'execution.durationHours must be an integer between 1 and 65535' });
  assert.throws(() => executionFor(parseArgs(['--mode', 'batch']).opts, {}),
    { message: 'execution.mode must be "task" or "session"' });
  assert.throws(() => executionFor(parseArgs(['--renew']).opts, {}),
    { message: 'execution.session.maxRenewals must be >= 1 when execution.session.renew is true' });
});

test('relaysPerHourFor is the execution.js default unless --relays-per-hour names it', () => {
  const exec = executionFor(parseArgs(['--expected-inputs', '5']).opts, {});
  assert.equal(relaysPerHourFor(parseArgs([]).opts, {}, exec), 6);
  assert.equal(relaysPerHourFor(parseArgs([]).opts, { ESR_ENABLED: 'true' }, exec), 16);
  assert.equal(relaysPerHourFor(parseArgs(['--relays-per-hour', '3']).opts, { ESR_ENABLED: 'true' }, exec), 3);
});
