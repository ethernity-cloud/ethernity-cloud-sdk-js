// The publish's own Kubo: when a publish runs one, how it is registered on
// chain, how one a previous publish left serving its registered image is taken
// over (started again when stopped) and serves from the takeover on, when the
// release at the publish's end removes it and when it keeps it, that a swarm
// port another container holds is left unpublished, and that an interrupted
// publish exits through its 'exit' listeners, which release it. No docker and
// no network: the Kubo's API, the docker client and the swarm-port check are
// replaced; the interruption is delivered to a child node process of the
// test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LocalKubo, ownEndpoint, dappEndpoint, apiPortIn, freePort } = require('../localKubo.js');

const PEER = '12D3KooWB8qpxeHqcdb6xTNu3FXjrWE4zTFPverw8XMpms2Qm4pJ';
const KUBO_IMAGE = process.env.ECLD_KUBO_IMAGE || 'ipfs/kubo:release';
const SWARM_PORT = Number(process.env.ECLD_KUBO_SWARM_PORT || 4001);
const ROOT = path.join(__dirname, '..');
const LOCAL_KUBO = path.join(ROOT, 'localKubo.js');
const PORT_ALLOCATED = `Bind for 0.0.0.0:${SWARM_PORT} failed: port is already allocated`;

function kubo(addresses) {
    const k = new LocalKubo('accept m3');
    k.api = async () => ({ ID: PEER, Addresses: addresses });
    k.peers = [];
    return k;
}

// A docker client recording every command, over a container of the project a
// previous publish left (`kept`, the output of `docker port` on it; none when
// not given), running unless `stopped`. As the docker client does, `docker
// port` fails on a stopped container and on none, and `docker start` fails on
// none and starts a stopped one. Each `docker run` is refused with the next of
// `runErrors` on stderr while there is one. The swarm port is `free` (true
// when not given).
function recording(k, { kept = null, stopped = false, runErrors = [], free = true } = {}) {
    const commands = [];
    const refusals = [...runErrors];
    let running = kept !== null && !stopped;
    const failing = (stderr) => Object.assign(new Error('exit 1'), { stderr });
    k.docker = (args) => {
        commands.push(args);
        if (args[0] === 'port') {
            if (!running) throw failing(kept === null ? `Error: No such container: ${k.container}` : "Error: No public port '5001/tcp' published");
            return kept;
        }
        if (args[0] === 'start') {
            if (kept === null) throw failing(`Error response from daemon: No such container: ${k.container}`);
            running = true;
            return '';
        }
        if (args[0] === 'run' && refusals.length) {
            const e = new Error('exit 125');
            e.stderr = refusals.shift();
            throw e;
        }
        return '';
    };
    k.swarmPortFree = async () => free;
    return commands;
}

// `fn` run with Date.now advancing 100s on every call, past any deadline the
// Kubo sets, so a wait on its API ends at the first retry without sleeping.
async function pastTheDeadline(fn) {
    const now = Date.now;
    let t = now();
    Date.now = () => (t += 100000);
    try {
        return await fn();
    } finally {
        Date.now = now;
    }
}

// What `fn` prints through console.log.
function printed(fn) {
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(line);
    try {
        fn();
    } finally {
        console.log = log;
    }
    return lines;
}

// What the asynchronous `fn` prints through console.log.
async function printedBy(fn) {
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(line);
    try {
        await fn();
    } finally {
        console.log = log;
    }
    return lines;
}

const SWARM_PUBLISHED = ['-p', `${SWARM_PORT}:4001`, '-p', `${SWARM_PORT}:4001/udp`];

test('an empty setting and the public API mean a Kubo of the publish\'s own', () => {
    assert.equal(ownEndpoint(''), false);
    assert.equal(ownEndpoint(undefined), false);
    assert.equal(ownEndpoint('https://ipfs.ethernity.cloud'), false);
    assert.equal(ownEndpoint('https://ipfs.ethernity.cloud:443/api/v0'), false);
    assert.equal(ownEndpoint('not a url'), false);
});

test('another endpoint is the application\'s own', () => {
    assert.equal(ownEndpoint('http://172.18.0.30:5001'), true);
    assert.equal(ownEndpoint('https://ipfs.example.org/api/v0'), true);
});

test('a dApp is built with an endpoint of its own, else with none (preStart)', () => {
    assert.equal(dappEndpoint(''), '');
    assert.equal(dappEndpoint(undefined), '');
    assert.equal(dappEndpoint('https://ipfs.ethernity.cloud'), '');
    assert.equal(dappEndpoint('https://ipfs.ethernity.cloud:443/api/v0'), '');
    assert.equal(dappEndpoint('http://127.0.0.1:5001'), 'http://127.0.0.1:5001');
    assert.equal(dappEndpoint('https://ipfs.example.org/api/v0'), 'https://ipfs.example.org/api/v0');
});

test('the container is named after the project', () => {
    assert.equal(kubo([]).container, 'ecld-kubo-accept-m3');
});

test('the first public address is registered', async () => {
    const k = kubo([
        `/ip4/127.0.0.1/tcp/4001/p2p/${PEER}`,
        `/ip4/172.17.0.2/tcp/4001/p2p/${PEER}`,
        `/ip4/80.255.2.15/tcp/4001/p2p/QmRBc1eBt4hpJQUqHqn6eA8ixQPD3LFcUDsn6coKBQtia5/p2p-circuit/p2p/${PEER}`,
        `/ip4/93.255.3.60/tcp/4001/p2p/${PEER}`,
        `/ip4/93.255.3.60/udp/4001/quic-v1/p2p/${PEER}`,
    ]);
    assert.equal(await k.peerMultiaddr(), `/ip4/93.255.3.60/tcp/4001/p2p/${PEER}`);
});

test('behind NAT the bare peer id is registered', async () => {
    const k = kubo([`/ip4/127.0.0.1/tcp/4001/p2p/${PEER}`, `/ip4/192.168.1.20/udp/4001/quic-v1/p2p/${PEER}`]);
    assert.equal(await k.peerMultiaddr(), `/p2p/${PEER}`);
});

test('a free loopback port is one a server can take', async () => {
    const port = await freePort();
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
});

test('the API port of a kept node is read from docker port', () => {
    assert.equal(apiPortIn('127.0.0.1:60823\n'), 60823);
    assert.equal(apiPortIn('127.0.0.1:60823\n[::1]:60823\n'), 60823);
    assert.equal(apiPortIn(''), null);
    assert.equal(apiPortIn("Error: No public port '5001/tcp' published"), null);
});

test('a node of this project a previous publish left running is taken over, not replaced, and serves from the takeover on', async () => {
    const k = kubo([]);
    const commands = recording(k, { kept: '127.0.0.1:60823\n' });
    const lines = await printedBy(() => k.start());
    assert.deepEqual(commands, [['port', k.container, '5001/tcp']]);
    assert.equal(k.apiUrl, 'http://127.0.0.1:60823');
    assert.equal(k.serving, true);
    assert.ok(lines.some((line) => line.includes(`IPFS node of the previous publish kept: ${k.container}`)));
});

test('a node a previous publish left that is stopped is started and taken over', async () => {
    const k = kubo([]);
    const commands = recording(k, { kept: '127.0.0.1:60823\n', stopped: true });
    const lines = await printedBy(() => k.start());
    assert.deepEqual(commands, [['port', k.container, '5001/tcp'], ['start', k.container], ['port', k.container, '5001/tcp']]);
    assert.equal(k.apiUrl, 'http://127.0.0.1:60823');
    assert.equal(k.serving, true);
    assert.ok(lines.some((line) => line.includes(`IPFS node of the previous publish kept: ${k.container}`)));
});

test('a taken-over node is kept on release', async () => {
    const k = kubo([]);
    const commands = recording(k, { kept: '127.0.0.1:60823\n' });
    await printedBy(() => k.start());
    commands.length = 0;
    const lines = printed(() => k.release());
    assert.deepEqual(commands, []);
    assert.ok(lines.some((line) => line.includes('The registered image stays available from this publish\'s IPFS node')));
});

test('with none kept, start removes a container of the name, runs one with its API on a free loopback port and the swarm port, and waits for the API', async () => {
    const k = kubo([]);
    const commands = recording(k);
    await k.start();
    assert.deepEqual(commands[0], ['port', k.container, '5001/tcp']);
    assert.deepEqual(commands[1], ['start', k.container]);
    assert.deepEqual(commands[2], ['rm', '-f', k.container]);
    const run = commands[3];
    assert.deepEqual(run.slice(0, 5), ['run', '-d', '--name', k.container, '-p']);
    assert.match(run[5], /^127\.0\.0\.1:\d+:5001$/);
    assert.equal(k.apiUrl, `http://${run[5].replace(/:5001$/, '')}`);
    assert.deepEqual(run.slice(6, 10), SWARM_PUBLISHED);
    assert.deepEqual(run.slice(-4), [KUBO_IMAGE, 'daemon', '--init', '--migrate=true']);
    assert.equal(commands.length, 4);
    assert.equal(k.serving, false);
});

test('a node started afresh whose API does not come up is removed', async () => {
    const k = kubo([]);
    const commands = recording(k);
    k.api = async () => { throw new Error('connection refused'); };
    await pastTheDeadline(() => assert.rejects(() => k.start(), { message: 'the Kubo API did not come up in 90s' }));
    assert.deepEqual(commands.map((args) => args[0]), ['port', 'start', 'rm', 'run', 'rm']);
});

test('a taken-over node whose API does not come up is left to the release, which keeps it', async () => {
    const k = kubo([]);
    const commands = recording(k, { kept: '127.0.0.1:60823\n' });
    k.api = async () => { throw new Error('connection refused'); };
    await pastTheDeadline(() => printedBy(() => assert.rejects(() => k.start(), { message: 'the Kubo API did not come up in 90s' })));
    assert.deepEqual(commands, [['port', k.container, '5001/tcp']]);
    assert.equal(k.serving, true);
    printed(() => k.release());
    assert.deepEqual(commands, [['port', k.container, '5001/tcp']]);
});

test('a swarm port a process on the host holds is not published', async () => {
    const k = kubo([]);
    const commands = recording(k, { free: false });
    await k.start();
    const run = commands[3];
    assert.equal(run[0], 'run');
    assert.ok(!run.includes(`${SWARM_PORT}:4001`));
    assert.equal(run.length, 10);
});

test('a swarm port another container holds published is left unpublished: the refused container is removed and the run repeated without it', async () => {
    const k = kubo([]);
    const commands = recording(k, { runErrors: [PORT_ALLOCATED] });
    const lines = await printedBy(() => k.start());
    assert.deepEqual(commands.map((args) => args[0]), ['port', 'start', 'rm', 'run', 'rm', 'run']);
    assert.deepEqual(commands[3].slice(6, 10), SWARM_PUBLISHED);
    assert.deepEqual(commands[4], ['rm', '-f', k.container]);
    assert.ok(!commands[5].includes(`${SWARM_PORT}:4001`));
    assert.equal(commands[5][5], commands[3][5], 'the API port is the same');
    assert.equal(commands[5].length, 10);
    assert.ok(lines.includes(`\t⚠  swarm port ${SWARM_PORT} is allocated to another container; the IPFS node is not dialed directly`));
});

test('a run docker refuses for another reason leaves no container', async () => {
    const k = kubo([]);
    const commands = recording(k, { runErrors: ['no such image'] });
    await assert.rejects(() => k.start(), { message: `docker could not start ${KUBO_IMAGE}: no such image` });
    assert.deepEqual(commands.map((args) => args[0]), ['port', 'start', 'rm', 'run', 'rm']);
    assert.deepEqual(commands[4], ['rm', '-f', k.container]);
});

test('an allocated port refused with the swarm port unpublished is a failure', async () => {
    const k = kubo([]);
    const commands = recording(k, { free: false, runErrors: [PORT_ALLOCATED] });
    await assert.rejects(() => k.start(), { message: `docker could not start ${KUBO_IMAGE}: ${PORT_ALLOCATED}` });
    assert.deepEqual(commands.map((args) => args[0]), ['port', 'start', 'rm', 'run', 'rm']);
});

test('stop removes the container', () => {
    const k = kubo([]);
    const commands = recording(k);
    k.stop();
    assert.deepEqual(commands, [['rm', '-f', k.container]]);
});

test('a Kubo serving no registered image is stopped on release', () => {
    const k = kubo([]);
    const commands = recording(k);
    const lines = printed(() => k.release());
    assert.deepEqual(commands, [['rm', '-f', k.container]]);
    assert.deepEqual(lines, []);
});

test('a Kubo serving a registered image is kept on release', () => {
    const k = kubo([]);
    const commands = recording(k);
    k.serving = true;
    const lines = printed(() => k.release());
    assert.deepEqual(commands, []);
    assert.ok(lines.some((line) => line.includes('The registered image stays available from this publish\'s IPFS node')));
    assert.ok(lines.some((line) => line.includes(`docker rm -f ${k.container}`)));
});

for (const runner_ of ['nodenithy', 'pynithy']) {
    test(`${runner_}/run.js releases the Kubo at exit, serving from the image's registration until its certificate is on chain`, () => {
        const src = fs.readFileSync(path.join(ROOT, runner_, 'run.js'), 'utf8');
        assert.match(src, /process\.on\('exit', \(\) => localKubo\.release\(\)\);/);
        assert.doesNotMatch(src, /localKubo\.stop\(/, 'the Kubo is released, never stopped outright');
        const registered = src.indexOf('"v3" "registerImage"');
        const serving = src.indexOf('if (localKubo) localKubo.serving = true;');
        const uploaded = src.indexOf('uploadToIpfs();', registered);
        assert.ok(registered > 0 && serving > registered && serving < uploaded, 'serving from the registration on');
        const certified = src.indexOf('"v3" "setImageCert"');
        const served = src.indexOf('if (localKubo) localKubo.serving = false;');
        assert.ok(certified > 0 && served > certified && served - certified < 300, 'served once the certificate is on chain');
    });
}

// A publish as run.js sets it up, interrupted `how` 50ms in: a signal to the
// process (emitted on it on Windows, where a signal kills a node process
// outright), or 'readline', the Ctrl+C the readline interface reports as its
// own 'SIGINT' event. Its 'exit' listener writes the exit status to `marker`;
// a publish that goes on exits 99.
const INTERRUPTED_PUBLISH = `
const fs = require('fs');
const readline = require('readline');
const { exitOnInterrupt } = require(${JSON.stringify(LOCAL_KUBO)});
const [how, marker] = process.argv.slice(2);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
process.on('exit', (code) => fs.writeFileSync(marker, 'released ' + code));
exitOnInterrupt(rl);
setTimeout(() => process.exit(99), 10000);
setTimeout(() => {
    if (how === 'readline') rl.emit('SIGINT');
    else if (process.platform === 'win32') process.emit(how);
    else process.kill(process.pid, how);
}, 50);
`;

for (const how of ['SIGINT', 'SIGTERM', 'SIGHUP', 'readline']) {
    test(`a publish interrupted by ${how} exits 130 through its 'exit' listeners`, async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-interrupt-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const script = path.join(dir, 'publish.js');
        const marker = path.join(dir, 'released');
        fs.writeFileSync(script, INTERRUPTED_PUBLISH);
        const run = await new Promise((resolve) => execFile(process.execPath, [script, how, marker],
            (error, stdout, stderr) => resolve({ error, stderr })));
        assert.ok(run.error, 'the publish exited non-zero');
        assert.equal(run.error.code, 130, run.stderr);
        assert.equal(run.error.signal, null);
        assert.equal(fs.readFileSync(marker, 'utf8'), 'released 130');
    });
}
