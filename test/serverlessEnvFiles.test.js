// ecld-build refuses a .env file in the project's src/serverless.
//
// Both build entries (nodenithy/build.mjs, pynithy/build.mjs) copy
// src/serverless into the securelock's image, and the image is published: its
// files are measured, not encrypted, and the enclaves read no .env file from
// the image. Each entry ends with status 1, before it removes, copies or
// builds anything, when the directory holds a file named .env or
// .env.<anything> at any depth, and its message names each by its path
// (serverlessEnvFiles.js). A file whose name only contains "env" is not
// refused, nor is a directory named .env.
//
// The entries run the build when loaded, so each is started as a process in a
// scratch project with a PATH that holds no program: it finds no docker, and a
// build the refusal does not end stops at its first docker command that must
// succeed, after it copied src/serverless.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { find, refusal } = require('../serverlessEnvFiles.js');

const ROOT = path.join(__dirname, '..');
const HEAD = 'ERROR: src/serverless holds a file named .env or .env.<name>:';
const TAIL = [
  '       Everything in src/serverless is published with the enclave image and readable by anyone.',
  '       A secret belongs in the task\'s payload or input, which are encrypted for the enclave.',
  '       Remove each file listed from src/serverless before building.',
];
// Names that are not .env and not .env.<anything>.
const OTHER_NAMES = ['env.js', 'config.env.json', '.envrc', '.environment', 'dotenv', 'a.env', 'env', '.env_local', 'x.env.production'];
// Each entry, its backend file and the directory it copies src/serverless into.
const ENTRIES = [
  { entry: 'nodenithy/build.mjs', backend: ['backend.js', 'module.exports = {};\n'], dest: 'node_modules/@ethernity-cloud/sdk-js/nodenithy/build/securelock/src/serverless' },
  { entry: 'pynithy/build.mjs', backend: ['backend.py', 'x = 1\n'], dest: 'node_modules/@ethernity-cloud/sdk-js/pynithy/build/securelock/src/serverless' },
];
// The variables of the test's own environment an entry reads.
const ENTRY_VARIABLE = /^(path|blockchain_network|trusted_zone_image|project_name|version|memory_to_allocate|ecld_.*|esr_.*)$/i;

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverless-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root, rel, content = 'x\n') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tree(root) {
  const walk = (dir, prefix) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    return e.isDirectory() ? [rel, ...walk(path.join(dir, e.name), rel)] : [rel];
  });
  return walk(root, '').sort();
}

// A dApp project of `entry` in a scratch directory: its backend and `names`,
// paths relative to src/serverless.
function project(t, entry, names) {
  const dir = path.join(scratch(t), 'project');
  put(dir, `src/serverless/${entry.backend[0]}`, entry.backend[1]);
  for (const name of names) put(dir, `src/serverless/${name}`);
  return dir;
}

function build(t, entry, dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !ENTRY_VARIABLE.test(key)));
  env.PATH = scratch(t);
  const run = spawnSync(process.execPath, [path.join(ROOT, entry.entry)], { cwd: dir, env, encoding: 'utf8' });
  return { status: run.status, lines: run.stderr.split(/\r?\n/).filter((line) => line !== '') };
}

function link(t, target, name, type) {
  try {
    fs.symlinkSync(target, name, type);
    return true;
  } catch (error) {
    t.skip(`this host makes no symbolic link: ${error.code}`);
    return false;
  }
}

test('the refusal names each file by its path under src/serverless, between its fixed lines', () => {
  assert.deepEqual(refusal(['.env']), [HEAD, '       src/serverless/.env', ...TAIL]);
  assert.deepEqual(refusal(['.env', 'conf/.env.production']),
    [HEAD, '       src/serverless/.env', '       src/serverless/conf/.env.production', ...TAIL]);
});

test('find lists .env and .env.<anything> at any depth, by path, in order', (t) => {
  const dir = scratch(t);
  for (const name of ['svc/api/.env.local', '.env', 'a/.env', '.env.production.bak', 'backend.js']) put(dir, name);
  assert.deepEqual(find(dir), ['.env', '.env.production.bak', 'a/.env', 'svc/api/.env.local']);
});

test('find lists no file whose name only holds "env"', (t) => {
  const dir = scratch(t);
  for (const name of OTHER_NAMES) {
    put(dir, name);
    put(dir, `lib/${name}`);
  }
  assert.deepEqual(find(dir), []);
});

test('a directory named .env is entered and not listed', (t) => {
  const dir = scratch(t);
  put(dir, '.env/settings.js');
  put(dir, '.env.d/a.js');
  assert.deepEqual(find(dir), []);
  put(dir, '.env.d/.env');
  assert.deepEqual(find(dir), ['.env.d/.env']);
});

test('a directory that does not exist holds none', (t) => {
  assert.deepEqual(find(path.join(scratch(t), 'src', 'serverless')), []);
});

test('a name with a line break after .env. is listed', (t) => {
  if (process.platform === 'win32') {
    t.skip('no file name holds a line break on this host');
    return;
  }
  const dir = scratch(t);
  put(dir, '.env.a\nb');
  assert.deepEqual(find(dir), ['.env.a\nb']);
});

test('a link named .env is listed, and a linked directory is entered once', (t) => {
  const outer = scratch(t);
  const dir = path.join(outer, 'serverless');
  put(dir, 'conf/settings.js');
  put(outer, 'outside/.env.staging');
  put(outer, 'secrets.txt');
  if (!link(t, path.join(outer, 'secrets.txt'), path.join(dir, '.env'), 'file')) return;
  link(t, path.join(outer, 'outside'), path.join(dir, 'shared'), 'dir');
  link(t, dir, path.join(dir, 'conf', 'again'), 'dir');
  link(t, path.join(outer, 'none'), path.join(dir, 'conf', '.env.gone'), 'file');
  assert.deepEqual(find(dir), ['.env', 'conf/.env.gone', 'shared/.env.staging']);
});

test('the package ships serverlessEnvFiles.js, and each entry asks it before its first removal, copy or command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('serverlessEnvFiles.js'));
  for (const { entry } of ENTRIES) {
    const source = fs.readFileSync(path.join(ROOT, entry), 'utf8');
    assert.equal(source.split('require(\'../serverlessEnvFiles.js\')').length, 2, entry);
    const check = source.indexOf('serverlessEnvFiles.find(\'./src/serverless\')');
    assert.ok(check > 0, entry);
    for (const later of ['shell.rm(', 'shell.exec(', 'runCommand(', 'removeContainer)', 'fs.cpSync(', 'fs.copyFileSync(', 'fs.mkdirSync(', 'fs.rmSync(', 'writeEnv(\'']) {
      const at = source.indexOf(later);
      assert.ok(at === -1 || at > check, `${entry}: ${later}`);
    }
  }
});

for (const entry of ENTRIES) {
  test(`${entry.entry}: src/serverless/.env ends the build with status 1, the file named and nothing copied`, (t) => {
    const dir = project(t, entry, ['.env']);
    const before = tree(dir);
    const run = build(t, entry, dir);
    assert.deepEqual(run.lines, [HEAD, '       src/serverless/.env', ...TAIL]);
    assert.equal(run.status, 1);
    assert.deepEqual(tree(dir), before);
  });

  test(`${entry.entry}: a nested src/serverless/conf/.env.production ends the build with status 1, the file named and nothing copied`, (t) => {
    const dir = project(t, entry, ['conf/.env.production', 'conf/settings.txt']);
    const before = tree(dir);
    const run = build(t, entry, dir);
    assert.deepEqual(run.lines, [HEAD, '       src/serverless/conf/.env.production', ...TAIL]);
    assert.equal(run.status, 1);
    assert.deepEqual(tree(dir), before);
  });

  test(`${entry.entry}: env.js, config.env.json and the project's own .env are not refused: the build copies src/serverless and goes on`, (t) => {
    const dir = project(t, entry, OTHER_NAMES);
    put(dir, '.env', 'A=1\n');
    const run = build(t, entry, dir);
    assert.ok(!run.lines.some((line) => line === HEAD || TAIL.includes(line)), run.lines.join('\n'));
    assert.ok(run.lines.includes('Error executing command: docker pull registry:2'), run.lines.join('\n'));
    assert.equal(run.status, 1);
    for (const name of [entry.backend[0], ...OTHER_NAMES]) assert.ok(fs.existsSync(path.join(dir, entry.dest, name)), name);
  });
}

test('the Python SDK\'s build prints the same lines', async (t) => {
  const { pythonSdkDir, ENV_VAR } = await import('../scripts/sync-pynithy.mjs');
  const file = path.join(pythonSdkDir(), 'ethernity_cloud_sdk_py', 'commands', 'pynithy', 'build.py');
  if (!fs.existsSync(file)) {
    t.skip(`no Python SDK checkout at ${pythonSdkDir()} (set ${ENV_VAR})`);
    return;
  }
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const line of [HEAD, ...TAIL]) assert.ok(source.includes(`    print(${JSON.stringify(line)})\n`), line);
  assert.ok(source.includes('        print(f"       src/serverless/{name}")\n'));
});
