// execution.js against test/fixtures/execution-spec.json: the defaults, the
// normalization cases, the ten validation cases with their exact messages,
// the EXEC_* parsing of fromEnv and the EXEC_* strings of toEnv, and the
// relaysPerHour default (1 + expectedInputs rows, plus 10 commits with ESR).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const spec = require(path.join(__dirname, 'fixtures', 'execution-spec.json'));
const execution = require('../execution.js');

test('DEFAULTS equal the fixture defaults and validate() of nothing returns them', () => {
  assert.deepEqual(execution.DEFAULTS, spec.defaults);
  assert.deepEqual(execution.validate(undefined), spec.defaults);
  assert.deepEqual(execution.validate({}), spec.defaults);
  assert.deepEqual(execution.validate({ session: {}, esr: {} }), spec.defaults);
});

test('the schema keys, types, bounds and defaults are the fixture schema', () => {
  assert.deepEqual(execution.SCHEMA.map((f) => f.key), spec.schema.map((f) => f.key));
  for (const [i, f] of spec.schema.entries()) {
    const ours = execution.SCHEMA[i];
    assert.equal(ours.type, f.type, f.key);
    if (f.values) assert.deepEqual(ours.values, f.values, f.key);
    if (f.min !== undefined) assert.equal(ours.min, f.min, f.key);
    if (f.max !== undefined) assert.equal(ours.max, f.max, f.key);
    assert.equal(ours.max === undefined, f.max === undefined, f.key);
  }
});

for (const c of spec.normalization.cases) {
  test(`normalize: ${c.name}`, () => {
    assert.deepEqual(execution.normalize(c.input), c.output);
  });
}

for (const c of spec.validationCases) {
  test(`validate: ${c.name}`, () => {
    assert.throws(() => execution.validate(c.input), { message: c.error });
  });
}

test('null is not a value: it fails the key\'s own check', () => {
  assert.throws(() => execution.validate({ mode: null }), { message: spec.validationCases[0].error });
  assert.throws(() => execution.validate({ durationHours: null }), { message: spec.validationCases[1].error });
  assert.throws(() => execution.validate({ session: { keepOpen: null } }),
    { message: 'execution.session.keepOpen must be true or false' });
  assert.throws(() => execution.validate({ session: null }), { message: 'execution.session must be an object' });
});

test('an unknown key inside a block, a non-object and a string number are refused', () => {
  assert.throws(() => execution.validate({ session: { expectedInput: 2 } }),
    { message: 'execution.session has an unknown key "expectedInput"' });
  assert.throws(() => execution.validate({ esr: { commits: 2 } }),
    { message: 'execution.esr has an unknown key "commits"' });
  assert.throws(() => execution.validate('task'), { message: 'execution must be an object' });
  assert.throws(() => execution.validate({ parallelism: '2' }), { message: spec.validationCases[3].error });
});

test('the session block is checked in both modes; renew needs a renewal in mode task too', () => {
  assert.throws(() => execution.validate({ session: { renew: true } }), { message: spec.validationCases[8].error });
  const out = execution.validate({ session: { renew: true, maxRenewals: 2, keepOpen: true } });
  assert.deepEqual(out.session, { expectedInputs: 1, keepOpen: true, renew: true, maxRenewals: 2 });
  assert.equal(out.mode, 'task');
});

test('checks run in schema order: the first failing key names the error', () => {
  assert.throws(() => execution.validate({ headroomPercent: 101, durationHours: 0 }),
    { message: spec.validationCases[1].error });
});

test('unknown keys at every level are checked before any value', () => {
  assert.throws(() => execution.validate({ durationHours: 0, session: { foo: 1 } }),
    { message: 'execution.session has an unknown key "foo"' });
  assert.throws(() => execution.validate({ durationHours: 0, esr: { foo: 1 } }),
    { message: 'execution.esr has an unknown key "foo"' });
  assert.throws(() => execution.validate({ session: { foo: 1 }, bar: 1 }),
    { message: 'execution has an unknown key "bar"' });
});

test('normalize refuses a resources argument that is not an object', () => {
  for (const bad of [undefined, null, 'nonsense', 3, [], true]) {
    assert.throws(() => execution.normalize(bad), { message: 'resources must be an object' });
  }
});

test('ENV_KEYS are the ten EXEC_* keys in schema order', () => {
  assert.deepEqual(execution.ENV_KEYS.map(([name]) => name), [
    'EXEC_MODE', 'EXEC_DURATION_HOURS', 'EXEC_PARALLELISM', 'EXEC_MAX_CU', 'EXEC_HEADROOM_PERCENT',
    'EXEC_SESSION_EXPECTED_INPUTS', 'EXEC_SESSION_KEEP_OPEN', 'EXEC_SESSION_RENEW',
    'EXEC_SESSION_MAX_RENEWALS', 'EXEC_ESR_EXPECTED_COMMITS',
  ]);
  assert.deepEqual(execution.ENV_KEYS.map(([, key]) => key), spec.schema.map((f) => f.key));
});

test('fromEnv parses the EXEC_* strings to numbers and booleans and skips blank ones', () => {
  const env = {
    EXEC_MODE: 'session', EXEC_DURATION_HOURS: '3', EXEC_PARALLELISM: ' 2 ', EXEC_MAX_CU: '',
    EXEC_HEADROOM_PERCENT: '10', EXEC_SESSION_EXPECTED_INPUTS: '5', EXEC_SESSION_KEEP_OPEN: 'true',
    EXEC_SESSION_RENEW: '1', EXEC_SESSION_MAX_RENEWALS: '2', EXEC_ESR_EXPECTED_COMMITS: '4',
    PROJECT_NAME: 'demo',
  };
  assert.deepEqual(execution.fromEnv(env), {
    mode: 'session', durationHours: 3, parallelism: 2, headroomPercent: 10,
    session: { expectedInputs: 5, keepOpen: true, renew: true, maxRenewals: 2 },
    esr: { expectedCommits: 4 },
  });
  assert.deepEqual(execution.fromEnv({}), {});
  assert.deepEqual(execution.fromEnv({ EXEC_SESSION_KEEP_OPEN: 'no', EXEC_SESSION_RENEW: 'off' }),
    { session: { keepOpen: false, renew: false } });
});

test('fromEnv keeps a string it cannot parse so validate names the key', () => {
  assert.throws(() => execution.validate(execution.fromEnv({ EXEC_DURATION_HOURS: 'two' })),
    { message: spec.validationCases[1].error });
  assert.throws(() => execution.validate(execution.fromEnv({ EXEC_SESSION_KEEP_OPEN: 'maybe' })),
    { message: 'execution.session.keepOpen must be true or false' });
  assert.throws(() => execution.validate(execution.fromEnv({ EXEC_DURATION_HOURS: '1.5' })),
    { message: spec.validationCases[1].error });
});

test('fromEnv parses decimal integers and fractions only: an exponent or a bare trailing point is kept', () => {
  assert.deepEqual(execution.fromEnv({ EXEC_PARALLELISM: '+3', EXEC_MAX_CU: '0', EXEC_DURATION_HOURS: '1.5' }),
    { parallelism: 3, maxCu: 0, durationHours: 1.5 });
  assert.deepEqual(execution.fromEnv({ EXEC_PARALLELISM: '1e2', EXEC_MAX_CU: '3.', EXEC_DURATION_HOURS: '.5' }),
    { parallelism: '1e2', maxCu: '3.', durationHours: '.5' });
  assert.throws(() => execution.validate(execution.fromEnv({ EXEC_PARALLELISM: '1e2' })),
    { message: spec.validationCases[3].error });
  assert.throws(() => execution.validate(execution.fromEnv({ EXEC_MAX_CU: '3.' })),
    { message: spec.validationCases[4].error });
});

test('fromEnv reads a prefixed set (ecld-init\'s ECLD_EXEC_*)', () => {
  assert.deepEqual(execution.fromEnv({ ECLD_EXEC_MODE: 'session', EXEC_MODE: 'task' }, 'ECLD_'), { mode: 'session' });
});

test('toEnv writes every EXEC_* key of the completed object, and fromEnv reads it back', () => {
  const strings = execution.toEnv({ mode: 'session', session: { expectedInputs: 5, renew: true, maxRenewals: 1 } });
  assert.deepEqual(strings, {
    EXEC_MODE: 'session', EXEC_DURATION_HOURS: '1', EXEC_PARALLELISM: '1', EXEC_MAX_CU: '0',
    EXEC_HEADROOM_PERCENT: '25', EXEC_SESSION_EXPECTED_INPUTS: '5', EXEC_SESSION_KEEP_OPEN: 'false',
    EXEC_SESSION_RENEW: 'true', EXEC_SESSION_MAX_RENEWALS: '1', EXEC_ESR_EXPECTED_COMMITS: '0',
  });
  assert.deepEqual(execution.validate(execution.fromEnv(strings)), execution.validate({
    mode: 'session', session: { expectedInputs: 5, renew: true, maxRenewals: 1 },
  }));
  assert.throws(() => execution.toEnv({ mode: 'batch' }), { message: spec.validationCases[0].error });
});

test('esrEnabled reads ESR_ENABLED as ecld-init writes it', () => {
  assert.equal(execution.esrEnabled({ ESR_ENABLED: 'true' }), true);
  assert.equal(execution.esrEnabled({ ESR_ENABLED: 'false' }), false);
  assert.equal(execution.esrEnabled({}), false);
});

test('relaysPerHour is 1 + expectedInputs rows, plus 10 commits with ESR', () => {
  assert.equal(execution.ESR_COMMITS_PER_HOUR, 10);
  assert.equal(execution.relaysPerHour({}, false), 2);
  assert.equal(execution.relaysPerHour({}, true), 12);
  assert.equal(execution.relaysPerHour({ session: { expectedInputs: 5 } }, false), 6);
  assert.equal(execution.relaysPerHour({ mode: 'session', session: { expectedInputs: 256 } }, true), 267);
  assert.throws(() => execution.relaysPerHour({ session: { expectedInputs: 0 } }, false),
    { message: spec.validationCases[6].error });
});

test('validate returns a fresh object: DEFAULTS stay frozen and untouched', () => {
  const out = execution.validate({});
  out.session.expectedInputs = 9;
  assert.equal(execution.DEFAULTS.session.expectedInputs, 1);
  assert.ok(Object.isFrozen(execution.DEFAULTS.session));
});
