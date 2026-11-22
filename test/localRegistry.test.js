// The registry a publish serves its own build's image tree from, and the
// record ecld-build leaves for it: the digest and signed MRENCLAVE read after
// the push, the container over the tree on a loopback port, the local compose
// rendered against it while the shipped one keeps localhost:5000, the gate
// that refuses a tree serving another securelock, and the removal of the
// publish's containers on every exit. No docker and no network: the docker
// client and the readiness probe are replaced, and the readiness deadline
// runs on mocked timers; run.js and build.mjs are read as text, since they
// run the publish and the build when loaded (localKubo.test.js drives the
// interruption they wire up).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const casConfig = require('../cas/config.js');
const {
  LocalRegistry, REPOSITORIES, SECURELOCK_IMAGE, REPO_DIGESTS_FORMAT, repoDigestIn, mrenclaveIn, pushedSecurelock,
  recordedSecurelockBuild, servedDigest, composeAgainst, buildGateRefusal,
} = require('../localRegistry.js');

const DIGEST = 'sha256:' + 'ab'.repeat(32);
const OTHER_DIGEST = 'sha256:' + 'cd'.repeat(32);
const SIGNED = '81a7f8e8' + '0'.repeat(56);
const OTHER_MRENCLAVE = '571eb7c6' + '0'.repeat(56);
const HOST = '127.0.0.1:49153';
const INSPECT = `docker inspect ${SECURELOCK_IMAGE} --format "${REPO_DIGESTS_FORMAT}"`;
const CAT = 'docker run --rm --entrypoint cat etny-securelock:latest /signed_mrenclave.txt';
const ROOT = path.join(__dirname, '..');

// A command runner answering each command with the output of the first key
// it contains ('' otherwise) and recording the commands.
function runner(outputs) {
  const commands = [];
  const run = (command) => {
    commands.push(command);
    const key = Object.keys(outputs).find((k) => command.includes(k));
    return key === undefined ? '' : outputs[key];
  };
  return { run, commands };
}

test('the digest is the repository\'s own among several RepoDigests, none when it has none', () => {
  const alpine = `alpine@sha256:${'d9'.repeat(32)}`;
  assert.equal(repoDigestIn(`${alpine}\n${SECURELOCK_IMAGE}@${DIGEST}\n`, SECURELOCK_IMAGE), DIGEST);
  assert.equal(repoDigestIn(`${SECURELOCK_IMAGE}@${DIGEST}\n${HOST}/etny-securelock@${DIGEST}\n`, `${HOST}/etny-securelock`), DIGEST);
  assert.equal(repoDigestIn(`${alpine}\n`, SECURELOCK_IMAGE), '');
  assert.equal(repoDigestIn('', SECURELOCK_IMAGE), '');
  assert.equal(repoDigestIn(undefined, SECURELOCK_IMAGE), '');
});

test('a MRENCLAVE is the first 64-hex token of what the image printed', () => {
  assert.equal(mrenclaveIn(`${SIGNED}\n`), SIGNED);
  assert.equal(mrenclaveIn(`Creating network\nSIGNED_MRENCLAVE=${SIGNED}`), SIGNED);
  assert.equal(mrenclaveIn("cat: can't open '/signed_mrenclave.txt': No such file or directory"), '');
  assert.equal(mrenclaveIn(''), '');
});

test('the build records the pushed digest and the signed MRENCLAVE from two docker commands', () => {
  const { run, commands } = runner({ 'docker inspect': `${SECURELOCK_IMAGE}@${DIGEST}\n`, signed_mrenclave: `${SIGNED}\n` });
  assert.deepEqual(pushedSecurelock(run), { digest: DIGEST, signed: SIGNED });
  assert.deepEqual(commands, [INSPECT, CAT]);
});

test('the recorded digest is the local registry\'s among several', () => {
  const { run } = runner({
    'docker inspect': `registry.example/team/etny-securelock@sha256:${'ff'.repeat(32)}\n${SECURELOCK_IMAGE}@${DIGEST}\n`,
    signed_mrenclave: SIGNED,
  });
  assert.equal(pushedSecurelock(run).digest, DIGEST);
});

test('a push docker records no digest of fails the build, naming what docker printed', () => {
  const none = runner({ 'docker inspect': '', signed_mrenclave: SIGNED });
  assert.throws(() => pushedSecurelock(none.run),
    { message: `docker records no digest of ${SECURELOCK_IMAGE} after the push (got '').` });
  assert.deepEqual(none.commands, [INSPECT]);
  const other = runner({ 'docker inspect': `alpine@sha256:${'d9'.repeat(32)}\n`, signed_mrenclave: SIGNED });
  assert.throws(() => pushedSecurelock(other.run),
    { message: `docker records no digest of ${SECURELOCK_IMAGE} after the push (got 'alpine@sha256:${'d9'.repeat(32)}').` });
});

test('an image without a signed MRENCLAVE fails the build', () => {
  const { run } = runner({
    'docker inspect': `${SECURELOCK_IMAGE}@${DIGEST}\n`,
    signed_mrenclave: "cat: can't open '/signed_mrenclave.txt': No such file or directory",
  });
  assert.throws(() => pushedSecurelock(run),
    { message: "the securelock image holds no signed MRENCLAVE in /signed_mrenclave.txt (got 'cat: can't open '/signed_mrenclave.txt': No such file or directory')." });
});

test('the publish reads the build\'s record from .env', () => {
  assert.deepEqual(recordedSecurelockBuild({ SECURELOCK_IMAGE_DIGEST: ` ${DIGEST} `, MRENCLAVE_SECURELOCK_SIGNED: SIGNED }),
    { digest: DIGEST, signed: SIGNED });
});

test('a build by an older SDK, with either record missing, ends the publish with the message to build again', () => {
  const message = 'this build records no SECURELOCK_IMAGE_DIGEST and MRENCLAVE_SECURELOCK_SIGNED.\n'
    + '       The securelock was built by an SDK older than these records; run ecld-build with the current SDK, then publish again.';
  for (const env of [
    {},
    { SECURELOCK_IMAGE_DIGEST: DIGEST },
    { MRENCLAVE_SECURELOCK_SIGNED: SIGNED },
    { SECURELOCK_IMAGE_DIGEST: '', MRENCLAVE_SECURELOCK_SIGNED: SIGNED },
    { SECURELOCK_IMAGE_DIGEST: DIGEST, MRENCLAVE_SECURELOCK_SIGNED: ' ' },
  ]) {
    assert.throws(() => recordedSecurelockBuild(env), { message }, JSON.stringify(env));
  }
});

test('the served digest is read from the pulled image, none when docker does not know it', () => {
  const { run, commands } = runner({ 'docker inspect': `${HOST}/etny-securelock@${DIGEST}\n` });
  assert.equal(servedDigest(`${HOST}/etny-securelock`, run), DIGEST);
  assert.deepEqual(commands, [`docker inspect ${HOST}/etny-securelock --format "${REPO_DIGESTS_FORMAT}"`]);
  assert.equal(servedDigest(`${HOST}/etny-securelock`, () => { throw new Error('No such object'); }), '');
});

// The image references of a compose, in order.
const imagesOf = (compose) => [...compose.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]);

for (const runner_ of ['nodenithy', 'pynithy']) {
  const render = (file, unsafe) => casConfig.renderCompose(
    fs.readFileSync(path.join(ROOT, runner_, 'run', `${file}.tmpl`), 'utf8'), false, unsafe)
    .replace(/__TRUSTEDZONE_HEAP__/g, '1024M')
    .replace(/__MEMORY_TO_ALLOCATE__/g, '256M');

  test(`${runner_}: the local compose names the build's registry and the shipped one localhost:5000`, () => {
    const local = composeAgainst(render('docker-compose.yml', false), HOST);
    const final = render('docker-compose-final.yml', false);
    assert.deepEqual(imagesOf(local), [`${HOST}/etny-las`, `${HOST}/etny-securelock`, `${HOST}/etny-trustedzone`]);
    assert.deepEqual(imagesOf(final), ['localhost:5000/etny-las', 'localhost:5000/etny-securelock', 'localhost:5000/etny-trustedzone']);
    assert.ok(!local.includes('localhost:5000'));
    assert.ok(!final.includes(HOST));
    assert.equal(composeAgainst(final, HOST).replace(new RegExp(HOST, 'g'), 'localhost:5000'), final);
  });

  test(`${runner_}: an -unsafe network's local compose names the two images it runs at the build's registry`, () => {
    assert.deepEqual(imagesOf(composeAgainst(render('docker-compose.yml', true), HOST)),
      [`${HOST}/etny-securelock`, `${HOST}/etny-trustedzone`]);
  });
}

test('the gate refuses a tree serving another digest, before anything else', () => {
  const recorded = { digest: DIGEST, signed: SIGNED };
  const lines = [
    `Error: the securelock served by this build's image tree has digest ${OTHER_DIGEST}, not the SECURELOCK_IMAGE_DIGEST recorded at build (${DIGEST}).`,
    '       The tree does not hold the image ecld-build recorded. Refusing to publish; run ecld-build again.',
  ];
  assert.deepEqual(buildGateRefusal(recorded, OTHER_DIGEST, SIGNED), lines);
  assert.deepEqual(buildGateRefusal(recorded, OTHER_DIGEST, OTHER_MRENCLAVE), lines);
  assert.deepEqual(buildGateRefusal(recorded, '', SIGNED), [lines[0].replace(OTHER_DIGEST, 'none'), lines[1]]);
});

test('the gate refuses a measurement other than the signed one recorded', () => {
  assert.deepEqual(buildGateRefusal({ digest: DIGEST, signed: SIGNED }, DIGEST, OTHER_MRENCLAVE), [
    `Error: securelock runtime MRENCLAVE (${OTHER_MRENCLAVE}) != MRENCLAVE_SECURELOCK_SIGNED recorded at build (${SIGNED}).`,
    '       The measured enclave is not the one ecld-build signed. Refusing to publish; run ecld-build again.',
  ]);
});

test('the gate passes the build\'s own image', () => {
  assert.equal(buildGateRefusal({ digest: DIGEST, signed: SIGNED }, DIGEST, SIGNED), null);
});

function tree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'docker', 'registry', 'v2'), { recursive: true });
  return dir;
}

// A registry whose docker client records every command, with `docker run`
// refused with `runError` on stderr when given, and whose readiness probe
// answers at once.
function registry(treePath, runError) {
  const r = new LocalRegistry('accept m3', treePath);
  const commands = [];
  r.docker = (args) => {
    commands.push(args);
    if (args[0] === 'run' && runError) {
      const e = new Error('exit 125');
      e.stderr = runError;
      throw e;
    }
    return '';
  };
  r.answers = async () => {};
  return { r, commands };
}

test('the registry container is named after the project', () => {
  assert.equal(new LocalRegistry('accept m3', '/tmp/x').container, 'ecld-registry-accept-m3');
});

test('start serves the tree read-only on a loopback port free on the host and waits for the registry', async (t) => {
  const treePath = tree(t);
  const { r, commands } = registry(treePath);
  await r.start();
  assert.deepEqual(commands[0], ['rm', '-f', '-v', 'ecld-registry-accept-m3']);
  const run = commands[1];
  assert.deepEqual(run.slice(0, 5), ['run', '-d', '--name', 'ecld-registry-accept-m3', '-p']);
  assert.match(run[5], /^127\.0\.0\.1:\d+:5000$/);
  assert.deepEqual(run.slice(6), ['-v', `${treePath}:/var/lib/registry:ro`, 'registry:2']);
  assert.equal(commands.length, 2);
  assert.equal(r.host, run[5].replace(/:5000$/, ''));
  assert.equal(r.image('etny-securelock'), `${r.host}/etny-securelock`);
});

test('a directory that is no build tree is refused before docker runs', async (t) => {
  const { r, commands } = registry(path.join(tree(t), 'missing'));
  await assert.rejects(() => r.start(), { message: /run ecld-build first/ });
  assert.deepEqual(commands, []);
  assert.equal(r.host, null);
});

test('a run docker refuses leaves no container', async (t) => {
  const { r, commands } = registry(tree(t), 'port is already allocated');
  await assert.rejects(() => r.start(), { message: 'docker could not start registry:2: port is already allocated' });
  assert.equal(commands[1][0], 'run');
  assert.deepEqual(commands[2], ['rm', '-f', '-v', 'ecld-registry-accept-m3']);
  assert.equal(commands.length, 3);
  assert.equal(r.host, null);
});

test('a registry that does not answer in time is removed, with the tags of its port', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { r, commands } = registry(tree(t));
  r.answers = async () => { throw new Error('connect ECONNREFUSED'); };
  const started = r.start();
  const rejected = assert.rejects(started, { message: 'the registry ecld-registry-accept-m3 did not answer in 30s' });
  // start() probes, sleeps a second and probes again until the deadline; each
  // turn of the real event loop lets a probe fail, each tick ends a sleep.
  for (let i = 0; i < 35 && commands.length < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  await rejected;
  assert.equal(commands[1][0], 'run');
  const host = commands[1][5].replace(/:5000$/, '');
  assert.deepEqual(commands.slice(2), [
    ['rm', '-f', '-v', 'ecld-registry-accept-m3'],
    ['rmi', ...REPOSITORIES.map((repository) => `${host}/${repository}`)],
  ]);
});

test('stop removes the container with its anonymous volumes, and the tags pulled from it once it served', async (t) => {
  const { r, commands } = registry(tree(t));
  r.stop();
  assert.deepEqual(commands, [['rm', '-f', '-v', 'ecld-registry-accept-m3']]);
  await r.start();
  commands.length = 0;
  r.stop();
  assert.deepEqual(commands, [
    ['rm', '-f', '-v', 'ecld-registry-accept-m3'],
    ['rmi', ...REPOSITORIES.map((repository) => `${r.host}/${repository}`)],
  ]);
});

test('every container the registry removes is removed with -v: the one a previous publish left, a refused run, the stop', async (t) => {
  for (const runError of [undefined, 'port is already allocated']) {
    const { r, commands } = registry(tree(t), runError);
    await r.start().catch(() => {});
    r.stop();
    const removals = commands.filter((args) => args[0] === 'rm');
    assert.equal(removals.length, runError ? 3 : 2);
    for (const removal of removals) assert.deepEqual(removal, ['rm', '-f', '-v', 'ecld-registry-accept-m3']);
  }
});

for (const runner_ of ['nodenithy', 'pynithy']) {
  test(`${runner_}/run.js measures the tree's securelock through localRegistry.js, removes the registry and releases the Kubo on exit`, () => {
    const src = fs.readFileSync(path.join(ROOT, runner_, 'run.js'), 'utf8');
    assert.match(src, /const \{ LocalRegistry, recordedSecurelockBuild, servedDigest, composeAgainst, buildGateRefusal \} = require\('\.\.\/localRegistry\.js'\);/);
    assert.ok(src.indexOf('recordedBuild = recordedSecurelockBuild(process.env)') < src.indexOf('new LocalKubo('),
      'the build\'s record is checked before any container starts');
    assert.match(src, /new LocalRegistry\(process\.env\.PROJECT_NAME, registryPath\)/);
    assert.match(src, /process\.on\('exit', \(\) => localRegistry\.stop\(\)\);/);
    assert.doesNotMatch(src, /localRegistry\.release\(/, 'the registry is removed on every exit: nothing on chain names it');
    assert.match(src, /process\.on\('exit', \(\) => localKubo\.release\(\)\);/);
    // An interruption exits through process.exit, which runs those listeners.
    assert.match(src, /const \{ LocalKubo, ownEndpoint, exitOnInterrupt, pinOnPublicApi \} = require\('\.\.\/localKubo\.js'\);/);
    const wired = src.indexOf('\nexitOnInterrupt(rl);\n');
    assert.ok(wired > 0 && wired < src.indexOf('const main = async () => {'), 'wired up at load, before the publish starts anything');
    assert.ok(src.indexOf("process.on('exit', () => localKubo.release());") < src.indexOf('await localKubo.start()'),
      'the Kubo is released on an exit while it starts: one started afresh removed, a taken-over one kept');
    assert.ok(src.indexOf("process.on('exit', () => localRegistry.stop());") < src.indexOf('await localRegistry.start()'),
      'the registry is removed on an exit while it starts');
    assert.doesNotMatch(src, /process\.on\(signal/, 'the signals are listened to by exitOnInterrupt alone');
    assert.match(src, /if \(file === 'docker-compose\.yml'\) content = composeAgainst\(content, localRegistry\.host\);/);
    assert.match(src, /execSync\('docker-compose -f docker-compose\.yml pull', \{ stdio: 'inherit' \}\);/);
    assert.match(src, /const served = servedDigest\(localRegistry\.image\('etny-securelock'\), dockerOutput\);/);
    assert.match(src, /buildGateRefusal\(recordedBuild, served, process\.env\.MRENCLAVE_SECURELOCK\)/);
    assert.doesNotMatch(src, /'localhost:5000\/etny-trustedzone'/, 'the trustedzone is read from the tree, not from the machine\'s registry');
  });

  test(`${runner_}/build.mjs records the pushed securelock in .env right after the push`, () => {
    const src = fs.readFileSync(path.join(ROOT, runner_, 'build.mjs'), 'utf8');
    const push = src.indexOf("runCommand('docker push localhost:5000/etny-securelock');");
    const record = src.indexOf('pushed = localRegistry.pushedSecurelock((command) => shell.exec(command, { silent: true }).stdout);');
    assert.ok(push > 0 && record > push);
    assert.ok(src.indexOf("writeEnv('SECURELOCK_IMAGE_DIGEST', pushed.digest);") > record);
    assert.ok(src.indexOf("writeEnv('MRENCLAVE_SECURELOCK_SIGNED', pushed.signed);") > record);
    assert.ok(src.indexOf("process.chdir('..')", push) > record, 'recorded before the build leaves the securelock directory');
  });
}
