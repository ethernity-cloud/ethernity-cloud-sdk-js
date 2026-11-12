// test/fixtures holds byte-identical copies of pox-smart-contract-litvm's
// spec/*.json and spec/metadata-keys.md with its spec/MANIFEST.sha256, the
// SHA-256 of every fixture in the sha256sum text format. The copies must hash
// to the manifest, the manifest must name exactly the fixtures present, and,
// where a litvm checkout is reachable (POX_SMART_CONTRACT_LITVM, else the
// sibling ../pox-smart-contract-litvm), every copy must equal its source bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const MANIFEST = 'MANIFEST.sha256';
const LITVM_ENV = 'POX_SMART_CONTRACT_LITVM';
const LITVM_DEFAULT = path.join(__dirname, '..', '..', 'pox-smart-contract-litvm');

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

test('the copies equal the litvm spec bytes when a checkout is reachable', (t) => {
  const spec = path.join(path.resolve(process.env[LITVM_ENV] || LITVM_DEFAULT), 'spec');
  if (!fs.existsSync(path.join(spec, MANIFEST))) {
    t.skip(`no pox-smart-contract-litvm checkout at ${spec} (set ${LITVM_ENV})`);
    return;
  }
  for (const name of [...fixtureNames(), MANIFEST]) {
    const ours = fs.readFileSync(path.join(FIXTURES, name));
    const theirs = fs.readFileSync(path.join(spec, name));
    assert.ok(ours.equals(theirs), `test/fixtures/${name} differs from ${path.join(spec, name)}`);
  }
});
