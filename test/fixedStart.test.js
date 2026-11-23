// The securelock's fixed start: nodenithy/build/securelock/fixed-start/
// fixed_start.c with the securelock's header securelock.h, linked into the
// extension Dockerfile.tmpl builds. The header's argument vector is the
// ENTRYPOINT build.mjs renders, with node --jitless or without it as
// nodeFlags.js decides; its keys are the ones the securelock's JavaScript
// reads from its environment; the rendered Dockerfile links the launcher into
// /libbinary-fs.so with FIXED_START_JITLESS set to match the ENTRYPOINT. The
// file tree check: fixed-start/securelock.tree names the paths from which node
// loads code, the release stage writes their digests with
// fixed-start/tree_digest.sh after it makes the binary-fs, and the link line
// compiles them into the launcher. The launcher and the generator are the same
// files in the pynithy mirror and in etny-nodenithy. With a musl C library,
// gcc and bash on the host, the launcher is compiled with the securelock's
// header and the digests of a tree, and a program started through it runs
// with the fixed vector and the listed keys whatever it is started with, and
// only while that tree is the one the digests were written for.
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
const { securelockNodeFlags } = require('../nodenithy/nodeFlags.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECURELOCK = path.join(ROOT, 'nodenithy', 'build', 'securelock');
const SRC = path.join(SECURELOCK, 'src');
const LAUNCHER = path.join(SECURELOCK, 'fixed-start', 'fixed_start.c');
const HEADER = path.join(SECURELOCK, 'fixed-start', 'securelock.h');
const TREE_FILE = path.join(SECURELOCK, 'fixed-start', 'securelock.tree');
const TREE_DIGEST = path.join(SECURELOCK, 'fixed-start', 'tree_digest.sh');
const MIRROR_FIXED_START = path.join(ROOT, 'pynithy', 'build', 'securelock', 'fixed-start');
const MIRROR_LAUNCHER = path.join(MIRROR_FIXED_START, 'fixed_start.c');
// The etny-nodenithy checkout: ETNY_NODENITHY, else the sibling of this repository.
const NODENITHY = path.resolve(process.env.ETNY_NODENITHY || path.join(ROOT, '..', 'etny-nodenithy'));
const NODENITHY_FIXED_START = path.join(NODENITHY, 'v3', 'build', 'trustedzone', 'fixed-start');
const NODENITHY_LAUNCHER = path.join(NODENITHY_FIXED_START, 'fixed_start.c');

const ENTRY = '/etny-securelock/securelock.js';
// The paths the file tree check covers: the entry's directory, the
// node_modules of its parent and Node's global folder (securelock.tree).
const TREE = ['/etny-securelock', '/node_modules', '/usr/local/lib/node'];
const VECTORS = {
  0: ['/usr/local/bin/node', ENTRY],
  1: ['/usr/local/bin/node', '--jitless', ENTRY],
};
const ALLOWED = [
  'ETNY_MODE', 'ETNY_ORDER_ID', 'ETNY_CLIENT_CHALLENGE', 'ECAS_ATTEST_SESSION', 'ECAS_ENCLAVE_NONCE',
  'ECAS_CAS_QUOTE', 'ESR_CONTRACT_ADDRESS',
];
// Read by esr_wallet.js and not passed (securelock.h).
const NOT_PASSED = ['ESR_IDENTITY_SECRET'];
const SPACE = 32768;
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
// #else branch), its fixed variables and its keys.
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
  return { args: { 1: args(branch[1]), 0: args(branch[2]) }, env: literals(env), allowed: literals(allowed) };
}

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
const linkLine = (jitless) => 'RUN scone gcc ./binary_fs_blob.s -O2 -fPIC -include /fixed-start/securelock.h '
  + `-include /fixed_start_tree.h -DFIXED_START_JITLESS=${jitless} /fixed-start/fixed_start.c ./libbinary_fs_template.a `
  + '-shared -o /libbinary-fs.so';
const TREE_RUN = 'RUN bash /fixed-start/tree_digest.sh /fixed-start/securelock.tree '
  + '/binary-fs-dir/fixed_start_tree.h /binary-fs-dir/fixed_start_tree.txt';
const stages = (dockerfile) => dockerfile.split(/^(?=FROM )/m).filter((s) => s.startsWith('FROM '));
const treePaths = (text) => text.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('#'));

test('the header\'s vectors are node with and without --jitless, then securelock.js', () => {
  assert.deepEqual(fixedStart(read(HEADER)).args, VECTORS);
});

test('every node flag set nodeFlags.js gives has a vector in the header', () => {
  const sets = new Set();
  for (const heap of ['128M', '256M', '512M', '1000M', '1024M', '1G', '2G', '64G']) {
    for (const override of [undefined, '', '0', '1', 'true', 'no']) sets.add(JSON.stringify(securelockNodeFlags(heap, override)));
  }
  assert.deepEqual([...sets].sort(), [JSON.stringify([]), JSON.stringify(['--jitless'])].sort());
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

test('Dockerfile.tmpl links the launcher into /libbinary-fs.so once, in the cross compiler stage, after the COPY of fixed-start/', () => {
  const dockerfile = read(path.join(SECURELOCK, 'Dockerfile.tmpl'));
  const writers = dockerfile.split('\n').filter((l) => /-o \/libbinary-fs\.so\b/.test(l));
  assert.deepEqual(writers, [linkLine('__FIXED_START_JITLESS__')]);
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

test('the release stage writes the tree\'s digests after it makes the binary-fs, into the directory the link stage takes', () => {
  const [release, ...others] = stages(read(path.join(SECURELOCK, 'Dockerfile.tmpl'))).filter((s) => s.includes(TREE_RUN));
  assert.deepEqual(others, []);
  assert.match(release, /^FROM \$\{SCONE_NODE\} AS release$/m);
  const make = release.indexOf('RUN etny-securelock/binary-fs-build.sh\n');
  const copy = release.indexOf('COPY fixed-start/ /fixed-start/\n');
  const run = release.indexOf(TREE_RUN);
  assert.ok(make >= 0 && make < copy && copy < run);
  // Nothing after the digests changes the file system the binary-fs was made from.
  assert.deepEqual(release.slice(run).split('\n').filter((l) => /^(RUN|COPY|ADD) /.test(l)), [TREE_RUN]);
  assert.match(read(path.join(SECURELOCK, 'scripts', 'binary-fs-build.sh')), /--include '\/etny-securelock\/\*'/);
});

test('the tree file names the entry\'s directory, the node_modules of its parent and Node\'s global folder', () => {
  assert.deepEqual(treePaths(read(TREE_FILE)), TREE);
  assert.equal(TREE[0], path.posix.dirname(ENTRY));
  assert.equal(TREE[1], path.posix.join(path.posix.dirname(TREE[0]), 'node_modules'));
  assert.equal(TREE[2], path.posix.join(path.posix.dirname(path.posix.dirname(VECTORS[0][0])), 'lib', 'node'));
  const { env, allowed } = fixedStart(read(HEADER));
  assert.ok(!env.some((entry) => entry.startsWith('HOME=')) && !allowed.includes('HOME'), 'no HOME: no folder under a home directory');
});

test('the rendered Dockerfile links the launcher with the vector of its ENTRYPOINT and leaves no token', () => {
  for (const [memory, jitless] of [['256M', 1], ['1024M', 0], ['2G', 0]]) {
    for (const production of [false, true]) {
      const dockerfile = render(memory, production);
      assert.doesNotMatch(dockerfile, /__[A-Z][A-Z0-9_]*__/, `${memory} production=${production}`);
      assert.ok(dockerfile.split('\n').includes(linkLine(jitless)), `${memory} links with FIXED_START_JITLESS=${jitless}`);
      const entrypoint = /^ENTRYPOINT (\[.*\])\s*$/m.exec(dockerfile);
      assert.deepEqual(JSON.parse(entrypoint[1]), VECTORS[jitless]);
      const sign = dockerfile.split('\n').filter((l) => l.startsWith('RUN scone-signer sign '));
      assert.deepEqual(sign, [`RUN scone-signer sign --key=/enclave-key.pem --env --heap=${memory} --stack=4M --tcs=64 `
        + `--dlopen=1 --extensions=/lib/libbinary-fs.so${production ? ' --production' : ''} /usr/local/bin/node`]);
      assert.match(dockerfile, new RegExp(`^ENV SCONE_HEAP=${memory}$`, 'm'));
    }
  }
});

test('the rendered Dockerfile takes the build\'s network values and its ESR line', () => {
  const dockerfile = renderSecurelockDockerfile(read(path.join(SECURELOCK, 'Dockerfile.tmpl')), {
    ...VALUES, esrEnvBlock: 'ENV ESR_CONTRACT_ADDRESS=0x0Ea1728EAE108FD3B9340ae91451348E2Cc6b4E4',
    validatorRegistryAddress: '0x0000000000000000000000000000000000000001', memory: '256M', nodeFlags: ['--jitless'], production: true,
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

test('fixed_start.c and tree_digest.sh are the same files in the pynithy mirror', () => {
  assert.equal(lf(LAUNCHER), lf(MIRROR_LAUNCHER));
  assert.equal(lf(TREE_DIGEST), lf(path.join(MIRROR_FIXED_START, 'tree_digest.sh')));
});

test('fixed_start.c and tree_digest.sh are byte-identical to etny-nodenithy\'s when that checkout is present', (t) => {
  if (!fs.existsSync(NODENITHY_LAUNCHER)) {
    t.skip(`no etny-nodenithy checkout at ${NODENITHY} (set ETNY_NODENITHY)`);
    return;
  }
  assert.equal(lf(LAUNCHER), lf(NODENITHY_LAUNCHER));
  assert.equal(lf(TREE_DIGEST), lf(path.join(NODENITHY_FIXED_START, 'tree_digest.sh')));
});

function launcherToolchainMissing() {
  if (process.platform !== 'linux') return `the host is ${process.platform}, not Linux`;
  if (!fs.readdirSync('/lib').some((f) => /^ld-musl-.*\.so\.1$/.test(f))) return 'the host C library is not musl';
  if (spawnSync('gcc', ['--version']).status !== 0) return 'gcc is not on PATH';
  if (spawnSync('bash', ['--version']).status !== 0) return 'bash is not on PATH';
  return null;
}

// The digest of the tree at p as fixed_start.c defines it, computed here from
// the definition.
function treeDigest(p) {
  const h = crypto.createHash('sha256');
  const record = (...fields) => { for (const f of fields) h.update(Buffer.concat([Buffer.from(f), Buffer.from([0])])); };
  const entry = (x) => {
    const st = fs.lstatSync(x);
    if (st.isFile()) {
      const data = fs.readFileSync(x);
      record(`F${x}`, String(data.length), crypto.createHash('sha256').update(data).digest('hex'));
    } else if (st.isSymbolicLink()) {
      record(`L${x}`, fs.readlinkSync(x));
    } else if (st.isDirectory()) {
      for (const name of fs.readdirSync(x).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) entry(`${x}/${name}`);
    } else {
      record(`O${x}`);
    }
  };
  if (fs.lstatSync(p, { throwIfNoEntry: false })) entry(p); else record(`A${p}`);
  return h.digest('hex');
}

// A tree for the launcher's tests: an entry, a module, a dApp backend, a
// node_modules package, names whose bytewise order differs from a sort of the
// whole paths (a/, a-b, a.js) and a symbolic link. reverse reverses the order
// the entries are made in; mode and time set the files' modes and times.
function makeTree(root, { reverse = false, mode = 0o644, time = 1e9 } = {}) {
  const files = [
    ['securelock.js', 'require("./a");\n'], ['a/x.js', 'module.exports = 1;\n'], ['a-b', 'a-b\n'], ['a.js', 'module.exports = 2;\n'],
    ['serverless/backend.js', 'module.exports = { hello: (m) => m };\n'], ['node_modules/pkg/index.js', 'module.exports = "pkg";\n'],
  ];
  const steps = [
    ...files.map(([name, content]) => () => {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content, { mode });
      fs.utimesSync(path.join(root, name), time, time);
    }),
    () => fs.symlinkSync('a.js', path.join(root, 'link.js')),
  ];
  fs.mkdirSync(root, { recursive: true });
  for (const step of reverse ? steps.reverse() : steps) step();
}

const STARTED_C = `#include <stdio.h>
#include <string.h>
extern char **environ;
int main(int argc, char **argv, char **envp)
{
    int i;
    int contiguous = 1;
    char **e;
    for (i = 0; i < argc; i++) {
        printf("arg %s\\n", argv[i]);
        if (i > 0 && argv[i] != argv[i - 1] + strlen(argv[i - 1]) + 1)
            contiguous = 0;
    }
    for (e = environ; *e != NULL; e++)
        printf("env %s\\n", *e);
    printf("envp %s\\n", envp == environ ? "environ" : "other");
    printf("contiguous %d\\n", contiguous);
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

test.describe('the launcher, compiled with the securelock\'s header (musl, gcc)', () => {
  const missing = launcherToolchainMissing();
  let dir;
  let tree;
  let absent;
  let treeFile;
  const built = {};

  // tree_digest.sh over treeFile: its header and its listing.
  const digests = (out) => {
    const r = spawnSync('bash', [TREE_DIGEST, treeFile, `${out}.h`, `${out}.txt`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { header: read(`${out}.h`), listing: read(`${out}.txt`) };
  };

  test.before(() => {
    if (missing) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-start-'));
    const gcc = (args) => {
      const r = spawnSync('gcc', args, { encoding: 'utf8' });
      assert.equal(r.status, 0, `gcc ${args.join(' ')}: ${r.stderr}`);
    };
    tree = path.join(dir, 'etny-securelock');
    absent = path.join(dir, 'node_modules');
    treeFile = path.join(dir, 'test.tree');
    makeTree(tree);
    fs.writeFileSync(treeFile, `# the test's paths\n${tree}\n${absent}\n`);
    digests(path.join(dir, 'fixed_start_tree'));
    fs.writeFileSync(path.join(dir, 'started.c'), STARTED_C);
    fs.writeFileSync(path.join(dir, 'loader.c'), LOADER_C);
    for (const jitless of [0, 1]) {
      const sub = path.join(dir, String(jitless));
      fs.mkdirSync(sub);
      const launcher = path.join(sub, 'libfixedstart.so');
      gcc(['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-include', HEADER,
        '-include', path.join(dir, 'fixed_start_tree.h'), `-DFIXED_START_JITLESS=${jitless}`, '-o', launcher, LAUNCHER]);
      const started = path.join(sub, 'started');
      gcc(['-O2', '-o', started, path.join(dir, 'started.c'), `-L${sub}`, '-lfixedstart', `-Wl,-rpath,${sub}`]);
      built[jitless] = { launcher, started };
    }
    built.loader = path.join(dir, 'loader');
    gcc(['-O2', '-o', built.loader, path.join(dir, 'loader.c')]);
  });
  test.after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const lines = (out, tag) => out.split('\n').filter((l) => l.startsWith(`${tag} `)).map((l) => l.slice(tag.length + 1));

  test('a program started through either build runs that build\'s vector, in one block, with the listed keys alone', (t) => {
    if (missing) { t.skip(missing); return; }
    for (const jitless of [0, 1]) {
      const r = spawnSync(built[jitless].started, ['-e', 'process.exit(3)'], {
        encoding: 'utf8',
        env: {
          NODE_OPTIONS: '--require /etc/hosts', ETNY_MODE: 'PUBLIC_KEY', ETNY_MODEX: '1', ESR_IDENTITY_SECRET: '1',
          ESR_CONTRACT_ADDRESS: '0x0Ea1728EAE108FD3B9340ae91451348E2Cc6b4E4', HOME: '/root',
        },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(lines(r.stdout, 'arg'), VECTORS[jitless]);
      assert.deepEqual(lines(r.stdout, 'env'), ['ETNY_MODE=PUBLIC_KEY', 'ESR_CONTRACT_ADDRESS=0x0Ea1728EAE108FD3B9340ae91451348E2Cc6b4E4']);
      assert.deepEqual(lines(r.stdout, 'envp'), ['environ']);
      assert.deepEqual(lines(r.stdout, 'contiguous'), ['1']);
    }
  });

  test('every listed key is passed with its value as it is, up to the launcher\'s space', (t) => {
    if (missing) { t.skip(missing); return; }
    const env = Object.fromEntries(ALLOWED.map((key, i) => [key, `value ${i} = -e x`]));
    const r = spawnSync(built[0].started, [], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(r.stdout, 'env'), ALLOWED.map((key, i) => `${key}=value ${i} = -e x`));
    const over = spawnSync(built[0].started, [], { encoding: 'utf8', env: { ECAS_CAS_QUOTE: 'A'.repeat(SPACE) } });
    assert.equal(over.status, REFUSED);
    assert.match(over.stderr, /^fixed start: the start is refused: the environment exceeds the launcher's space\n$/);
  });

  test('a start that did not come through the launcher is refused when its object is loaded', (t) => {
    if (missing) { t.skip(missing); return; }
    const r = spawnSync(built.loader, [built[1].launcher], { encoding: 'utf8' });
    assert.equal(r.status, REFUSED);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^fixed start: the start is refused: the start did not come through the launcher\n$/);
  });

  const start = (jitless) => spawnSync(built[jitless].started, [], { encoding: 'utf8', env: { ETNY_MODE: 'PUBLIC_KEY' } });

  // Both builds refused after change() and, once undone, started again.
  const refusedAt = (where, change, undo) => {
    change();
    try {
      for (const jitless of [0, 1]) {
        const r = start(jitless);
        assert.equal(r.status, REFUSED, r.stdout);
        assert.equal(r.stdout, '');
        assert.equal(r.stderr, `fixed start: the start is refused: the file tree is not the image's at ${where}\n`);
      }
    } finally {
      undo();
    }
    for (const jitless of [0, 1]) assert.equal(start(jitless).status, 0);
  };

  test('the generator writes the digest of each path the tree file names, as fixed_start.c defines it', (t) => {
    if (missing) { t.skip(missing); return; }
    const { header, listing } = digests(path.join(dir, 'check'));
    assert.equal(header, [
      '/* Written by tree_digest.sh from test.tree: the digest of each path. */',
      '#define FIXED_START_TREE \\',
      `    { "${tree}", "${treeDigest(tree)}" }, \\`,
      `    { "${absent}", "${treeDigest(absent)}" }, \\`,
      '',
      '',
    ].join('\n'));
    assert.deepEqual(listing.split('\n').filter((l) => /^[FLOA] /.test(l)).map((l) => l.split(' ').at(-1)), [
      `${tree}/a/x.js`, `${tree}/a-b`, `${tree}/a.js`, 'a.js', `${tree}/node_modules/pkg/index.js`, `${tree}/securelock.js`,
      `${tree}/serverless/backend.js`, absent,
    ]);
  });

  test('a start whose tree is the one the digests were written for runs the program\'s main', (t) => {
    if (missing) { t.skip(missing); return; }
    for (const jitless of [0, 1]) {
      const r = start(jitless);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(lines(r.stdout, 'arg'), VECTORS[jitless]);
    }
  });

  test('a changed file is refused: the entry, a module and the dApp\'s backend', (t) => {
    if (missing) { t.skip(missing); return; }
    for (const rel of ['securelock.js', 'node_modules/pkg/index.js', 'serverless/backend.js']) {
      const file = path.join(tree, rel);
      const was = fs.readFileSync(file);
      refusedAt(tree, () => fs.writeFileSync(file, 'process.exit(0);\n'), () => fs.writeFileSync(file, was));
    }
  });

  test('an added file is refused: beside a file of the tree, without an extension, in a new directory and at a path the tree does not hold', (t) => {
    if (missing) { t.skip(missing); return; }
    const add = (file) => () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'process.exit(0);\n');
    };
    refusedAt(tree, add(path.join(tree, 'added.js')), () => fs.rmSync(path.join(tree, 'added.js')));
    refusedAt(tree, add(path.join(tree, 'a', 'x')), () => fs.rmSync(path.join(tree, 'a', 'x')));
    const other = path.join(tree, 'node_modules', 'other');
    refusedAt(tree, add(path.join(other, 'index.js')), () => fs.rmSync(other, { recursive: true }));
    refusedAt(absent, add(path.join(absent, 'pkg', 'index.js')), () => fs.rmSync(absent, { recursive: true }));
  });

  test('the digests do not depend on modes, times or the order the entries were made in', (t) => {
    if (missing) { t.skip(missing); return; }
    const first = digests(path.join(dir, 'first'));
    assert.deepEqual(digests(path.join(dir, 'second')), first);
    fs.renameSync(tree, `${tree}-kept`);
    try {
      makeTree(tree, { reverse: true, mode: 0o600, time: 2e9 });
      assert.deepEqual(digests(path.join(dir, 'remade')), first);
      assert.equal(start(0).status, 0);
    } finally {
      fs.rmSync(tree, { recursive: true });
      fs.renameSync(`${tree}-kept`, tree);
    }
  });
});
