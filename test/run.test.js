// ecld-run's flags: --task-price takes a fractional ECLD amount and refuses
// anything that is not a non-negative number; the execution flags override
// the EXEC_* keys of .env, --duration maps to durationHours, and the
// relays-per-hour default follows execution.js unless the flag names it; an
// unknown option is a usage error and the CLI exits 2 before it submits.
// Without a signing key the CLI exits 1 naming ECLD_PRIVATE_KEY and
// ECLD_KEY_PASSWORD; with ENC_PRIVATE_KEY in .env and no terminal it exits 2
// unless ECLD_KEY_PASSWORD decrypts it; neither submits. The claims flags
// reach run()'s options (runOptionsFor): with --bid-wei the V2 terms, the
// execution's maxGflops and the relays per hour among them, each value in
// the runners' bounds; a V2 flag without --bid-wei is a usage error; without
// a claims flag the options are the input dataset alone; the runner's
// refusal of a request without a bid ends the run with exit 1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseArgs, executionFor, relaysPerHourFor, runOptionsFor, UsageError } = require('../run.js');
const { DEFAULTS } = require('../execution.js');
const { reportRun } = require('../runReport.js');

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
    '--mode', 'session', '--duration', '3', '--parallelism', '2', '--max-gflops', '150', '--headroom', '10',
    '--expected-inputs', '5', '--keep-open', '--renew', '--max-renewals', '2', '--expected-commits', '4',
    '--relays-per-hour', '20', 'hello()',
  ]);
  assert.deepEqual(opts.execution, {
    mode: 'session', durationHours: 3, parallelism: 2, maxGflops: 150, headroomPercent: 10,
    session: { expectedInputs: 5, keepOpen: true, renew: true, maxRenewals: 2 },
    esr: { expectedCommits: 4 },
  });
  assert.equal(opts.relaysPerHour, 20);
  assert.equal(parseArgs(['--duration-hours', '4']).opts.execution.durationHours, 4);
  assert.deepEqual(parseArgs(['--no-keep-open', '--no-renew']).opts.execution.session, { keepOpen: false, renew: false });
  assert.equal('duration' in parseArgs([]).opts, false);
});

test('--max-gflops 150 gives maxGflops 150', () => {
  const { opts, positional } = parseArgs(['--max-gflops', '150', 'hello()']);
  assert.deepEqual(opts.execution, { maxGflops: 150 });
  assert.deepEqual(positional, ['hello()']);
  assert.equal(executionFor(opts, {}).maxGflops, 150);
  assert.equal(executionFor(parseArgs([]).opts, { EXEC_MAX_GFLOPS: '150' }).maxGflops, 150);
  assert.throws(() => parseArgs(['--max-gflops', '1.5']), { message: '--max-gflops takes a non-negative integer, got "1.5"' });
});

test('an unknown option is a usage error; a code string, a number and a spaced argument are payload', () => {
  assert.throws(() => parseArgs(['--max-cu', '150', 'hello()']), UsageError);
  assert.throws(() => parseArgs(['--max-cu', '150', 'hello()']), { message: 'unknown option --max-cu' });
  assert.throws(() => parseArgs(['hello()', '--cu']), { message: 'unknown option --cu' });
  assert.throws(() => parseArgs(['-x']), { message: 'unknown option -x' });
  assert.deepEqual(parseArgs(['-1', '-2.5', '- x', 'hello("--max-cu")']).positional, ['-1', '-2.5', '- x', 'hello("--max-cu")']);
});

test('ecld-run --max-cu 150 exits 2 with the usage error and submits nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-run-'));
  try {
    const env = { ...process.env, ECLD_PRIVATE_KEY: '', PRIVATE_KEY: '', ECLD_KEY_PASSWORD: '', ENC_PRIVATE_KEY: '' };
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'run.js'), '--max-cu', '150', 'hello()'],
      { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^ecld-run: unknown option --max-cu\n\n/);
    assert.ok(!r.stdout.includes('submitting order'), r.stdout);
    assert.ok(!r.stdout.includes('payload'), r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ecld-run with `args` in a scratch project whose .env is `envFile`, with
// `env` over an environment without the key variables and stdin not a
// terminal.
function ecldRun(envFile, env, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-run-key-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), envFile);
    const base = { ...process.env };
    for (const name of ['PRIVATE_KEY', 'ECLD_PRIVATE_KEY', 'ECLD_KEY_PASSWORD', 'ENC_PRIVATE_KEY']) delete base[name];
    return spawnSync(process.execPath, [path.join(__dirname, '..', 'run.js'), ...args],
      { cwd: dir, input: '', env: { ...base, ...env }, encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ecld-run without a signing key exits 1 naming ECLD_PRIVATE_KEY and ECLD_KEY_PASSWORD and submits nothing', () => {
  const r = ecldRun('PROJECT_NAME=demo\n', {}, ['hello()']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^ecld-run: no signing key\. Set ECLD_PRIVATE_KEY \(a funded 0x key\), or keep the key encrypted in \.env as ENC_PRIVATE_KEY, which ecld-publish writes, and set ECLD_KEY_PASSWORD to its password or enter the password when asked\.$/m);
  assert.ok(!r.stdout.includes('submitting order'), r.stdout);
});

test('ecld-run with ENC_PRIVATE_KEY in .env and no terminal exits 2 without ECLD_KEY_PASSWORD or with a wrong one', () => {
  const { encPrivateKey } = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'sdk-py-enc-private-key.json'), 'utf8')).vectors[0];
  const envFile = `PROJECT_NAME=demo\nENC_PRIVATE_KEY=${encPrivateKey}\n`;
  const unattended = ecldRun(envFile, {}, ['hello()']);
  assert.equal(unattended.status, 2, unattended.stdout + unattended.stderr);
  assert.match(unattended.stderr, /^ecld-run: The stored key \(ENC_PRIVATE_KEY in \.env\) is encrypted and there is no terminal to ask for its password: set ECLD_KEY_PASSWORD, or ECLD_PRIVATE_KEY, for an unattended run\.$/m);
  const wrong = ecldRun(envFile, { ECLD_KEY_PASSWORD: 'wrong' }, ['hello()']);
  assert.equal(wrong.status, 2, wrong.stdout + wrong.stderr);
  assert.match(wrong.stderr, /^ecld-run: ECLD_KEY_PASSWORD does not decrypt the stored key \(ENC_PRIVATE_KEY in \.env\)\.$/m);
  for (const r of [unattended, wrong]) assert.ok(!r.stdout.includes('submitting order'), r.stdout);
});

test('executionFor refuses an EXEC_MAX_CU in .env naming the variable', () => {
  assert.throws(() => executionFor(parseArgs(['--max-gflops', '150']).opts, { EXEC_MAX_CU: '1500' }),
    { message: /^execution has an unknown variable "EXEC_MAX_CU" \(the execution variables: EXEC_MODE, / });
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

// runOptionsFor of `args`, with the execution and the relays per hour they
// give over an empty .env, and `input` as the input dataset.
function runOptionsOf(args, input = null) {
  const { opts } = parseArgs(args);
  const exec = executionFor(opts, {});
  return runOptionsFor(opts, exec, relaysPerHourFor(opts, {}, exec), input);
}

test('without a claims flag run() takes the input dataset alone', () => {
  assert.deepEqual(runOptionsOf([], 'a,b'), { inputData: 'a,b' });
  assert.deepEqual(runOptionsOf(['--max-gflops', '150', '--relays-per-hour', '3']), { inputData: null });
});

test('--bid-wei adds the V2 terms with the GFLOPS ceiling and the relays per hour, and each claims flag reaches its key', () => {
  assert.deepEqual(runOptionsOf(['--bid-wei', '1200000000000000000']), {
    inputData: null,
    v2: { maxGflops: 0, relaysPerHour: 2, maxPricePerCuHourWei: 1200000000000000000n },
  });
  const options = runOptionsOf([
    '--bid-wei', '340282366920938463463374607431768211455', '--bid-ceiling-wei', '2000000000000000000',
    '--escrow-wei', '5000000000000000000', '--required-gflops', '250', '--gas-level', '2000000000000000000',
    '--epc-mib', '256', '--max-gflops', '400', '--relays-per-hour', '7', '--expected-inputs', '5',
    '--min-node-score', '0.5', '--allow-marked-image',
  ], 'x');
  assert.deepEqual(options, {
    inputData: 'x',
    v2: {
      maxGflops: 400, relaysPerHour: 7,
      maxPricePerCuHourWei: (1n << 128n) - 1n, maxBidPerCuHourWei: 2000000000000000000n,
      escrowWei: 5000000000000000000n, requiredGflops: 250, gasLevel: 2000000000000000000n, epcMiB: 256,
    },
    minNodeScore: 0.5,
    allowMarkedImage: true,
  });
  assert.equal(runOptionsOf(['--bid-wei', '1', '--expected-inputs', '5']).v2.relaysPerHour, 6);
  assert.deepEqual(runOptionsOf(['--min-node-score', '0']), { inputData: null, minNodeScore: 0 });
});

test('a claims flag outside the runners\' bounds is a usage error', () => {
  const refused = [
    ['--bid-wei', '0'], ['--bid-wei', '1.5'], ['--bid-wei', '340282366920938463463374607431768211456'], ['--bid-wei', '-1'],
    ['--bid-wei', '1', '--bid-ceiling-wei', '0'], ['--bid-wei', '1', '--escrow-wei', '0'],
    ['--bid-wei', '1', '--gas-level', '999999999999999999'], ['--bid-wei', '1', '--required-gflops', '65536'],
    ['--bid-wei', '1', '--epc-mib', '0'], ['--bid-wei', '1', '--epc-mib', '4194241'], ['--bid-wei'],
    ['--min-node-score', '5.01'], ['--min-node-score', '-1'], ['--min-node-score', 'x'], ['--min-node-score', '.5'],
  ];
  for (const args of refused) assert.throws(() => parseArgs(args), UsageError, args.join(' '));
  assert.throws(() => parseArgs(['--bid-wei', '0']), { message: '--bid-wei takes a whole number from 1 to 340282366920938463463374607431768211455, got 0' });
  assert.equal(parseArgs(['--bid-wei', '1', '--epc-mib', '4194240']).opts.claims.epcMiB, 4194240);
  assert.equal(parseArgs(['--bid-wei', '1', '--gas-level', '1000000000000000000']).opts.claims.gasLevel, 10n ** 18n);
});

test('a V2 term without --bid-wei is a usage error; --min-node-score and --allow-marked-image stand alone', () => {
  for (const flag of ['--bid-ceiling-wei', '--escrow-wei', '--gas-level', '--required-gflops', '--epc-mib']) {
    const value = flag === '--gas-level' ? '1000000000000000000' : '64';
    assert.throws(() => parseArgs([flag, value]), { message: `${flag} states a V2 term of the request, which is added with V2 terms only with --bid-wei` });
  }
  assert.deepEqual(runOptionsOf(['--allow-marked-image']), { inputData: null, allowMarkedImage: true });
});

test('ecld-run hands run() the options runOptionsFor gives', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'run.js'), 'utf8');
  assert.ok(src.includes('const runOptions = runOptionsFor(opts, exec, relaysPerHour, input);'));
  assert.ok(src.includes('runner.run(resources, securelock, code, opts.node, trustedzone || null, runOptions)'));
});

test('the runner\'s refusal of a request without a bid on a claims network ends ecld-run with exit 1 and its message', async () => {
  const refusal = 'This network serves DO requests by claims (PoxMatching\'s claimsOn() is true), so a request is added with V2 terms: pass options.v2 with maxPricePerCuHourWei; its escrowWei, when given, is the most addDORequestV2 may pull.';
  const runner = { getResultTaskCode: () => null, getResult: async () => null, getLastError: () => null };
  const lines = [];
  const code = await reportRun(runner, { error: refusal }, { out: (l) => lines.push(['out', l]), err: (l) => lines.push(['err', l]) });
  assert.equal(code, 1);
  assert.deepEqual(lines, [['err', '\nstatus     : ERROR'], ['err', `error      : ${refusal}`]]);
});
