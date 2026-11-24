// test/fixtures holds byte-identical copies of pox-smart-contract-litvm's
// spec/*.json and spec/metadata-keys.md at SOURCE_COMMIT, and
// MANIFEST.sha256, the lines of that commit's spec/MANIFEST.sha256 for the
// copies held, in the sha256sum text format (`sha256sum -c MANIFEST.sha256`
// in test/fixtures checks every copy). The copies must hash to the manifest
// and the manifest must name exactly the fixtures present. Where a
// pox-smart-contract-litvm checkout is found (POX_SMART_CONTRACT_LITVM, else
// a directory of that name beside this repository or beside any directory
// above it), every copy must equal `git show SOURCE_COMMIT:spec/<name>` and
// every manifest line that commit's line, never the checkout's working tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FIXTURES = path.join(__dirname, 'fixtures');
const MANIFEST = 'MANIFEST.sha256';
const LITVM_ENV = 'POX_SMART_CONTRACT_LITVM';
const SOURCE_COMMIT = '2f600f6';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function manifestEntries(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const m = /^([0-9a-f]{64})  (\S+)$/.exec(line);
    assert.ok(m, `manifest line is not "<sha256>  <name>": ${JSON.stringify(line)}`);
    entries.push({ hash: m[1], name: m[2] });
  }
  return entries;
}

function fixtureNames() {
  return fs.readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json') || name === 'metadata-keys.md')
    .sort();
}

// The pox-smart-contract-litvm checkout: POX_SMART_CONTRACT_LITVM, else the
// first directory of that name beside this repository or beside a directory
// above it; null when none holds a .git.
function litvmCheckout() {
  const candidates = [];
  if (process.env[LITVM_ENV]) candidates.push(path.resolve(process.env[LITVM_ENV]));
  for (let dir = path.resolve(__dirname, '..'); ; dir = path.dirname(dir)) {
    candidates.push(path.join(path.dirname(dir), 'pox-smart-contract-litvm'));
    if (path.dirname(dir) === dir) break;
  }
  return candidates.find((c) => fs.existsSync(path.join(c, '.git'))) || null;
}

// `git show SOURCE_COMMIT:spec/<name>` in `checkout`, or null when the
// checkout holds no such commit.
function shownAtSource(checkout, name) {
  try {
    return execFileSync('git', ['-C', checkout, 'show', `${SOURCE_COMMIT}:spec/${name}`],
      { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return null;
  }
}

test('the manifest is LF-terminated sha256sum text in bytewise name order', () => {
  const text = fs.readFileSync(path.join(FIXTURES, MANIFEST), 'latin1');
  assert.ok(!text.includes('\r'), 'manifest holds a CR');
  assert.ok(text.endsWith('\n'), 'manifest does not end with LF');
  const names = manifestEntries(text).map((e) => e.name);
  assert.deepEqual(names, [...names].sort(), 'manifest names are not in bytewise order');
});

test('every fixture copy hashes to its manifest line', () => {
  const entries = manifestEntries(fs.readFileSync(path.join(FIXTURES, MANIFEST), 'utf8'));
  assert.ok(entries.length > 0);
  for (const { hash, name } of entries) {
    const file = path.join(FIXTURES, name);
    assert.ok(fs.existsSync(file), `${name} is in the manifest but not in test/fixtures`);
    assert.equal(sha256(fs.readFileSync(file)), hash, `${name} does not hash to the manifest`);
  }
});

test('the manifest names exactly the fixtures present', () => {
  const entries = manifestEntries(fs.readFileSync(path.join(FIXTURES, MANIFEST), 'utf8'));
  assert.deepEqual(entries.map((e) => e.name), fixtureNames());
});

test('the copies and the manifest lines are the source commit\'s', (t) => {
  const checkout = litvmCheckout();
  if (checkout === null) {
    t.skip(`no pox-smart-contract-litvm checkout found (set ${LITVM_ENV})`);
    return;
  }
  const source = shownAtSource(checkout, MANIFEST);
  assert.ok(source !== null, `${checkout} holds no commit ${SOURCE_COMMIT}`);
  const lines = new Map(manifestEntries(source.toString('utf8')).map((e) => [e.name, e.hash]));
  for (const { hash, name } of manifestEntries(fs.readFileSync(path.join(FIXTURES, MANIFEST), 'utf8'))) {
    assert.equal(hash, lines.get(name), `the manifest line of ${name} is not ${SOURCE_COMMIT}'s`);
  }
  for (const name of fixtureNames()) {
    const ours = fs.readFileSync(path.join(FIXTURES, name));
    assert.ok(ours.equals(shownAtSource(checkout, name)), `test/fixtures/${name} differs from ${SOURCE_COMMIT}:spec/${name}`);
  }
});
