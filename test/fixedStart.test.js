// The securelock's fixed start: nodenithy/build/securelock/fixed-start/
// fixed_start.c with the securelock's header securelock.h, linked into the
// extension Dockerfile.tmpl builds. The header's argument vector is the
// ENTRYPOINT build.mjs renders, with node --jitless or without it as
// nodeFlags.js decides, and carries --disable-sigusr1 and an --openssl-config
// that names an empty file of the image; its keys are the ones the
// securelock's JavaScript reads from its environment; its working directory
// is the session's; the entries it excepts are the runtime's device and
// process directories, the two host files of the binary-fs and the files the
// CAS session places. scripts/binary-fs-build.sh assembles the enclave's files
// in a new directory, /enclave-root, and makes the binary-fs of it whole; the
// release stage writes that root's digest with fixed-start/tree_digest.sh and
// the list of its ELF files with fixed-start/elf_needed.sh, and the rendered
// link line compiles the digest, the session's name and FIXED_START_JITLESS
// into the launcher. The launcher and the two scripts are the same files in
// the pynithy mirror and in etny-nodenithy. With a musl C library, gcc, bash
// and the right to chroot on the host, the launcher is compiled with the
// securelock's header and the digest of a root, and a program started through
// it inside that root runs with the fixed vector, the listed keys and the
// fixed working directory whatever it is started with, and only while the
// root holds the entries the digest was written for and, beside them, the
// excepted entries alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { renderSecurelockDockerfile } = require('../nodenithy/securelockDockerfile.js');
const { securelockNodeFlags, FIXED_NODE_FLAGS, OPENSSL_CONFIG } = require('../nodenithy/nodeFlags.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECURELOCK = path.join(ROOT, 'nodenithy', 'build', 'securelock');
const SRC = path.join(SECURELOCK, 'src');
const FIXED_START = path.join(SECURELOCK, 'fixed-start');
const LAUNCHER = path.join(FIXED_START, 'fixed_start.c');
const HEADER = path.join(FIXED_START, 'securelock.h');
const TREE_DIGEST = path.join(FIXED_START, 'tree_digest.sh');
const BINARY_FS_BUILD = path.join(SECURELOCK, 'scripts', 'binary-fs-build.sh');
const SESSION_TEMPLATE = path.join(ROOT, 'nodenithy', 'run', 'etny-securelock-test.yaml.tpl');
const MIRROR_FIXED_START = path.join(ROOT, 'pynithy', 'build', 'securelock', 'fixed-start');
// The etny-nodenithy checkout: ETNY_NODENITHY, else the sibling of this repository.
const NODENITHY = path.resolve(process.env.ETNY_NODENITHY || path.join(ROOT, '..', 'etny-nodenithy'));
const NODENITHY_FIXED_START = path.join(NODENITHY, 'v3', 'build', 'trustedzone', 'fixed-start');
// The files of fixed-start/ that are one text in every enclave's build.
const SHARED = ['fixed_start.c', 'tree_digest.sh', 'elf_needed.sh'];

const ENTRY_DIR = '/etny-securelock';
const ENTRY = `${ENTRY_DIR}/securelock.js`;
const FIXED_FLAGS = ['--disable-sigusr1', `--openssl-config=${ENTRY_DIR}/fixed-start/openssl.cnf`];
const VECTORS = {
  0: ['/usr/local/bin/node', ...FIXED_FLAGS, ENTRY],
  1: ['/usr/local/bin/node', '--jitless', ...FIXED_FLAGS, ENTRY],
};
const WORKING_DIRECTORY = '/';
const ALLOWED = [
  'ETNY_MODE', 'ETNY_ORDER_ID', 'ETNY_CLIENT_CHALLENGE', 'ECAS_ATTEST_SESSION', 'ECAS_ENCLAVE_NONCE',
  'ECAS_CAS_QUOTE', 'ESR_CONTRACT_ADDRESS',
];
// Read by esr_wallet.js and not passed (securelock.h).
const NOT_PASSED = ['ESR_IDENTITY_SECRET'];
// The entries of the enclave's file system that are not the image's
// (securelock.h FIXED_START_EXCEPT), for a session of the name given: the
// kind, the path and, for a directory that lists names, the names.
const excepted = (session) => [
  ['S', '/dev', null],
  ['S', '/proc', null],
  ['N', '/etc', ['hosts', 'resolv.conf']],
  ['N', '/app', [session]],
  ['N', `/app/${session}`, ['ca.pem', 'cert.pem']],
  ['N', '/private', [session]],
  ['N', `/private/${session}`, ['key.pem']],
];
const ENCLAVE_ROOT = '/enclave-root';
const SPACE = 32768;
const DEPTH_MAX = 64;
const REFUSED = 78;

const read = (file) => fs.readFileSync(file, 'utf8');
const lf = (file) => read(file).replace(/\r\n/g, '\n');

function literals(body) {
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\(.)/g, (_, c) => (c === '0' ? '\0' : c)));
}

// The bodies of every `#define <name>` of a header, in order, continuation
// lines joined.
function macros(text, name) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  return [...joined.matchAll(new RegExp(`^#define ${name}\\b(.*)$`, 'gm'))].map((m) => m[1]);
}

// The header's vectors for FIXED_START_JITLESS 1 (the #if branch) and 0 (the
// #else branch), its fixed variables, its keys and its working directory.
function fixedStart(text) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  const branch = /^#if FIXED_START_JITLESS\s*$([\s\S]*?)^#else\s*$([\s\S]*?)^#endif\s*$/m.exec(joined);
  assert.ok(branch, 'the header chooses its vector on FIXED_START_JITLESS');
  const args = (block) => {
    const bodies = macros(block, 'FIXED_START_ARGS');
    assert.equal(bodies.length, 1);
    return literals(bodies[0]).join('').split('\0');
  };
  const [env] = macros(text, 'FIXED_START_ENV');
  const [allowed] = macros(text, 'FIXED_START_ALLOWED');
  const [pwd] = macros(text, 'FIXED_START_PWD');
  return { args: { 1: args(branch[1]), 0: args(branch[2]) }, env: literals(env), allowed: literals(allowed), pwd: literals(pwd).join('') };
}

// The records of FIXED_START_EXCEPT, with `session` for FIXED_START_SESSION.
function exceptRecords(text, session) {
  const [body] = macros(text, 'FIXED_START_EXCEPT');
  return [...body.split('FIXED_START_SESSION').join(JSON.stringify(session)).matchAll(/\{([^}]*)\}/g)].map((m) => {
    const [kind, at, names] = m[1].split(',').map((field) => field.trim());
    assert.match(kind, /^'[A-Z]'$/);
    return [kind[1], literals(at).join(''), names === 'NULL' ? null : literals(names).join('').split('\0').slice(0, -1)];
  });
}

// The lines of a shell script that are not comments, trimmed.
const commands = (script) => script.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

const VALUES = {
  enclaveName: 'PROJECT_SECURELOCK_V3_TESTNET_UNSAFE_0_0_1',
  networkType: 'testnet',
  bucket: 'etny-nodenithy-testnet-unsafe-v3',
  smartContractAddress: '0x830c781F0352050343211B6BFA83600B3e77647C',
  imageRegistryAddress: '0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1',
  rpcUrl: 'https://bloxberg.ethernity.cloud',
  chainId: 8995,
  validatorRegistryAddress: '',
  esrEnvBlock: '',
};
const render = (memory, production) => renderSecurelockDockerfile(read(path.join(SECURELOCK, 'Dockerfile.tmpl')), {
  ...VALUES, memory, nodeFlags: securelockNodeFlags(memory, ''), production,
});
const linkLine = (session, jitless) => `RUN scone gcc ./binary_fs_blob.s -O2 -fPIC -DFIXED_START_SESSION='"${session}"' `
  + '-include /fixed-start/securelock.h '
  + `-include /fixed_start_tree.h -DFIXED_START_JITLESS=${jitless} /fixed-start/fixed_start.c ./libbinary_fs_template.a `
  + '-shared -o /libbinary-fs.so';
const ELF_RUN = `RUN bash /fixed-start/elf_needed.sh ${ENCLAVE_ROOT} /binary-fs-dir/fixed_start_elf.txt`;
const TREE_RUN = `RUN bash /fixed-start/tree_digest.sh ${ENCLAVE_ROOT} `
  + '/binary-fs-dir/fixed_start_tree.h /binary-fs-dir/fixed_start_tree.txt';
const stages = (dockerfile) => dockerfile.split(/^(?=FROM )/m).filter((s) => s.startsWith('FROM '));

test('the header\'s vectors are node, --jitless or not, --disable-sigusr1, an --openssl-config, then securelock.js', () => {
  const { args } = fixedStart(read(HEADER));
  assert.deepEqual(args, VECTORS);
  for (const vector of Object.values(args)) {
    assert.ok(vector.includes('--disable-sigusr1'));
    assert.equal(vector.filter((a) => a.startsWith('--openssl-config=')).length, 1);
    assert.ok(vector.length <= 8, 'the launcher takes eight arguments');
  }
});

test('every node flag set nodeFlags.js gives has a vector in the header, and carries the two fixed flags', () => {
  const sets = new Set();
  for (const heap of ['128M', '256M', '512M', '1000M', '1024M', '1G', '2G', '64G']) {
    for (const override of [undefined, '', '0', '1', 'true', 'no']) sets.add(JSON.stringify(securelockNodeFlags(heap, override)));
  }
  assert.deepEqual([...sets].sort(), [JSON.stringify(VECTORS[0].slice(1, -1)), JSON.stringify(VECTORS[1].slice(1, -1))].sort());
  assert.deepEqual([...FIXED_NODE_FLAGS], FIXED_FLAGS);
});

test('the OpenSSL configuration the flags name is a file of the entry\'s directory that binary-fs-build.sh makes empty', () => {
  assert.equal(`--openssl-config=${OPENSSL_CONFIG}`, FIXED_FLAGS[1]);
  assert.equal(path.posix.dirname(path.posix.dirname(OPENSSL_CONFIG)), ENTRY_DIR);
  const lines = commands(read(BINARY_FS_BUILD));
  const made = lines.indexOf(`: > "\${ROOT}${OPENSSL_CONFIG}"`);
  assert.ok(made > lines.indexOf(`mkdir "\${ROOT}${path.posix.dirname(OPENSSL_CONFIG)}"`));
  // No other line writes below the file's directory.
  assert.equal(lines.filter((l) => l.includes(path.posix.dirname(OPENSSL_CONFIG))).length, 2);
});

test('the CAS session\'s command is node with the build\'s flags and securelock.js', () => {
  const command = /^\s+command: (.*)$/m.exec(read(SESSION_TEMPLATE));
  assert.ok(command);
  // run.js renders __NODE_FLAGS__ to the flags of .env SECURELOCK_NODE_FLAGS, each followed by a space.
  for (const jitless of [0, 1]) {
    const flags = VECTORS[jitless].slice(1, -1);
    assert.deepEqual(command[1].replace('__NODE_FLAGS__', `${flags.join(' ')} `).trim().split(/\s+/), VECTORS[jitless]);
  }
});

test('no variable is set whatever the start holds', () => {
  assert.deepEqual(fixedStart(read(HEADER)).env, []);
});

test('the keys passed through are the keys the securelock\'s JavaScript reads, but ESR_IDENTITY_SECRET', () => {
  const keys = new Set();
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js') || f.endsWith('.js.tmpl'))) {
    for (const m of read(path.join(SRC, file)).matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(m[1]);
  }
  // etny_exec.js reads its required build values through process.env[name].
  const required = /const required = \[([^\]]*)\]/.exec(read(path.join(SRC, 'etny_exec.js')));
  assert.ok(required);
  for (const m of required[1].matchAll(/'([A-Z_0-9]+)'/g)) keys.add(m[1]);
  // readEnv() admits these keys from the bucket .env into process.env.
  const allowlist = /static NODE_ENV_ALLOWLIST = new Set\(\[([^\]]*)\]\)/.exec(read(path.join(SRC, 'securelock.js.tmpl')));
  assert.ok(allowlist);
  for (const m of allowlist[1].matchAll(/'([A-Z_0-9]+)'/g)) keys.add(m[1]);
  const { allowed } = fixedStart(read(HEADER));
  assert.deepEqual(allowed, ALLOWED);
  assert.deepEqual([...keys].sort(), [...ALLOWED, ...NOT_PASSED].sort());
  for (const key of NOT_PASSED) assert.ok(!allowed.includes(key), key);
});

test('the working directory is the CAS session\'s pwd, and the launcher passes no HOME', () => {
  const { pwd, env, allowed } = fixedStart(read(HEADER));
  assert.equal(pwd, WORKING_DIRECTORY);
  const sessionPwd = /^\s+pwd: (\S+)\s*$/m.exec(read(SESSION_TEMPLATE));
  assert.ok(sessionPwd);
  assert.equal(sessionPwd[1], WORKING_DIRECTORY);
  assert.ok(!env.some((entry) => entry.startsWith('HOME=')) && !allowed.includes('HOME'), 'no HOME: no folder under a home directory');
});

test('the excepted entries are /dev and /proc unread, /etc with the two host files, and the session\'s directories with its three files', () => {
  const header = lf(HEADER);
  assert.deepEqual(exceptRecords(header, 'a-session'), excepted('a-session'));
  assert.match(header, /^#if !defined\(FIXED_START_SESSION\)\n#error /m);
  assert.match(header, /^_Static_assert\(sizeof FIXED_START_SESSION > 1, /m);
  // /etc holds the host paths of the binary-fs.
  const hostPaths = [...read(BINARY_FS_BUILD).matchAll(/--host-path=(\S+?)\)?\s/g)].map((m) => m[1]).sort();
  assert.deepEqual(hostPaths, excepted('s').find(([, at]) => at === '/etc')[2].map((name) => `/etc/${name}`).sort());
  // The session's directories hold the files the CAS session places, under
  // the name securelock.js reads its key and certificate by.
  const placed = [...read(SESSION_TEMPLATE).matchAll(/^\s+- path: (\S+)\s*$/gm)].map((m) => m[1]).sort();
  const files = excepted('__ENCLAVE_NAME__')
    .filter(([kind, at]) => kind === 'N' && at.split('/').length === 3)
    .flatMap(([, at, names]) => names.map((name) => `${at}/${name}`));
  assert.deepEqual(placed, files.sort());
  assert.equal(placed.length, 3);
  const template = read(path.join(SRC, 'securelock.js.tmpl'));
  assert.ok(template.includes('this.key_file = "/private/__ENCLAVE_NAME_SECURELOCK__/key.pem";'));
  assert.ok(template.includes('this.cert_file = "/app/__ENCLAVE_NAME_SECURELOCK__/cert.pem";'));
});

test('fixed-start/ holds the launcher, the two scripts and the securelock\'s header, and no list of paths', () => {
  assert.deepEqual(fs.readdirSync(FIXED_START).sort(), [...SHARED, 'securelock.h'].sort());
});

test('Dockerfile.tmpl links the launcher into /libbinary-fs.so once, in the cross compiler stage, after the COPY of fixed-start/', () => {
  const dockerfile = read(path.join(SECURELOCK, 'Dockerfile.tmpl'));
  const writers = dockerfile.split('\n').filter((l) => /-o \/libbinary-fs\.so\b/.test(l));
  assert.deepEqual(writers, [linkLine('__ENCLAVE_NAME_SECURELOCK__', '__FIXED_START_JITLESS__')]);
  const [build] = stages(dockerfile).filter((s) => s.includes(writers[0]));
  assert.match(build, /^FROM \S*sconecuratedimages\/crosscompilers:\S+ as build$/m);
  const copy = build.indexOf('COPY fixed-start/ /fixed-start/\n');
  assert.ok(copy >= 0 && copy < build.indexOf(writers[0]));
  const signed = stages(dockerfile).at(-1);
  assert.match(signed, /^COPY --from=build \/libbinary-fs\.so \/lib\/libbinary-fs\.so$/m);
  assert.match(signed, /^ENV SCONE_EXTENSIONS_PATH=\/lib\/libbinary-fs\.so$/m);
  assert.ok(build.indexOf('COPY --from=release /binary-fs-dir /.\n') >= 0);
  assert.ok(build.indexOf('COPY --from=release /binary-fs-dir /.\n') < build.indexOf(writers[0]));
});

test('the release stage lists the root\'s ELF files and writes the root\'s digest after it makes the binary-fs, the digest last', () => {
  const [release, ...others] = stages(read(path.join(SECURELOCK, 'Dockerfile.tmpl'))).filter((s) => s.includes(TREE_RUN));
  assert.deepEqual(others, []);
  assert.match(release, /^FROM \$\{SCONE_NODE\} AS release$/m);
  const make = release.indexOf('RUN etny-securelock/binary-fs-build.sh\n');
  assert.ok(make >= 0);
  // After the binary-fs is made, the stage copies fixed-start/ and reads the root, nothing else.
  assert.deepEqual(release.slice(make).split('\n').filter((l) => /^(RUN|COPY|ADD) /.test(l)),
    ['RUN etny-securelock/binary-fs-build.sh', 'COPY fixed-start/ /fixed-start/', ELF_RUN, TREE_RUN]);
});

test('binary-fs-build.sh assembles the enclave\'s files in a new root and makes the binary-fs of that root whole', () => {
  const lines = commands(read(BINARY_FS_BUILD));
  const at = (line) => {
    const i = lines.indexOf(line);
    assert.ok(i >= 0, `binary-fs-build.sh runs: ${line}`);
    return i;
  };
  assert.equal(lines[0], 'set -e');
  const root = at(`ROOT=${ENCLAVE_ROOT}`);
  const empty = at('find "${ROOT}" -depth -type d -empty -exec rmdir {} \\;');
  const scone = at('EXEC=(scone binaryfs "${ROOT}" /binary-fs-dir -v \\');
  // The root is made after securelock.js is rendered; the first command on it fails when it exists.
  assert.ok(root > at('mv securelock.js.tmp securelock.js') && scone > empty);
  assert.equal(lines.at(-1), 'exec "${EXEC[@]}"');
  // Every command that writes below the root, in order.
  assert.deepEqual(lines.slice(root + 1, empty).filter((l) => l.includes('${ROOT}')), [
    'mkdir "${ROOT}"',
    'mkdir -p "${ROOT}/usr/local/bin"',
    'cp /usr/local/bin/node "${ROOT}/usr/local/bin/node"',
    `cp -a ${ENTRY_DIR} "\${ROOT}${ENTRY_DIR}"`,
    `mkdir "\${ROOT}${path.posix.dirname(OPENSSL_CONFIG)}"`,
    `: > "\${ROOT}${OPENSSL_CONFIG}"`,
  ]);
  // The binary-fs holds the root whole: no pattern selects a part of it, and its links are kept as they are.
  assert.ok(!/--include|--exclude/.test(lines.join('\n')));
  assert.deepEqual(lines.slice(scone + 1, scone + 4),
    ['--preserve-symbolic-links \\', '--host-path=/etc/resolv.conf \\', '--host-path=/etc/hosts)']);
});

test('the rendered Dockerfile links the launcher with the session\'s name and the vector of its ENTRYPOINT, and leaves no token', () => {
  for (const [memory, jitless] of [['256M', 1], ['1024M', 0], ['2G', 0]]) {
    for (const production of [false, true]) {
      const dockerfile = render(memory, production);
      assert.doesNotMatch(dockerfile, /__[A-Z][A-Z0-9_]*__/, `${memory} production=${production}`);
      assert.ok(dockerfile.split('\n').includes(linkLine(VALUES.enclaveName, jitless)), `${memory} links with FIXED_START_JITLESS=${jitless}`);
      const entrypoint = /^ENTRYPOINT (\[.*\])\s*$/m.exec(dockerfile);
      assert.deepEqual(JSON.parse(entrypoint[1]), VECTORS[jitless]);
      const sign = dockerfile.split('\n').filter((l) => l.startsWith('RUN scone-signer sign '));
      assert.deepEqual(sign, [`RUN scone-signer sign --key=/enclave-key.pem --env --heap=${memory} --stack=4M --tcs=64 `
        + `--dlopen=1 --extensions=/lib/libbinary-fs.so${production ? ' --production' : ''} /usr/local/bin/node`]);
      assert.match(dockerfile, new RegExp(`^ENV SCONE_HEAP=${memory}$`, 'm'));
    }
  }
});

test('a session name that is not letters, digits, dots, dashes and underscores is not rendered into the link line', () => {
  for (const enclaveName of ['a b', 'a"b', "a'b", 'a\\b', 'a$b', 'a/b', '']) {
    assert.throws(() => renderSecurelockDockerfile(read(path.join(SECURELOCK, 'Dockerfile.tmpl')), {
      ...VALUES, enclaveName, memory: '1024M', nodeFlags: securelockNodeFlags('1024M', ''), production: false,
    }), /the enclave name/, JSON.stringify(enclaveName));
  }
});

test('the rendered Dockerfile takes the build\'s network values and its ESR line', () => {
  const dockerfile = renderSecurelockDockerfile(read(path.join(SECURELOCK, 'Dockerfile.tmpl')), {
    ...VALUES, esrEnvBlock: 'ENV ESR_CONTRACT_ADDRESS=0x0Ea1728EAE108FD3B9340ae91451348E2Cc6b4E4',
    validatorRegistryAddress: '0x0000000000000000000000000000000000000001', memory: '256M', nodeFlags: securelockNodeFlags('256M', ''), production: true,
  });
  for (const line of ['ENV ENCLAVE_NAME_SECURELOCK=PROJECT_SECURELOCK_V3_TESTNET_UNSAFE_0_0_1', 'ENV NETWORK_TYPE=testnet',
    'ENV BUCKET_NAME=etny-nodenithy-testnet-unsafe-v3', 'ENV SMART_CONTRACT_ADDRESS=0x830c781F0352050343211B6BFA83600B3e77647C',
    'ENV IMAGE_REGISTRY_ADDRESS=0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1', 'ENV RPC_URL=https://bloxberg.ethernity.cloud',
    'ENV CHAIN_ID=8995', 'ENV VALIDATOR_REGISTRY_ADDRESS=0x0000000000000000000000000000000000000001',
    'ENV ESR_CONTRACT_ADDRESS=0x0Ea1728EAE108FD3B9340ae91451348E2Cc6b4E4']) {
    assert.ok(dockerfile.split('\n').includes(line), line);
  }
  assert.doesNotMatch(render('1024M', false), /^ENV ESR_CONTRACT_ADDRESS=/m);
});

test('fixed_start.c, tree_digest.sh and elf_needed.sh are the same files in the pynithy mirror', () => {
  for (const name of SHARED) assert.equal(lf(path.join(FIXED_START, name)), lf(path.join(MIRROR_FIXED_START, name)), name);
});

test('fixed_start.c, tree_digest.sh and elf_needed.sh are byte-identical to etny-nodenithy\'s when that checkout is present', (t) => {
  if (!fs.existsSync(path.join(NODENITHY_FIXED_START, 'fixed_start.c'))) {
    t.skip(`no etny-nodenithy checkout at ${NODENITHY} (set ETNY_NODENITHY)`);
    return;
  }
  for (const name of SHARED) assert.equal(lf(path.join(FIXED_START, name)), lf(path.join(NODENITHY_FIXED_START, name)), name);
});

// A musl C library (the one SCONE's runtime is built on), gcc, bash for
// tree_digest.sh, and the right to chroot: the launcher reads the file
// system from /, so a start is made inside a root of the test's own.
function launcherToolchainMissing() {
  if (process.platform !== 'linux') return `the host is ${process.platform}, not Linux`;
  if (!fs.readdirSync('/lib').some((f) => /^ld-musl-.*\.so\.1$/.test(f))) return 'the host C library is not musl';
  if (spawnSync('gcc', ['--version']).status !== 0) return 'gcc is not on PATH';
  if (spawnSync('bash', ['--version']).status !== 0) return 'bash is not on PATH';
  if (process.getuid() !== 0) return 'the tests chroot, and the user is not root';
  return null;
}

// The digest of the root at `root` as fixed_start.c defines it, computed here
// from the definition.
function rootDigest(root) {
  const h = crypto.createHash('sha256');
  const record = (...fields) => { for (const f of fields) h.update(Buffer.concat([Buffer.from(f), Buffer.from([0])])); };
  const entries = (dir, at) => {
    for (const name of fs.readdirSync(dir).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const x = `${dir}/${name}`;
      const p = `${at}/${name}`;
      const st = fs.lstatSync(x);
      if (st.isFile()) {
        const data = fs.readFileSync(x);
        record(`F${p}`, String(data.length), crypto.createHash('sha256').update(data).digest('hex'));
      } else if (st.isSymbolicLink()) {
        record(`L${p}`, fs.readlinkSync(x));
      } else if (st.isDirectory()) {
        record(`D${p}`);
        entries(x, p);
      } else {
        record(`O${p}`);
      }
    }
  };
  entries(root, '');
  return h.digest('hex');
}

// The files of an image's root for the launcher's tests under `root`: the
// entry's directory with the entry, a module, a dApp backend, a node_modules
// package, names whose bytewise order differs from a sort of the whole paths
// (a/, a-b, a.js), a symbolic link and the empty OpenSSL configuration.
// reverse reverses the order the entries are made in; mode and time set the
// files' modes and times.
function makeImage(root, { reverse = false, mode = 0o644, time = 1e9 } = {}) {
  const files = [
    ['securelock.js', 'require("./a");\n'], ['a/x.js', 'module.exports = 1;\n'], ['a-b', 'a-b\n'], ['a.js', 'module.exports = 2;\n'],
    ['serverless/backend.js', 'module.exports = { hello: (m) => m };\n'], ['node_modules/pkg/index.js', 'module.exports = "pkg";\n'],
    ['fixed-start/openssl.cnf', ''],
  ];
  const entry = path.join(root, ENTRY_DIR);
  const steps = [
    ...files.map(([name, content]) => () => {
      fs.mkdirSync(path.dirname(path.join(entry, name)), { recursive: true });
      fs.writeFileSync(path.join(entry, name), content, { mode });
      fs.utimesSync(path.join(entry, name), time, time);
    }),
    () => {
      fs.mkdirSync(entry, { recursive: true });
      fs.symlinkSync('a.js', path.join(entry, 'link.js'));
    },
  ];
  fs.mkdirSync(root, { recursive: true });
  for (const step of reverse ? steps.reverse() : steps) step();
}

// The lines the listing holds for makeImage's files, the files without their
// sizes and hashes.
const IMAGE_LISTING = [
  `D ${ENTRY_DIR}`,
  `D ${ENTRY_DIR}/a`,
  `F ${ENTRY_DIR}/a/x.js`,
  `F ${ENTRY_DIR}/a-b`,
  `F ${ENTRY_DIR}/a.js`,
  `D ${ENTRY_DIR}/fixed-start`,
  `F ${OPENSSL_CONFIG}`,
  `L ${ENTRY_DIR}/link.js -> a.js`,
  `D ${ENTRY_DIR}/node_modules`,
  `D ${ENTRY_DIR}/node_modules/pkg`,
  `F ${ENTRY_DIR}/node_modules/pkg/index.js`,
  `F ${ENTRY}`,
  `D ${ENTRY_DIR}/serverless`,
  `F ${ENTRY_DIR}/serverless/backend.js`,
];
const listed = (listing) => listing.split('\n').filter((l) => l !== '')
  .map((l) => (l.startsWith('F ') ? `F ${l.split(' ').slice(3).join(' ')}` : l));

const STARTED_C = `#include <stdio.h>
#include <string.h>
#include <unistd.h>
extern char **environ;
int main(int argc, char **argv, char **envp)
{
    int i;
    int contiguous = 1;
    char **e;
    char cwd[4096];
    for (i = 0; i < argc; i++) {
        printf("arg %s\\n", argv[i]);
        if (i > 0 && argv[i] != argv[i - 1] + strlen(argv[i - 1]) + 1)
            contiguous = 0;
    }
    for (e = environ; *e != NULL; e++)
        printf("env %s\\n", *e);
    printf("envp %s\\n", envp == environ ? "environ" : "other");
    printf("contiguous %d\\n", contiguous);
    printf("cwd %s\\n", getcwd(cwd, sizeof cwd) != NULL ? cwd : "?");
    return 0;
}
`;

const LOADER_C = `#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv)
{
    (void)argc;
    if (dlopen(argv[1], RTLD_NOW) == NULL)
        return 2;
    printf("loaded\\n");
    return 0;
}
`;

// enter <root> <directory> <program> [arguments]: the program, started with
// <root> as its / and <directory> of it as its working directory.
const ENTER_C = `#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv)
{
    if (argc < 4)
        return 2;
    if (chroot(argv[1]) != 0) {
        perror("chroot");
        return 3;
    }
    if (chdir(argv[2]) != 0) {
        perror("chdir");
        return 4;
    }
    execv(argv[3], argv + 3);
    perror("execv");
    return 5;
}
`;

const missing = launcherToolchainMissing();
const SESSION = 'fs-test-session';
const PROGRAM = VECTORS[0][0];
let dir;
let root;
let enter;
let loader;
let launcher;
let digest;

const gcc = (args) => {
  const r = spawnSync('gcc', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `gcc ${args.join(' ')}: ${r.stderr}`);
};
// tree_digest.sh over a root: its header and its listing.
const digests = (of, out) => {
  const r = spawnSync('bash', [TREE_DIGEST, of, `${out}.h`, `${out}.txt`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { header: read(`${out}.h`), listing: read(`${out}.txt`) };
};
// The launcher, compiled with the securelock's header for FIXED_START_JITLESS
// `jitless`, the digest header given and, after them, the header `over` when
// one is given.
const compileLauncher = (out, tree, jitless, over) => gcc(['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror',
  `-DFIXED_START_SESSION="${SESSION}"`, '-include', HEADER, '-include', tree, `-DFIXED_START_JITLESS=${jitless}`,
  ...(over ? ['-include', over] : []), '-o', out, LAUNCHER]);
const under = (p) => path.join(root, p);
const put = (p, content = 'x\n') => {
  fs.mkdirSync(path.dirname(under(p)), { recursive: true });
  fs.writeFileSync(under(p), content);
};
const gone = (p) => fs.rmSync(under(p), { recursive: true, force: true });
// A start of the program inside the root, from the directory `from` of it.
const start = (args, env, from = '/') => spawnSync(enter, [root, from, PROGRAM, ...args], { env, encoding: 'utf8' });
const lines = (out, tag) => out.split('\n').filter((l) => l.startsWith(`${tag} `)).map((l) => l.slice(tag.length + 1));
const runs = (why, jitless = 0) => {
  const r = start([], { ETNY_MODE: 'PUBLIC_KEY' });
  assert.equal(r.status, 0, `${why}: ${r.stderr}`);
  assert.deepEqual(lines(r.stdout, 'arg'), VECTORS[jitless], why);
};
const refusal = (r, text) => {
  assert.equal(r.status, REFUSED, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `fixed start: the start is refused: ${text}\n`);
};
// A start after change() is refused over the entry `where`; once undone, the
// next start runs the program's main.
const refusedAt = (where, change, undo) => {
  change();
  try {
    refusal(start([], { ETNY_MODE: 'PUBLIC_KEY' }), `the file tree is not the image's at ${where}`);
  } finally {
    undo();
  }
  runs(`after the change at ${where} is undone`);
};
// A start with the entry `p` added (a file, or a directory when it ends in /) is refused over `where`.
const addedIsRefused = (p, where, top = p) => refusedAt(where, () => {
  if (p.endsWith('/')) fs.mkdirSync(under(p), { recursive: true });
  else put(p);
}, () => gone(top));
// The launcher of `jitless` or of the header `over` in place of the tests'
// launcher while fn runs.
const withLauncher = (jitless, over, fn) => {
  fs.renameSync(launcher, `${launcher}.kept`);
  try {
    compileLauncher(launcher, path.join(dir, 'fixed_start_tree.h'), jitless, over);
    fn();
  } finally {
    fs.renameSync(`${launcher}.kept`, launcher);
  }
};

test('the launcher, compiled with the securelock\'s header (musl, gcc, chroot)', { skip: missing || false }, async (t) => {
  t.before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-start-'));
    root = path.join(dir, 'root');
    for (const [name, source] of [['started', STARTED_C], ['loader', LOADER_C], ['enter', ENTER_C]]) {
      fs.writeFileSync(path.join(dir, `${name}.c`), source);
    }
    enter = path.join(dir, 'enter');
    loader = path.join(dir, 'loader');
    gcc(['-O2', '-o', enter, path.join(dir, 'enter.c')]);
    gcc(['-O2', '-o', loader, path.join(dir, 'loader.c')]);
    // The image's root: the entry's directory, the program at node's path
    // and the C library's loader the program names. The program is linked to
    // a launcher by its name and takes it from /dev, which the launcher does
    // not read: in an enclave the extension is outside the file system the
    // launcher sees.
    makeImage(root);
    fs.writeFileSync(path.join(dir, 'none.h'), `#define FIXED_START_ROOT_DIGEST "${'0'.repeat(64)}"\n`);
    compileLauncher(path.join(dir, 'libfixedstart.so'), path.join(dir, 'none.h'), 0);
    fs.mkdirSync(path.dirname(under(PROGRAM)), { recursive: true });
    gcc(['-O2', '-o', under(PROGRAM), path.join(dir, 'started.c'), `-L${dir}`, '-lfixedstart', '-Wl,-rpath,/dev']);
    const libc = fs.readdirSync('/lib').find((f) => /^ld-musl-.*\.so\.1$/.test(f));
    fs.mkdirSync(under('/lib'));
    fs.copyFileSync(`/lib/${libc}`, under(`/lib/${libc}`));
    digest = digests(root, path.join(dir, 'fixed_start_tree'));
    // What a start finds beside the image's files.
    fs.mkdirSync(under('/dev'));
    put('/proc/1/cmdline', 'node\0');
    put('/etc/hosts', '127.0.0.1 localhost\n');
    put('/etc/resolv.conf', 'nameserver 127.0.0.11\n');
    launcher = under('/dev/libfixedstart.so');
    compileLauncher(launcher, path.join(dir, 'fixed_start_tree.h'), 0);
  });
  t.after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a program started through the launcher runs the fixed vector of its build, in one block, with the listed keys alone', () => {
    const env = {
      NODE_OPTIONS: '--require /etc/hosts',
      ETNY_MODE: 'PUBLIC_KEY',
      ETNY_ORDER: '7',
      etny_mode: '1',
      ESR_CONTRACT_ADDRESS: '0x0Ea1728EAE108FD3B9340ae91451348E2Cc6b4E4',
      ESR_IDENTITY_SECRET: 'secret',
      ECAS_CAS_QUOTE: 'NODE_OPTIONS=--require /etc/hosts',
      OPENSSL_CONF: '/etc/hosts',
      HOME: '/root',
      PATH: '/usr/bin:/bin',
    };
    const check = (jitless) => {
      const r = start(['-e', 'process.exit(3)', '--inspect=0.0.0.0:9229'], env);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(lines(r.stdout, 'arg'), VECTORS[jitless]);
      assert.deepEqual(lines(r.stdout, 'env'), [
        'ETNY_MODE=PUBLIC_KEY',
        'ECAS_CAS_QUOTE=NODE_OPTIONS=--require /etc/hosts',
        'ESR_CONTRACT_ADDRESS=0x0Ea1728EAE108FD3B9340ae91451348E2Cc6b4E4',
      ]);
      assert.deepEqual(lines(r.stdout, 'envp'), ['environ']);
      assert.deepEqual(lines(r.stdout, 'contiguous'), ['1']);
    };
    check(0);
    withLauncher(1, null, () => check(1));
  });

  await t.test('every listed key is passed with its value as it is, up to the launcher\'s space', () => {
    const env = Object.fromEntries(ALLOWED.map((key, i) => [key, `value ${i} = --require /x`]));
    const r = start([], env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(r.stdout, 'env'), ALLOWED.map((key, i) => `${key}=value ${i} = --require /x`));
    const fits = 'A'.repeat(SPACE - 'ECAS_CAS_QUOTE='.length - 1);
    assert.equal(start([], { ECAS_CAS_QUOTE: fits }).status, 0);
    refusal(start([], { ECAS_CAS_QUOTE: `${fits}A` }), 'the environment exceeds the launcher\'s space');
  });

  await t.test('a start that did not come through the launcher is refused when its object is loaded', () => {
    refusal(spawnSync(loader, [launcher], { encoding: 'utf8' }), 'the start did not come through the launcher');
  });

  await t.test('the program runs in the fixed working directory whatever directory the start is made from', () => {
    for (const from of ['/', ENTRY_DIR, '/proc/1']) {
      const r = start([], {}, from);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(lines(r.stdout, 'cwd'), [WORKING_DIRECTORY], from);
    }
  });

  await t.test('a working directory that cannot be entered is refused', () => {
    fs.writeFileSync(path.join(dir, 'pwd.h'), `#undef FIXED_START_PWD\n#define FIXED_START_PWD "${ENTRY_DIR}/none"\n`);
    withLauncher(0, path.join(dir, 'pwd.h'), () => {
      refusal(start([], {}), `the working directory cannot be entered: ${ENTRY_DIR}/none`);
    });
    runs('with the launcher of the securelock\'s header again');
  });

  await t.test('the generator writes the digest of the root as fixed_start.c defines it, and lists the entries it covers', () => {
    const libc = fs.readdirSync(under('/lib'))[0];
    const image = path.join(dir, 'image');
    makeImage(image);
    fs.mkdirSync(path.join(image, 'usr/local/bin'), { recursive: true });
    fs.copyFileSync(under(PROGRAM), path.join(image, PROGRAM));
    fs.mkdirSync(path.join(image, 'lib'));
    fs.copyFileSync(under(`/lib/${libc}`), path.join(image, 'lib', libc));
    const made = digests(image, path.join(dir, 'check'));
    const d = rootDigest(image);
    assert.equal(made.header, [
      '/* Written by tree_digest.sh: the digest of the root the binary-fs is made of. */',
      `#define FIXED_START_ROOT_DIGEST "${d}"`,
      '',
    ].join('\n'));
    assert.deepEqual(listed(made.listing), [
      ...IMAGE_LISTING,
      'D /lib', `F /lib/${libc}`,
      'D /usr', 'D /usr/local', 'D /usr/local/bin', `F ${PROGRAM}`,
      `= / ${d}`,
    ]);
    assert.ok(made.listing.split('\n').includes(`F 0 ${crypto.createHash('sha256').update('').digest('hex')} ${OPENSSL_CONFIG}`));
    // The same root as the one the launcher of these tests was compiled for.
    assert.deepEqual(made, digest);
  });

  await t.test('a start whose root is the one the digest was written for runs the program\'s main', () => {
    runs('the root as it was made');
  });

  await t.test('a changed file is refused before the program\'s main runs', () => {
    for (const p of [ENTRY, `${ENTRY_DIR}/serverless/backend.js`, `${ENTRY_DIR}/node_modules/pkg/index.js`, OPENSSL_CONFIG]) {
      const was = fs.readFileSync(under(p));
      refusedAt('/', () => fs.writeFileSync(under(p), 'process.exit(0);\n'), () => fs.writeFileSync(under(p), was));
      refusedAt('/', () => fs.appendFileSync(under(p), ' '), () => fs.writeFileSync(under(p), was));
    }
  });

  await t.test('an added file is refused anywhere under the root: in the entry\'s tree, at /, in /usr, where Node looks for modules and where the loader and OpenSSL look', () => {
    addedIsRefused(`${ENTRY_DIR}/added.js`, '/');
    addedIsRefused(`${ENTRY_DIR}/a/x`, '/');
    addedIsRefused(`${ENTRY_DIR}/serverless/added.js`, '/');
    addedIsRefused(`${ENTRY_DIR}/node_modules/other/index.js`, '/', `${ENTRY_DIR}/node_modules/other`);
    addedIsRefused(`${ENTRY_DIR}/fixed-start/legacy.so`, '/');
    addedIsRefused('/added.js', '/');
    addedIsRefused('/.env', '/');
    addedIsRefused('/package.json', '/');
    addedIsRefused('/node_modules/pkg/index.js', '/', '/node_modules');
    addedIsRefused('/etny-trustedzone/sgx_report.node', '/', '/etny-trustedzone');
    addedIsRefused('/usr/added', '/');
    addedIsRefused('/usr/local/bin/added', '/');
    addedIsRefused('/usr/local/lib/node/pkg.js', '/', '/usr/local/lib');
    addedIsRefused('/usr/lib/libadded.so', '/', '/usr/lib');
    addedIsRefused('/lib/libadded.so', '/');
    addedIsRefused('/tmp/added', '/', '/tmp');
    addedIsRefused('/root/.node_modules/pkg.js', '/', '/root');
  });

  await t.test('an added directory without an entry is refused', () => {
    addedIsRefused('/tmp/', '/');
    addedIsRefused(`${ENTRY_DIR}/node_modules/none/`, '/');
    addedIsRefused('/usr/local/lib/', '/');
  });

  await t.test('a removed file, a retargeted link, a file in place of a link and a link in place of a file are refused', () => {
    const file = under(`${ENTRY_DIR}/a-b`);
    const link = under(`${ENTRY_DIR}/link.js`);
    const relink = (target) => { fs.rmSync(link); fs.symlinkSync(target, link); };
    refusedAt('/', () => fs.rmSync(file), () => fs.writeFileSync(file, 'a-b\n'));
    refusedAt('/', () => relink('a-b'), () => relink('a.js'));
    refusedAt('/', () => { fs.rmSync(link); fs.writeFileSync(link, 'module.exports = 2;\n'); }, () => relink('a.js'));
    refusedAt('/', () => { fs.rmSync(file); fs.symlinkSync('a.js', file); }, () => { fs.rmSync(file); fs.writeFileSync(file, 'a-b\n'); });
  });

  await t.test('/dev and /proc are not read: whatever they hold, the start runs', () => {
    put('/dev/added/file');
    put(`/proc/${'d/'.repeat(DEPTH_MAX + 6)}file`);
    fs.symlinkSync('/etc/hosts', under('/dev/link'));
    try {
      runs('with files, a link and a deep directory below /dev and /proc');
    } finally {
      gone('/dev/added');
      gone('/dev/link');
      gone('/proc/d');
    }
    fs.renameSync(under('/proc'), path.join(dir, 'proc.kept'));
    try {
      runs('without /proc');
      put('/proc');
      runs('with a file at /proc');
      gone('/proc');
    } finally {
      fs.renameSync(path.join(dir, 'proc.kept'), under('/proc'));
    }
  });

  await t.test('/etc holds hosts and resolv.conf, either, neither, or is not there, and nothing else', () => {
    runs('with both files');
    fs.renameSync(under('/etc/hosts'), under('/dev/hosts.kept'));
    try {
      runs('with resolv.conf alone');
      fs.renameSync(under('/etc/resolv.conf'), under('/dev/resolv.conf.kept'));
      try {
        runs('with an empty /etc');
        fs.rmdirSync(under('/etc'));
        runs('without /etc');
        refusedAt('/etc', () => put('/etc'), () => gone('/etc'));
        fs.mkdirSync(under('/etc'));
      } finally {
        fs.renameSync(under('/dev/resolv.conf.kept'), under('/etc/resolv.conf'));
      }
      // A name of the list that is a directory hides what it holds.
      refusedAt('/etc/hosts', () => put('/etc/hosts/added'), () => gone('/etc/hosts'));
      fs.symlinkSync('/proc/1/cmdline', under('/etc/hosts'));
      runs('with a link at /etc/hosts');
      gone('/etc/hosts');
    } finally {
      fs.renameSync(under('/dev/hosts.kept'), under('/etc/hosts'));
    }
    addedIsRefused('/etc/passwd', '/etc/passwd');
    addedIsRefused('/etc/ld-musl-x86_64.path', '/etc/ld-musl-x86_64.path');
    addedIsRefused('/etc/localtime', '/etc/localtime');
    addedIsRefused('/etc/ssl/openssl.cnf', '/etc/ssl', '/etc/ssl');
    addedIsRefused('/etc/hosts.d/', '/etc/hosts.d');
    addedIsRefused('/etc/Hosts', '/etc/Hosts');
  });

  await t.test('the session\'s directories hold its certificates and its key by their exact names, and nothing else', () => {
    try {
      for (const p of [`/app/${SESSION}/ca.pem`, `/app/${SESSION}/cert.pem`, `/private/${SESSION}/key.pem`]) {
        put(p, '-----BEGIN-----\n');
        runs(`with the session's files up to ${p}`);
      }
      addedIsRefused(`/app/${SESSION}/enclave_pub_cert.pem`, `/app/${SESSION}/enclave_pub_cert.pem`);
      addedIsRefused(`/app/${SESSION}/key.pem`, `/app/${SESSION}/key.pem`);
      addedIsRefused(`/private/${SESSION}/cert.pem`, `/private/${SESSION}/cert.pem`);
      addedIsRefused('/app/.env', '/app/.env');
      addedIsRefused('/app/result.txt', '/app/result.txt');
      addedIsRefused('/app/other-session/cert.pem', '/app/other-session', '/app/other-session');
      addedIsRefused('/private/key.pem', '/private/key.pem');
      addedIsRefused(`/private/${SESSION}x/key.pem`, `/private/${SESSION}x`, `/private/${SESSION}x`);
      // A listed name that is a directory, and a directory's name that is a file.
      gone(`/app/${SESSION}/cert.pem`);
      refusedAt(`/app/${SESSION}/cert.pem`, () => put(`/app/${SESSION}/cert.pem/added`), () => gone(`/app/${SESSION}/cert.pem`));
      gone('/private');
      refusedAt(`/private/${SESSION}`, () => put(`/private/${SESSION}`), () => gone('/private'));
      refusedAt('/private', () => put('/private'), () => gone('/private'));
    } finally {
      gone('/app');
      gone('/private');
    }
    runs('without the session\'s directories');
  });

  await t.test('an entry deeper than the launcher takes is refused, in the image\'s tree and below it', () => {
    // A directory at depth DEPTH_MAX is read and found not to be the image's; an entry below it is too deep.
    const chain = (n) => `/${Array.from({ length: n }, () => 'd').join('/')}`;
    refusedAt('/', () => fs.mkdirSync(under(chain(DEPTH_MAX)), { recursive: true }), () => gone('/d'));
    fs.mkdirSync(under(chain(DEPTH_MAX + 1)), { recursive: true });
    try {
      refusal(start([], {}), `a path of the tree is deeper than the launcher takes: ${chain(DEPTH_MAX + 1)}`);
      fs.mkdirSync(under(chain(DEPTH_MAX + 200)), { recursive: true });
      refusal(start([], {}), `a path of the tree is deeper than the launcher takes: ${chain(DEPTH_MAX + 1)}`);
    } finally {
      gone('/d');
    }
    runs('without the deep directories');
  });

  await t.test('the digest does not depend on modes, times or the order the entries were made in', () => {
    const entry = under(ENTRY_DIR);
    const beside = ['/dev', '/proc', '/etc'];
    fs.renameSync(entry, path.join(dir, 'entry.kept'));
    try {
      makeImage(root, { reverse: true, mode: 0o600, time: 2e9 });
      // The generator reads the image's files alone.
      for (const p of beside) fs.renameSync(under(p), path.join(dir, `${p.slice(1)}.kept`));
      try {
        assert.deepEqual(digests(root, path.join(dir, 'remade')), digest);
        assert.deepEqual(digests(root, path.join(dir, 'again')), digest);
      } finally {
        for (const p of beside) fs.renameSync(path.join(dir, `${p.slice(1)}.kept`), under(p));
      }
      runs('the entry\'s directory made again in another order');
    } finally {
      fs.rmSync(entry, { recursive: true });
      fs.renameSync(path.join(dir, 'entry.kept'), entry);
    }
  });
});
