/* The runner-side execution object (test/fixtures/execution-spec.json): keys,
 * defaults and bounds, the ten validation messages the SDKs and the runners
 * share, the normalization of a legacy flat resources object, the EXEC_*
 * keys of the project's .env, and the relaysPerHour default.
 *
 * Pure CJS, loaded with require (ecld-run, ecld-init, ecld-info) and with
 * createRequire from the Hello World template's src/preStart.mjs. */

'use strict';

// Values are checked after parsing: a value from a .env string is parsed to a
// number or boolean by fromEnv before validate sees it.
const SCHEMA = [
  { key: 'mode', type: 'string', values: ['task', 'session'],
    message: 'execution.mode must be "task" or "session"' },
  { key: 'durationHours', type: 'integer', min: 1, max: 65535,
    message: 'execution.durationHours must be an integer between 1 and 65535' },
  { key: 'parallelism', type: 'integer', min: 1,
    message: 'execution.parallelism must be an integer >= 1' },
  { key: 'maxCu', type: 'integer', min: 0,
    message: 'execution.maxCu must be an integer >= 0 (thousandths of a CU, 0 = any node)' },
  { key: 'headroomPercent', type: 'integer', min: 0, max: 100,
    message: 'execution.headroomPercent must be an integer between 0 and 100' },
  { key: 'session.expectedInputs', type: 'integer', min: 1, max: 256,
    message: 'execution.session.expectedInputs must be an integer between 1 and 256' },
  { key: 'session.keepOpen', type: 'boolean',
    message: 'execution.session.keepOpen must be true or false' },
  { key: 'session.renew', type: 'boolean',
    message: 'execution.session.renew must be true or false' },
  { key: 'session.maxRenewals', type: 'integer', min: 0,
    message: 'execution.session.maxRenewals must be an integer >= 0' },
  { key: 'esr.expectedCommits', type: 'integer', min: 0, max: 100,
    message: 'execution.esr.expectedCommits must be an integer between 0 and 100' },
];

const RENEW_MESSAGE = 'execution.session.maxRenewals must be >= 1 when execution.session.renew is true';

const DEFAULTS = Object.freeze({
  mode: 'task',
  durationHours: 1,
  parallelism: 1,
  maxCu: 0,
  headroomPercent: 25,
  session: Object.freeze({ expectedInputs: 1, keepOpen: false, renew: false, maxRenewals: 0 }),
  esr: Object.freeze({ expectedCommits: 0 }),
});

// The .env keys, one per schema key in schema order; ecld-init writes every
// one, ecld-run, ecld-info and the template's preStart read them.
const ENV_KEYS = Object.freeze([
  ['EXEC_MODE', 'mode'],
  ['EXEC_DURATION_HOURS', 'durationHours'],
  ['EXEC_PARALLELISM', 'parallelism'],
  ['EXEC_MAX_CU', 'maxCu'],
  ['EXEC_HEADROOM_PERCENT', 'headroomPercent'],
  ['EXEC_SESSION_EXPECTED_INPUTS', 'session.expectedInputs'],
  ['EXEC_SESSION_KEEP_OPEN', 'session.keepOpen'],
  ['EXEC_SESSION_RENEW', 'session.renew'],
  ['EXEC_SESSION_MAX_RENEWALS', 'session.maxRenewals'],
  ['EXEC_ESR_EXPECTED_COMMITS', 'esr.expectedCommits'],
]);

// Commits relayed per hour of an order with the Enclave State Registry
// enabled, added to the rows in the relaysPerHour default.
const ESR_COMMITS_PER_HOUR = 10;

const TRUE_WORDS = /^(1|true|yes|y|on)$/i;
const FALSE_WORDS = /^(0|false|no|n|off)$/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(o[k])) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

// The keys of the top level (the flat schema keys and the two blocks) and of
// each block, from the schema.
const KNOWN_KEYS = Object.freeze({
  execution: SCHEMA.map((f) => f.key).filter((k) => !k.includes('.')).concat(['session', 'esr']),
  'execution.session': SCHEMA.map((f) => f.key).filter((k) => k.startsWith('session.')).map((k) => k.split('.')[1]),
  'execution.esr': SCHEMA.map((f) => f.key).filter((k) => k.startsWith('esr.')).map((k) => k.split('.')[1]),
});

function checkUnknownKeys(obj, level) {
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS[level].includes(key)) throw new Error(`${level} has an unknown key ${JSON.stringify(key)}`);
  }
}

/* Returns the complete execution object: every key of the input checked in
 * schema order, every missing key at its default. Throws an Error with the
 * fixture's message on the first failing check: the unknown keys of the top
 * level, then of the session and esr blocks, are checked before any value,
 * then the values in schema order; null is not a value. */
function validate(execution) {
  const input = execution === undefined ? {} : execution;
  if (!isPlainObject(input)) throw new Error('execution must be an object');
  checkUnknownKeys(input, 'execution');
  for (const block of ['session', 'esr']) {
    if (input[block] !== undefined) {
      if (!isPlainObject(input[block])) throw new Error(`execution.${block} must be an object`);
      checkUnknownKeys(input[block], `execution.${block}`);
    }
  }
  const out = { ...DEFAULTS, session: { ...DEFAULTS.session }, esr: { ...DEFAULTS.esr } };
  for (const field of SCHEMA) {
    const given = getPath(input, field.key);
    const value = given === undefined ? getPath(DEFAULTS, field.key) : given;
    if (field.type === 'string') {
      if (!field.values.includes(value)) throw new Error(field.message);
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(field.message);
    } else if (!Number.isInteger(value) || value < field.min || (field.max !== undefined && value > field.max)) {
      throw new Error(field.message);
    }
    if (field.key === 'session.maxRenewals' && out.session.renew && value < 1) throw new Error(RENEW_MESSAGE);
    setPath(out, field.key, value);
  }
  return out;
}

/* A resources object as runner.run takes it, flat (legacy: duration) or with
 * a nested execution: returns the flat resources without duration and
 * execution, and the complete execution object; duration becomes
 * execution.durationHours unless execution.durationHours is given. */
function normalize(resources) {
  if (!isPlainObject(resources)) throw new Error('resources must be an object');
  const { duration, execution, ...rest } = resources;
  const given = execution === undefined ? {} : execution;
  if (!isPlainObject(given)) throw new Error('execution must be an object');
  const merged = duration !== undefined && given.durationHours === undefined
    ? { ...given, durationHours: duration }
    : given;
  return { resources: rest, execution: validate(merged) };
}

// A decimal integer or decimal fraction ("3", "+3", "1.5") is parsed to a
// number (validate then checks it is an integer in range); any other string,
// an exponent ("1e2") or a bare trailing point ("3.") included, is kept for
// validate to name the key.
function parseNumber(s) {
  return /^[+-]?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
}

function parseBoolean(s) {
  if (TRUE_WORDS.test(s)) return true;
  if (FALSE_WORDS.test(s)) return false;
  return s;
}

/* The execution keys set in an environment (process.env, or a parsed .env),
 * read from <prefix>EXEC_* and parsed to numbers and booleans; an unset or
 * blank variable leaves its key to the default. Not validated. */
function fromEnv(env, prefix = '') {
  const out = {};
  for (const [name, key] of ENV_KEYS) {
    const raw = env[prefix + name];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const s = String(raw).trim();
    const type = SCHEMA.find((f) => f.key === key).type;
    setPath(out, key, type === 'string' ? s : type === 'boolean' ? parseBoolean(s) : parseNumber(s));
  }
  return out;
}

/* The EXEC_* strings of a complete execution object, one per ENV_KEYS entry. */
function toEnv(execution) {
  const complete = validate(execution);
  const out = {};
  for (const [name, key] of ENV_KEYS) out[name] = String(getPath(complete, key));
  return out;
}

/* Whether ESR_ENABLED, as ecld-init writes it, is set. */
function esrEnabled(env) {
  return TRUE_WORDS.test(String(env.ESR_ENABLED || '').trim());
}

/* The relays an order needs per hour of durationHours: the etny-sw row plus
 * one etny-so row per expected input, plus ESR_COMMITS_PER_HOUR commits when
 * the Enclave State Registry is enabled. A --relays-per-hour value wins. */
function relaysPerHour(execution, withEsr) {
  const complete = validate(execution);
  return 1 + complete.session.expectedInputs + (withEsr ? ESR_COMMITS_PER_HOUR : 0);
}

module.exports = {
  SCHEMA, DEFAULTS, ENV_KEYS, ESR_COMMITS_PER_HOUR,
  validate, normalize, fromEnv, toEnv, esrEnabled, relaysPerHour,
};
