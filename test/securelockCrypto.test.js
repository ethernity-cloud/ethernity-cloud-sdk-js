// The securelocks' crypto copies against the trustedzones' (MATCHING-SYNC-PLAN.md
// 4.6 SDK-09): every function nodenithy/build/securelock/src/etny_crypto.js
// shares by name with etny-nodenithy's v3/build/trustedzone/src/etny_crypto.js,
// and every one pynithy/build/securelock/src/etny_crypto.py shares with
// etny-pynithy's v3/build/trustedzone/src/etny_crypto.py, is the same text as
// `git show <commit>:<path>` of the trustedzone (each line compared without
// its trailing white space), comment lines that hold a print or console call
// left out on both sides: the Python securelock carries none (its log
// confidentiality tests refuse them). The copies hold no function of their own but the
// ones listed, no function of either copy carries the trustedzone's statement
// form (`ecld-stmt-1`, spec reserved-prefixes.json), and each copy's header
// states that the statement signer is the trustedzone's alone. The Node
// securelock's PoX ABI, nodenithy/build/securelock/src/pox_abi.js, is the
// trustedzone's v3/build/trustedzone/src/pox_abi.js at the same commit, byte
// for byte. The checkout of each trustedzone is ETNY_NODENITHY /
// ETNY_PYNITHY, else a directory of its name beside this repository or beside
// a directory above it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// The trustedzone commits the copies are compared with: etny-nodenithy and
// etny-pynithy feature/matching.
const COPIES = [
  {
    trustedzone: 'etny-nodenithy', env: 'ETNY_NODENITHY', commit: '2e5e3d9',
    source: 'v3/build/trustedzone/src/etny_crypto.js', copy: 'nodenithy/build/securelock/src/etny_crypto.js',
    own: [], language: 'js'
  },
  {
    trustedzone: 'etny-pynithy', env: 'ETNY_PYNITHY', commit: 'fb8f8b4',
    source: 'v3/build/trustedzone/src/etny_crypto.py', copy: 'pynithy/build/securelock/src/etny_crypto.py',
    own: ['encrypt'], language: 'py'
  }
];

const checkoutOf = ({ trustedzone, env }) => {
  const candidates = [];
  if (process.env[env]) candidates.push(path.resolve(process.env[env]));
  for (let dir = ROOT; ; dir = path.dirname(dir)) {
    candidates.push(path.join(path.dirname(dir), trustedzone));
    if (path.dirname(dir) === dir) break;
  }
  return candidates.find((c) => fs.existsSync(path.join(c, '.git'))) || null;
};

const shown = (checkout, commit, file) => {
  try {
    return execFileSync('git', ['-C', checkout, 'show', `${commit}:${file}`],
      { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch (e) {
    return null;
  }
};

// The top-level functions of a module's text by name, each its lines from the
// declaration to the end of its body, trailing white space removed: in
// JavaScript a `function`, `async function` or `const name =` at column 0
// ending at the first `}` or `};` at column 0; in Python a method of the
// class with its decorator, ending before the next line indented four spaces
// or less (the next member, a class-level comment or assignment, the class's
// end).
function functionsOf(text, language) {
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const found = {};
  for (let i = 0; i < lines.length; i += 1) {
    if (language === 'js') {
      const m = /^(?:async )?function (\w+)\(|^const (\w+) = /.exec(lines[i]);
      if (!m) continue;
      let j = i;
      while (j < lines.length && lines[j] !== '}' && lines[j] !== '};') j += 1;
      found[m[1] || m[2]] = lines.slice(i, j + 1).join('\n');
      i = j;
    } else {
      const m = /^    def (\w+)\(/.exec(lines[i]);
      if (!m) continue;
      const start = i > 0 && lines[i - 1] === '    @staticmethod' ? i - 1 : i;
      let j = i + 1;
      while (j < lines.length && !/^ {0,4}\S/.test(lines[j])) j += 1;
      found[m[1]] = lines.slice(start, j).join('\n').replace(/\n+$/, '');
      i = j - 1;
    }
  }
  return found;
}

for (const entry of COPIES) {
  test(`${entry.copy}: every function it shares with ${entry.trustedzone} ${entry.commit} is the trustedzone's`, (t) => {
    const checkout = checkoutOf(entry);
    if (checkout === null) {
      t.skip(`no ${entry.trustedzone} checkout found (set ${entry.env})`);
      return;
    }
    const source = shown(checkout, entry.commit, entry.source);
    assert.ok(source !== null, `${checkout} holds no ${entry.commit}:${entry.source}`);
    const commentedLog = entry.language === 'js' ? /^\s*\/\/\s*console\.\w+\(/ : /^\s*#\s*print\(/;
    const code = (text) => text.split('\n').filter((line) => !commentedLog.test(line)).join('\n');
    const theirs = functionsOf(code(source), entry.language);
    const ours = functionsOf(code(fs.readFileSync(path.join(ROOT, entry.copy), 'utf8')), entry.language);
    const shared = Object.keys(ours).filter((name) => Object.hasOwn(theirs, name));
    assert.ok(shared.length > 10, `${shared.length} shared functions`);
    for (const name of shared) assert.equal(ours[name], theirs[name], `${entry.copy} ${name}`);
    assert.deepEqual(Object.keys(ours).filter((name) => !Object.hasOwn(theirs, name)).sort(), entry.own);
  });

  test(`${entry.copy} holds no statement signer and its header says so`, () => {
    const text = fs.readFileSync(path.join(ROOT, entry.copy), 'utf8');
    for (const [name, body] of Object.entries(functionsOf(text, entry.language))) {
      assert.ok(!body.includes('ecld-stmt-1'), `${entry.copy} ${name}`);
    }
    const header = text.slice(0, text.search(entry.language === 'js' ? /^const /m : /^from __future__/m));
    assert.ok(header.includes('statement signer') && header.includes('"ecld-stmt-1"')
      && header.includes('not in this copy'), entry.copy);
  });
}

test(`nodenithy/build/securelock/src/pox_abi.js is etny-nodenithy ${COPIES[0].commit}'s v3/build/trustedzone/src/pox_abi.js`, (t) => {
  const checkout = checkoutOf(COPIES[0]);
  if (checkout === null) {
    t.skip(`no etny-nodenithy checkout found (set ${COPIES[0].env})`);
    return;
  }
  const source = shown(checkout, COPIES[0].commit, 'v3/build/trustedzone/src/pox_abi.js');
  assert.ok(source !== null, `${checkout} holds no ${COPIES[0].commit}:v3/build/trustedzone/src/pox_abi.js`);
  assert.equal(fs.readFileSync(path.join(ROOT, 'nodenithy/build/securelock/src/pox_abi.js'), 'utf8'), source);
});
