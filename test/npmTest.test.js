// npm test (scripts/run-tests.js): node's test runner is given every test
// file of the package, the *.test.js files under test/, by its path, and no
// glob pattern, which the runner of Node 18 and 20 does not take. With no
// path the runner would also take test.js at the package's root (the
// ecld-test command), demo/src/App.test.js and the helpers under test/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

// The *.test.js files under test/, by their paths from the package's root.
const testFiles = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  if (entry.isDirectory()) return testFiles(`${dir}/${entry.name}`);
  return entry.name.endsWith('.test.js') ? [`${dir}/${entry.name}`] : [];
});

test('npm test is scripts/run-tests.js, which passes node --test the path of every test file and nothing else', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test, 'node scripts/run-tests.js');
  // What the launcher passes to the runner: the runner it starts preloads
  // helpers/print_arguments.js, which prints the paths in place of running
  // them.
  const printer = path.join(__dirname, 'helpers', 'print_arguments.js').replace(/\\/g, '/');
  const launched = spawnSync(process.execPath, [path.join(root, 'scripts', 'run-tests.js')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require "${printer}"` }
  });
  assert.equal(launched.status, 0, launched.stderr);
  const [flag, ...files] = launched.stdout.trim().split('\n').pop().split(' ');
  assert.equal(flag, '--test');
  assert.deepEqual([...files].sort(), testFiles('test').sort());
  assert.ok(files.includes('test/npmTest.test.js'));
  for (const file of files) assert.doesNotMatch(file, /[*?[\]{}]/, file);
  // The files the runner's own search would add.
  for (const other of ['test.js', 'demo/src/App.test.js', 'test/helpers/securelock_app.js']) {
    assert.ok(fs.existsSync(path.join(root, other)), other);
    assert.ok(!files.includes(other), other);
  }
});
