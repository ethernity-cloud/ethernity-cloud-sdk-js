// `node ipfs.mjs --action pin`: a recursive pin/add on the API named by --host,
// carrying IPFS_TOKEN as the Authorization header, reported by exit code. No
// Kubo: a local HTTP server answers in its place.
//
// pinOnPublicApi (localKubo.js): one such pin per CID on the public API, in
// order, through the child-process call it is given, here one that records
// its calls. On a V1 registry both runners pin through it the compose and the
// tree before the certificate is extracted, and the tree that carries the
// certificate files before they register it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { pinOnPublicApi } = require('../localKubo.js');

const CID = 'QmbohHhXrfkpnzg7uGQ1LHRA1jXD6K12PWTkpiRGXUmPa1';
const IPFS_MJS = path.join(__dirname, '..', 'pynithy', 'ipfs.mjs');

function serve(status, body, seen) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(body);
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// The pin runs in a child process while this one serves the request, so the
// child is awaited, not joined synchronously.
function pin(port, token) {
    return new Promise((resolve) => {
        execFile(process.execPath, [IPFS_MJS, '--host', `http://127.0.0.1:${port}`, '--action', 'pin', '--hhash', CID],
            { encoding: 'utf8', env: { ...process.env, IPFS_TOKEN: token } },
            (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
    });
}

test('a pin is a recursive pin/add with the token, reported by the CID and exit 0', async () => {
    const seen = [];
    const server = await serve(200, JSON.stringify({ Pins: [CID] }), seen);
    try {
        const run = await pin(server.address().port, 'writer-token');
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.stdout.trim(), CID);
        assert.deepEqual(seen, [{ method: 'POST', url: `/api/v0/pin/add?arg=${CID}&recursive=true`, authorization: 'writer-token' }]);
    } finally {
        server.close();
    }
});

test('a refused pin exits 1 and says the status', async () => {
    const seen = [];
    const server = await serve(403, 'writes need a token', seen);
    try {
        const run = await pin(server.address().port, '');
        assert.equal(run.status, 1);
        assert.match(run.stdout, /status 403/);
        assert.equal(seen[0].authorization, undefined);
    } finally {
        server.close();
    }
});

test('an answer without the CID exits 1', async () => {
    const server = await serve(200, JSON.stringify({ Pins: [] }), []);
    try {
        assert.equal((await pin(server.address().port, 'writer-token')).status, 1);
    } finally {
        server.close();
    }
});

// A child-process call in the place of execFileSync: it records every call
// and throws `failures[cid]` on the pin of that CID.
function recordingRun(failures = {}) {
    const calls = [];
    const run = (file, args, options) => {
        calls.push({ file, args, options });
        const cid = args[args.indexOf('--hhash') + 1];
        if (failures[cid]) throw failures[cid];
    };
    return { calls, run };
}

// What `fn` prints through console.log, into `lines`; what it throws is thrown.
function printing(lines, fn) {
    const log = console.log;
    console.log = (line) => lines.push(line);
    try {
        return fn();
    } finally {
        console.log = log;
    }
}

const pinArgs = (cid) => ['../ipfs.mjs', '--host', 'https://ipfs.ethernity.cloud', '--action', 'pin', '--hhash', cid];

test('pinOnPublicApi pins each CID on the public API, in order, with the token in the child\'s environment alone', () => {
    const { calls, run } = recordingRun();
    const lines = [];
    printing(lines, () => pinOnPublicApi(['QmA', 'QmB'], 'tok', run));
    assert.deepEqual(calls.map((call) => [call.file, call.args]), [
        [process.execPath, pinArgs('QmA')],
        [process.execPath, pinArgs('QmB')],
    ]);
    for (const call of calls) {
        assert.equal(call.options.env.IPFS_TOKEN, 'tok');
        assert.equal(call.options.stdio, 'inherit');
        assert.ok(!call.args.includes('tok'), 'the token is not on the command line');
    }
    assert.deepEqual(lines, ['Pinning QmA on the public IPFS API', 'Pinning QmB on the public IPFS API']);
});

test('pinOnPublicApi throws at the first pin that fails, naming its CID, and pins no later one', () => {
    const exited = Object.assign(new Error('Command failed'), { status: 1 });
    const first = recordingRun({ QmA: exited });
    assert.throws(() => printing([], () => pinOnPublicApi(['QmA', 'QmB'], 'tok', first.run)),
        { message: 'the public IPFS API did not pin QmA (exit 1).' });
    assert.deepEqual(first.calls.map((call) => call.args), [pinArgs('QmA')]);

    const second = recordingRun({ QmB: exited });
    assert.throws(() => printing([], () => pinOnPublicApi(['QmA', 'QmB', 'QmC'], 'tok', second.run)),
        { message: 'the public IPFS API did not pin QmB (exit 1).' });
    assert.deepEqual(second.calls.map((call) => call.args), [pinArgs('QmA'), pinArgs('QmB')]);

    const killed = recordingRun({ QmA: Object.assign(new Error('Command failed'), { status: null, signal: 'SIGTERM' }) });
    assert.throws(() => printing([], () => pinOnPublicApi(['QmA'], 'tok', killed.run)),
        { message: 'the public IPFS API did not pin QmA (SIGTERM).' });
});

test('pinOnPublicApi without a token throws before any pin', () => {
    for (const token of ['', undefined, null]) {
        const { calls, run } = recordingRun();
        const lines = [];
        assert.throws(() => printing(lines, () => pinOnPublicApi(['QmA', 'QmB'], token, run)),
            /Set IPFS_TOKEN to a writer token of ipfs\.ethernity\.cloud and publish again\./);
        assert.deepEqual(calls, []);
        assert.deepEqual(lines, []);
    }
});

for (const runner of ['nodenithy', 'pynithy']) {
    test(`${runner}/run.js pins on the public API through pinOnPublicApi alone: the compose and the tree before the certificate is extracted, and the tree a V1 registry gets before it is registered`, () => {
        const src = fs.readFileSync(path.join(__dirname, '..', runner, 'run.js'), 'utf8');
        assert.doesNotMatch(src, /'--action', 'pin'/, 'no pin call of the runner\'s own');

        const uploaded = src.indexOf('\n    uploadToIpfs();\n');
        const pinned = src.indexOf('pinOnPublicApi([process.env.IPFS_DOCKER_COMPOSE_HASH, process.env.IPFS_HASH], process.env.IPFS_TOKEN);');
        const extracted = src.indexOf('docker-compose run --rm etny-securelock');
        assert.ok(uploaded > 0, 'the compose and the tree are uploaded');
        assert.ok(pinned > uploaded, 'both are pinned after their upload');
        assert.ok(extracted > pinned, 'and before the certificate is extracted');
        assert.match(src.slice(uploaded, pinned), /\} else if \(!registryV2 && localKubo\) \{/);

        const from = src.indexOf('// A V1 registry gets the tree');
        const to = src.indexOf('"registerSecureLockImage"', from);
        assert.ok(from > 0 && to > from, 'the V1 branch registers the image');
        const branch = src.slice(from, to + '"registerSecureLockImage"'.length);
        const again = branch.indexOf("ipfsCli(['--action', 'upload', '--folderPath', registryPath]");
        const read = branch.indexOf('process.env.IPFS_HASH = fs.readFileSync(`./IPFS_HASH.ipfs`');
        const pinnedAgain = branch.indexOf('if (localKubo) pinOnPublicApi([process.env.IPFS_HASH], process.env.IPFS_TOKEN);');
        const left = branch.indexOf('process.chdir(currentDir)');
        const registered = branch.indexOf('"registerSecureLockImage"');
        assert.ok(again > 0, 'the tree with the certificate files is uploaded');
        assert.ok(read > again, 'its CID is read');
        assert.ok(pinnedAgain > read, 'that CID is pinned on the public API');
        assert.ok(left > pinnedAgain, 'from the run directory, which ../ipfs.mjs is a path from');
        assert.ok(registered > left, 'before the registration');
        assert.match(branch.slice(pinnedAgain, left), /\} catch \(e\) \{\s+console\.error\(`Error: \$\{e\.message\}`\);\s+process\.exit\(1\);\s+\}/,
            'a pin that fails ends the publish before the registration');
    });
}
