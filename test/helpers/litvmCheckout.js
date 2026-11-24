// The pox-smart-contract-litvm checkout the tests read the spec round's
// commit from, and `git show <commit>:<path>` in it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LITVM_ENV = 'POX_SMART_CONTRACT_LITVM';
// The commit of pox-smart-contract-litvm the copies in this repository are
// taken from (spec/README.md "Pinning a copy").
const SOURCE_COMMIT = '2f600f6';

// POX_SMART_CONTRACT_LITVM, else the first pox-smart-contract-litvm beside
// this repository or beside a directory above it; null when none holds a
// .git.
function litvmCheckout() {
  const candidates = [];
  if (process.env[LITVM_ENV]) candidates.push(path.resolve(process.env[LITVM_ENV]));
  for (let dir = path.resolve(__dirname, '..', '..'); ; dir = path.dirname(dir)) {
    candidates.push(path.join(path.dirname(dir), 'pox-smart-contract-litvm'));
    if (path.dirname(dir) === dir) break;
  }
  return candidates.find((c) => fs.existsSync(path.join(c, '.git'))) || null;
}

// The bytes of `git show <commit>:<file>` in `checkout`, or null when the
// checkout holds no such object.
function shownAt(checkout, file, commit = SOURCE_COMMIT) {
  try {
    return execFileSync('git', ['-C', checkout, 'show', `${commit}:${file}`],
      { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return null;
  }
}

module.exports = { LITVM_ENV, SOURCE_COMMIT, litvmCheckout, shownAt };
