// npm test: node's test runner on every test file of the package, the
// *.test.js files under test/, each passed to it by its path.
//
// A path is what every release of the runner takes. Node 18 and 20 execute
// the files they are given and take no glob pattern; Node 21 and later take
// glob patterns, of which a path without a wildcard is one that names its
// file. The runner's own search is not used: with no path it also takes
// test.js at the package's root (the ecld-test command), demo/src/App.test.js
// and every .js file under test/, the helpers among them.
'use strict';

const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');

// The test files under `dir`, a path from the package's root, by their paths
// from the root with forward slashes.
const testFiles = (dir) => readdirSync(path.join(root, dir), { withFileTypes: true })
  .sort((a, b) => (a.name < b.name ? -1 : 1))
  .flatMap((entry) => {
    if (entry.isDirectory()) return testFiles(`${dir}/${entry.name}`);
    return entry.name.endsWith('.test.js') ? [`${dir}/${entry.name}`] : [];
  });

const { status } = spawnSync(process.execPath, ['--test', ...testFiles('test')], { cwd: root, stdio: 'inherit' });
process.exit(status === null ? 1 : status);
