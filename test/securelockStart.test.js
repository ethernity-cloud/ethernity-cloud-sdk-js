// What the nodenithy securelock's entry and its addon loader take from their
// start. securelock.js.tmpl's first statements end the process with status
// 78 unless node runs from the path the image signs and its one global
// folder is that path's prefix's (the values the fixed start gives,
// nodenithy/build/securelock/fixed-start/securelock.h). The addon loader
// (sgx_report.js) names the addon beside it and by the image's absolute path,
// never by a path relative to the working directory.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { SRC, cryptoStub, freshModules } = require('./helpers/securelock_app');

const TEMPLATE = path.join(SRC, 'securelock.js.tmpl');
const HEADER = path.join(SRC, '..', 'fixed-start', 'securelock.h');
const RENDERED = Object.freeze({
  __ETNY_NETWORK_TYPE__: 'testnet_cas',
  __ETNY_BUCKET__: 'etny-suite-v3',
  __ENCLAVE_NAME_SECURELOCK__: 'etny-suite-securelock',
  __ETNY_SMART_CONTRACT_ADDRESS__: '0x00000000000000000000000000000000000000A1',
  __ETNY_IMAGE_REGISTRY_ADDRESS__: '0x00000000000000000000000000000000000000B2',
  __ETNY_VALIDATOR_REGISTRY_ADDRESS__: '',
  __ETNY_CHAIN_ID__: '8995',
  __ETNY_WEB3_PROVIDER__: 'http://rpc.invalid',
});
// The statement at the end of the template that starts the run.
const START = '\n(async () => {\n    let failed = false;';
// What the template's first statements read of its start, as the image's
// fixed start gives it.
const FIXED_START = Object.freeze({ execPath: '/usr/local/bin/node', globalPaths: Object.freeze(['/usr/local/lib/node']) });

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// What a template's process.exit throws here, the process's status as `code`.
class ProcessExit extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

// The template compiled off SGX, without the statement that starts the run,
// for a process whose execPath and whose require('module').globalPaths are
// `fixedStart`'s; what it wrote to file descriptor 2 with fs.writeSync is
// returned with its EtnySecureLock.
function loadTemplate(fixedStart) {
  freshModules();
  let source = read(TEMPLATE);
  for (const [token, value] of Object.entries(RENDERED)) source = source.split(token).join(value);
  assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(source), 'every token of the template is rendered');
  const start = source.lastIndexOf(START);
  assert.notEqual(start, -1, 'the template ends with the statement that starts the run');
  source = `${source.slice(0, start)}\nmodule.exports = { EtnySecureLock };\n`;
  const stderr = [];
  const standIns = {
    dotenv: Object.freeze({ parse: require('dotenv').parse }),
    './etny_crypto': cryptoStub,
    './swift_stream_service': class SwiftStreamService {},
    './self_sign': { generateCertFromMrEnclave() { throw new Error('no SGX report off the enclave'); } },
    module: Object.freeze({ globalPaths: fixedStart.globalPaths }),
    fs: { ...fs, writeSync: (fd, text) => { assert.equal(fd, 2); stderr.push(text); } },
  };
  const fromSrc = Module.createRequire(path.join(SRC, 'securelock.js'));
  const requireOf = (name) => (Object.prototype.hasOwnProperty.call(standIns, name) ? standIns[name] : fromSrc(name));
  const proc = { env: {}, execPath: fixedStart.execPath, on() { return proc; }, exit(code) { throw new ProcessExit(code); } };
  const compiled = { exports: {} };
  try {
    new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', source)(
      requireOf, compiled, compiled.exports, path.join(SRC, 'securelock.js'), SRC, proc);
  } catch (e) {
    if (!(e instanceof ProcessExit)) throw e;
    return { exited: e.code, stderr };
  }
  return { EtnySecureLock: compiled.exports.EtnySecureLock, stderr };
}

// The start is refused: loading the template ends the process with status 78
// after one line on file descriptor 2.
function refused(fixedStart) {
  const loaded = loadTemplate(fixedStart);
  assert.equal(loaded.exited, 78);
  assert.deepEqual(loaded.stderr, ['fixed start: the start is refused: node is not /usr/local/bin/node with /usr/local/lib/node as its one global folder\n']);
}

test('the template\'s first statements are the check of node\'s path and of its global folders', () => {
  const code = read(TEMPLATE).split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('//'));
  assert.equal(code[0], 'if (process.execPath !== \'/usr/local/bin/node\' || require(\'module\').globalPaths.join(\'\\n\') !== \'/usr/local/lib/node\') {');
  assert.match(code[1], /^ {4}require\('fs'\)\.writeSync\(2, 'fixed start: the start is refused: /);
  assert.equal(code[2], '    process.exit(78);');
  assert.equal(code[3], '}');
});

test('the values the template checks are the fixed vectors\' node and the global folder of its prefix', () => {
  const header = read(HEADER);
  const vectors = [...header.matchAll(/^#define FIXED_START_ARGS "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(vectors, [FIXED_START.execPath, FIXED_START.execPath]);
  assert.deepEqual([...FIXED_START.globalPaths], [path.posix.join(path.posix.dirname(path.posix.dirname(FIXED_START.execPath)), 'lib', 'node')]);
  // The launcher passes neither of the two variables that add a folder.
  const joined = header.replace(/\\\n/g, ' ');
  for (const key of ['HOME', 'NODE_PATH']) assert.ok(!new RegExp(`^#define FIXED_START_(ENV|ALLOWED)\\b.*"${key}[="]`, 'm').test(joined), key);
});

test('with the fixed start\'s values the template loads and writes nothing', () => {
  const loaded = loadTemplate(FIXED_START);
  assert.equal(typeof loaded.EtnySecureLock, 'function');
  assert.deepEqual(loaded.stderr, []);
});

test('another path of node ends the process with status 78', () => {
  refused({ execPath: '/usr/bin/node', globalPaths: FIXED_START.globalPaths });
  refused({ execPath: '/usr/local/bin/nodejs', globalPaths: FIXED_START.globalPaths });
  refused({ execPath: '', globalPaths: FIXED_START.globalPaths });
});

test('a global folder more, less or other ends the process with status 78', () => {
  // The folders a HOME of /root adds, a NODE_PATH's, none, and the prefix of another node.
  refused({ execPath: FIXED_START.execPath, globalPaths: ['/root/.node_modules', '/root/.node_libraries', '/usr/local/lib/node'] });
  refused({ execPath: FIXED_START.execPath, globalPaths: ['/tmp/modules', '/usr/local/lib/node'] });
  refused({ execPath: FIXED_START.execPath, globalPaths: ['/usr/local/lib/node', '/tmp/modules'] });
  refused({ execPath: FIXED_START.execPath, globalPaths: [] });
  refused({ execPath: FIXED_START.execPath, globalPaths: ['/usr/lib/node'] });
});

test('the addon loader names the addon beside it and by its absolute path, never by a path relative to the working directory', () => {
  const source = read(path.join(SRC, 'sgx_report.js'));
  const list = /const candidates = \[\n([\s\S]*?)\n {2}\];/.exec(source);
  assert.ok(list, 'sgx_report.js lists its candidates');
  const candidates = list[1].split('\n').map((l) => l.trim().replace(/,$/, ''));
  assert.deepEqual(candidates, ['path.join(__dirname, \'sgx_report.node\')', '\'/etny-securelock/sgx_report.node\'']);
  assert.doesNotMatch(source, /['"]\.{1,2}\/[^'"]*\.node['"]/);
});
