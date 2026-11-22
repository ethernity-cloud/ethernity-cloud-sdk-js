// The pin of ipfs.mjs (nodenithy/ and pynithy/, the copies the two runners
// run): pinOnIPFS asks the API named by initialize() for a recursive pin/add
// with progress=true, without compression and with the Authorization header,
// reads the answer as it arrives and is true at the line whose Pins name the
// CID. An attempt that reads no such line (the answer ends, breaks off, stays
// silent for the silence bound, or is an error) is followed by pin/ls under
// the same header, and by another pin/add when the API does not list the pin,
// at most PIN_ATTEMPTS times and never after the pin's time; a 401 or 403
// ends the pin at once. `node ipfs.mjs --action pin` runs it with IPFS_TOKEN
// as the header and reports it by exit code. No Kubo: an HTTP server on
// 127.0.0.1 answers in its place.
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
const { pathToFileURL } = require('node:url');

const { pinOnPublicApi } = require('../localKubo.js');

const CID = 'QmbohHhXrfkpnzg7uGQ1LHRA1jXD6K12PWTkpiRGXUmPa1';
const OTHER_CID = 'QmWVrXJYqXbgWNmtZAPqjnXai1NASKQumgwB3XytD3JEvf';
const TOKEN = 'writer-token-5c1e9a';
const COPIES = ['nodenithy', 'pynithy'];
const ipfsMjs = (copy) => path.join(__dirname, '..', copy, 'ipfs.mjs');

const PIN_ADD_PATH = `/api/v0/pin/add?arg=${CID}&recursive=true&progress=true`;
const PIN_LS_PATH = `/api/v0/pin/ls?arg=${CID}&type=recursive`;
// Progress lines as Kubo 0.4.23 writes them (a null Pins) and as later
// versions do (empty fields left out; Bytes beside Progress), and a blank line.
const PROGRESS = ['{"Pins":null,"Progress":3}', '{}', '', '{"Progress":41,"Bytes":10485760}'];
const PINNED = `{"Pins":["${CID}"]}`;
const LISTED = `{"Keys":{"${CID}":{"Type":"recursive"}}}\n`;
const NOT_PINNED = `{"Message":"path '${CID}' is not pinned","Code":0,"Type":"error"}\n`;
// The silence bound and the wait between attempts the cases give the pin, and
// how long the stand-in API holds a silent answer open at most.
const SILENCE_MS = 400;
const RETRY_MS = 50;
const HOLD_MS = 5000;

// The IPFS API on 127.0.0.1. `answerPin(req, res, n, later)` answers the n-th
// pin/add (from 1), `later(fn, ms)` running fn after ms unless the API has
// stopped; pin/ls answers the n-th pin/ls with LISTED when `listed(n)` is
// true, with NOT_PINNED and a 500 when it is false, and with the status and
// body when it is [status, body]. `seen` records each request: its method,
// path, Authorization and Accept-Encoding headers, the client's port and
// `at`, when it came, read from performance.now().
async function standInApi(t, answerPin, listed = () => false) {
    const seen = [];
    const timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    let pins = 0;
    let lists = 0;
    const server = http.createServer((req, res) => {
        seen.push({
            method: req.method,
            path: req.url,
            authorization: req.headers.authorization,
            encoding: req.headers['accept-encoding'],
            port: req.socket.remotePort,
            at: performance.now(),
        });
        if (req.url.startsWith('/api/v0/pin/ls')) {
            lists += 1;
            const answer = listed(lists);
            const [status, body] = Array.isArray(answer) ? answer : answer ? [200, LISTED] : [500, NOT_PINNED];
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(body);
            return;
        }
        pins += 1;
        answerPin(req, res, pins, later);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        timers.forEach(clearTimeout);
        server.closeAllConnections();
        server.close();
    });
    return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

// Answers of pin/add: `lines`, each with a line feed, `gap` ms apart, and the
// answer's end; nothing at all, the connection held open; `line`, then the
// connection held open without another byte; the connection closed without
// an answer, or after `line`; `status` with `body`.
const streamed = (lines, gap = 20) => (req, res, n, later) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const next = (i) => {
        if (i === lines.length) {
            res.end();
            return;
        }
        res.write(`${lines[i]}\n`);
        later(() => next(i + 1), gap);
    };
    next(0);
};
const silent = (req, res, n, later) => later(() => req.socket.destroy(), HOLD_MS);
const silentAfter = (line) => (req, res, n, later) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(`${line}\n`);
    later(() => req.socket.destroy(), HOLD_MS);
};
const closed = (req) => req.socket.destroy();
const closedAfter = (line) => (req, res, n, later) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(`${line}\n`);
    later(() => req.socket.destroy(), 20);
};
const answered = (status, body) => (req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(body);
};
// The n-th pin/add answered by the n-th of `answers`, the last for every later one.
const inTurn = (...answers) => (req, res, n, later) => answers[Math.min(n, answers.length) - 1](req, res, n, later);

// The module of `copy`'s ipfs.mjs, its API the stand-in at `url` with TOKEN.
async function ipfsOn(copy, url, token = TOKEN) {
    const ipfs = await import(pathToFileURL(ipfsMjs(copy)).href);
    ipfs.initialize(url, undefined, undefined, token);
    return ipfs;
}

// `fn()` awaited with every console line it prints in `lines`; `started`,
// when it was called (performance.now()), and `ms`, how long it took.
async function printed(fn) {
    const lines = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const saved = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...args) => lines.push(args.map(String).join(' '));
    const started = performance.now();
    try {
        const value = await fn();
        return { value, lines, started, ms: performance.now() - started };
    } finally {
        methods.forEach((m, i) => { console[m] = saved[i]; });
    }
}

const paths = (seen) => seen.map((r) => r.path);
const failed = (url, rest) => `\tFailed to pin ${CID} on ${url}${rest}`;
const noToken = (text) => assert.ok(!String(text).includes(TOKEN), `the token is in ${JSON.stringify(text)}`);

for (const copy of COPIES) {
    test(`${copy}/ipfs.mjs: the bounds of a pin are the Python SDK's, the defaults of pinOnIPFS, which --action pin calls with them`, async () => {
        const ipfs = await import(pathToFileURL(ipfsMjs(copy)).href);
        assert.deepEqual(
            [ipfs.PIN_ATTEMPTS, ipfs.PIN_RETRY_MS, ipfs.PIN_REQUEST_MS, ipfs.PIN_SILENCE_MS, ipfs.PIN_TIMEOUT_MS],
            [5, 10000, 30000, 120000, 3600000]);
        assert.match(ipfs.pinOnIPFS.toString(),
            /^async \(cid, \{ timeoutMs = PIN_TIMEOUT_MS, silenceMs = PIN_SILENCE_MS, retryMs = PIN_RETRY_MS \} = \{\}\) =>/);
        const src = fs.readFileSync(ipfsMjs(copy), 'utf8');
        assert.equal(src.split('await pinOnIPFS(').length, 2, 'one call of pinOnIPFS');
        assert.match(src, /const pinned = await pinOnIPFS\(options\.hhash\);/);
        const listed = src.slice(src.indexOf('const pinListed = '), src.indexOf('const pinOnIPFS = '));
        assert.match(listed, /`pin\/ls\?arg=\$\{encodeURIComponent\(cid\)\}&type=recursive`,\s+\{\},\s+Math\.min\(PIN_REQUEST_MS, left\),/,
            'a pin/ls may stay silent for PIN_REQUEST_MS, or the time left');
    });

    test(`${copy}/ipfs.mjs: a pin is a recursive pin/add with progress, the token and no compression, read from progress lines to the pin line`, async (t) => {
        const api = await standInApi(t, streamed([...PROGRESS, PINNED]));
        const ipfs = await ipfsOn(copy, api.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
        assert.equal(run.value, true);
        assert.deepEqual(api.seen.map(({ at, port, ...r }) => r),
            [{ method: 'POST', path: PIN_ADD_PATH, authorization: TOKEN, encoding: 'identity' }]);
        assert.deepEqual(run.lines, []);
    });

    test(`${copy}/ipfs.mjs: the pin line is read as it arrives, split across pieces, in an answer held open after it`, async (t) => {
        const api = await standInApi(t, (req, res, n, later) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"Pins":nu');
            later(() => res.write('ll,"Progress":3}\n{"Pi'), 30);
            later(() => res.write(`ns":["${CID}"]}\n`), 60);
            later(() => req.socket.destroy(), HOLD_MS);
        });
        const ipfs = await ipfsOn(copy, api.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: 3000, retryMs: RETRY_MS }));
        assert.equal(run.value, true);
        assert.deepEqual(paths(api.seen), [PIN_ADD_PATH], 'no pin/ls');
        assert.ok(run.ms < 2000, `the pin line was read ${Math.round(run.ms)} ms after the request`);
        assert.deepEqual(run.lines, []);
    });

    for (const [kind, answer] of [['no byte at all', silent], ['a progress line, then nothing', silentAfter(PROGRESS[0])]]) {
        test(`${copy}/ipfs.mjs: an answer silent for the silence bound (${kind}) is ended and settled by pin/ls with the token: listed, the pin is complete`, async (t) => {
            const api = await standInApi(t, answer, () => true);
            const ipfs = await ipfsOn(copy, api.url);
            const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
            assert.equal(run.value, true);
            assert.deepEqual(api.seen.map((r) => [r.path, r.authorization]), [[PIN_ADD_PATH, TOKEN], [PIN_LS_PATH, TOKEN]]);
            const after = api.seen[1].at - api.seen[0].at;
            assert.ok(after >= SILENCE_MS - 20, `pin/ls ${Math.round(after)} ms after pin/add`);
            assert.ok(run.ms < HOLD_MS, `the pin took ${Math.round(run.ms)} ms`);
            assert.deepEqual(run.lines, []);
        });
    }

    test(`${copy}/ipfs.mjs: a silent answer of a pin pin/ls does not list is asked again, five times, and fails naming the silence`, async (t) => {
        const api = await standInApi(t, silent);
        const ipfs = await ipfsOn(copy, api.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
        assert.equal(run.value, false);
        assert.deepEqual(paths(api.seen), Array(5).fill([PIN_ADD_PATH, PIN_LS_PATH]).flat());
        for (let i = 2; i < api.seen.length; i += 2) {
            assert.ok(api.seen[i].at - api.seen[i - 1].at >= RETRY_MS - 5, `attempt ${i / 2 + 1} waited for the retry`);
        }
        assert.ok(api.seen.every((r) => r.authorization === TOKEN));
        assert.deepEqual(run.lines, [failed(api.url, ` in 5 attempts: no byte of the answer for ${SILENCE_MS} ms`)]);
    });

    for (const [kind, answer] of [['before a byte', closed], ['after a progress line', closedAfter(PROGRESS[0])]]) {
        test(`${copy}/ipfs.mjs: a connection closed without the pin line (${kind}) is settled by pin/ls: listed, the pin is complete`, async (t) => {
            const api = await standInApi(t, answer, () => true);
            const ipfs = await ipfsOn(copy, api.url);
            const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
            assert.equal(run.value, true);
            assert.deepEqual(paths(api.seen), [PIN_ADD_PATH, PIN_LS_PATH]);
            assert.ok(run.ms < SILENCE_MS, `the pin took ${Math.round(run.ms)} ms`);
            assert.deepEqual(run.lines, []);
        });
    }

    test(`${copy}/ipfs.mjs: a connection closed without an answer of a pin pin/ls does not list is asked again, each request on a connection of its own`, async (t) => {
        const api = await standInApi(t, inTurn(closed, streamed([PINNED])));
        const ipfs = await ipfsOn(copy, api.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
        assert.equal(run.value, true);
        assert.deepEqual(paths(api.seen), [PIN_ADD_PATH, PIN_LS_PATH, PIN_ADD_PATH]);
        assert.equal(new Set(api.seen.map((r) => r.port)).size, 3);
        assert.deepEqual(run.lines, ['\tthe pin took 2 attempts']);
    });

    test(`${copy}/ipfs.mjs: a pin/ls answer that does not list the CID among its keys is not the pin`, async (t) => {
        const unlisted = [
            [200, `{"Keys":{"${OTHER_CID}":{"Type":"recursive"}}}\n`],
            [500, LISTED],
            [200, `{"Keys":"x${CID}y"}\n`],
            [200, `{"Keys":["${CID}"]}\n`],
            [200, '{"Keys":7}\n'],
            [503, 'unavailable'],
        ];
        for (const answer of unlisted) {
            const api = await standInApi(t, inTurn(closed, streamed([PINNED])), () => answer);
            const ipfs = await ipfsOn(copy, api.url);
            const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
            assert.equal(run.value, true);
            assert.deepEqual(paths(api.seen), [PIN_ADD_PATH, PIN_LS_PATH, PIN_ADD_PATH], `pin/ls ${JSON.stringify(answer)}`);
            assert.deepEqual(run.lines, ['\tthe pin took 2 attempts']);
        }
    });

    test(`${copy}/ipfs.mjs: an answer still arriving when the pin's time runs out is left at its next piece`, async (t) => {
        // A progress line every 50 ms, until the stand-in closes the
        // connection after HOLD_MS.
        const api = await standInApi(t, (req, res, n, later) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const tick = () => {
                if (req.socket.destroyed) return;
                res.write(`${PROGRESS[0]}\n`);
                later(tick, 50);
            };
            tick();
            later(() => req.socket.destroy(), HOLD_MS);
        }, () => true);
        const ipfs = await ipfsOn(copy, api.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { timeoutMs: 500, silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
        assert.equal(run.value, false);
        assert.deepEqual(paths(api.seen), [PIN_ADD_PATH], 'no pin/ls after the time');
        assert.ok(run.ms >= 490 && run.ms < 1000, `the pin took ${Math.round(run.ms)} ms`);
        assert.deepEqual(run.lines, [failed(api.url, ': the pin was not complete when its time ran out')]);
    });

    test(`${copy}/ipfs.mjs: an answer that ends without the pin line is settled by pin/ls`, async (t) => {
        const api = await standInApi(t, streamed(PROGRESS), () => true);
        const ipfs = await ipfsOn(copy, api.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
        assert.equal(run.value, true);
        assert.deepEqual(paths(api.seen), [PIN_ADD_PATH, PIN_LS_PATH]);
        assert.deepEqual(run.lines, []);
    });

    test(`${copy}/ipfs.mjs: answers whose lines do not name the CID among their Pins fail after five attempts`, async (t) => {
        const others = [`{"Pins":[]}`, `{"Pins":["${OTHER_CID}"]}`, `{"Pins":"x${CID}y"}`, `"${CID}"`, `{"Progress":1}`];
        const api = await standInApi(t, inTurn(...others.map((line) => streamed([line]))));
        const ipfs = await ipfsOn(copy, api.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
        assert.equal(run.value, false);
        assert.deepEqual(paths(api.seen), Array(5).fill([PIN_ADD_PATH, PIN_LS_PATH]).flat());
        assert.deepEqual(run.lines, [failed(api.url, ' in 5 attempts: the answer ended without the pin')]);
    });

    test(`${copy}/ipfs.mjs: an error line ends the attempt, and fails naming its message when pin/ls does not list the pin`, async (t) => {
        const message = `pin: failed to fetch ${CID}: context canceled`;
        const api = await standInApi(t, streamed([PROGRESS[0], JSON.stringify({ Message: message, Code: 0, Type: 'error' }), PINNED]));
        const ipfs = await ipfsOn(copy, api.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
        assert.equal(run.value, false);
        assert.deepEqual(paths(api.seen), Array(5).fill([PIN_ADD_PATH, PIN_LS_PATH]).flat());
        assert.deepEqual(run.lines, [failed(api.url, ` in 5 attempts: ${message}`)]);
    });

    for (const status of [401, 403]) {
        test(`${copy}/ipfs.mjs: a ${status} ends the pin at once, naming the status and the first 300 characters of its body`, async (t) => {
            const body = 'writes need a token. '.repeat(20);
            const api = await standInApi(t, answered(status, body), () => true);
            const ipfs = await ipfsOn(copy, api.url);
            const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
            assert.equal(run.value, false);
            assert.deepEqual(paths(api.seen), [PIN_ADD_PATH], 'no pin/ls and no second pin/add');
            assert.deepEqual(run.lines, [failed(api.url, `: status ${status}\n\t${body.slice(0, 300)}`)]);
        });
    }

    test(`${copy}/ipfs.mjs: the body of a refusal is read as far as its first 1200 bytes, in an answer held open after them`, async (t) => {
        const body = 'writes need a token. '.repeat(100);
        const api = await standInApi(t, (req, res, n, later) => {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.write(body);
            later(() => req.socket.destroy(), HOLD_MS);
        }, () => true);
        const ipfs = await ipfsOn(copy, api.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
        assert.equal(run.value, false);
        assert.deepEqual(paths(api.seen), [PIN_ADD_PATH]);
        assert.ok(run.ms < SILENCE_MS, `the pin took ${Math.round(run.ms)} ms`);
        assert.deepEqual(run.lines, [failed(api.url, `: status 403\n\t${body.slice(0, 300)}`)]);
    });

    test(`${copy}/ipfs.mjs: a status that is no refusal is settled by pin/ls and asked again`, async (t) => {
        const unavailable = '<html><body><h1>503 Service Unavailable</h1>\nNo server is available to handle this request.\n</body></html>\n';
        const api = await standInApi(t, inTurn(answered(503, unavailable), streamed([PINNED])));
        const ipfs = await ipfsOn(copy, api.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
        assert.equal(run.value, true);
        assert.deepEqual(paths(api.seen), [PIN_ADD_PATH, PIN_LS_PATH, PIN_ADD_PATH]);
        assert.deepEqual(run.lines, ['\tthe pin took 2 attempts']);
    });

    test(`${copy}/ipfs.mjs: no request starts once the pin's time has passed`, async (t) => {
        const none = await standInApi(t, streamed([PINNED]), () => true);
        const ipfs = await ipfsOn(copy, none.url);
        const run = await printed(() => ipfs.pinOnIPFS(CID, { timeoutMs: 0, silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
        assert.equal(run.value, false);
        assert.deepEqual(none.seen, []);
        assert.deepEqual(run.lines, [failed(none.url, ': the pin was not complete when its time ran out')]);

        // Of 1000 ms, the first silent answer takes 600 and the second the
        // rest, which leaves no time for a third attempt.
        const api = await standInApi(t, silent);
        await ipfsOn(copy, api.url);
        const bounded = await printed(() => ipfs.pinOnIPFS(CID, { timeoutMs: 1000, silenceMs: 600, retryMs: RETRY_MS }));
        assert.equal(bounded.value, false);
        assert.deepEqual(paths(api.seen).slice(0, 3), [PIN_ADD_PATH, PIN_LS_PATH, PIN_ADD_PATH]);
        assert.deepEqual(paths(api.seen).slice(3), paths(api.seen).length > 3 ? [PIN_LS_PATH] : [], 'no third pin/add');
        for (const r of api.seen) {
            assert.ok(r.at - bounded.started < 1000, `a request ${Math.round(r.at - bounded.started)} ms after the pin started`);
        }
        assert.ok(bounded.ms < 1500, `the pin took ${Math.round(bounded.ms)} ms`);
        assert.equal(bounded.lines.length, 1);
        assert.match(bounded.lines[0], new RegExp(`^\\tFailed to pin ${CID} on ${api.url.replace(/\./g, '\\.')} in 2 attempts: no byte of the answer for \\d+ ms$`));
    });

    test(`${copy}/ipfs.mjs: no line a pin prints names the token`, async (t) => {
        const answers = [
            [streamed([...PROGRESS, PINNED]), () => true],
            [silent, () => true],
            [silent, () => false],
            [closed, () => false],
            [streamed([JSON.stringify({ Message: 'context canceled', Type: 'error' })]), () => false],
            [answered(403, 'writes need a token'), () => false],
            [answered(503, 'unavailable'), () => false],
        ];
        for (const [answer, listed] of answers) {
            const api = await standInApi(t, answer, listed);
            const ipfs = await ipfsOn(copy, api.url);
            const run = await printed(() => ipfs.pinOnIPFS(CID, { silenceMs: SILENCE_MS, retryMs: RETRY_MS }));
            assert.ok(api.seen.length > 0 && api.seen.every((r) => r.authorization === TOKEN));
            run.lines.forEach(noToken);
        }
    });

    // The pin runs in a child process while this one serves the requests, so
    // the child is awaited, not joined synchronously.
    const cli = (url, token) => new Promise((resolve) => {
        execFile(process.execPath, [ipfsMjs(copy), '--host', url, '--action', 'pin', '--hhash', CID],
            { encoding: 'utf8', env: { ...process.env, IPFS_TOKEN: token } },
            (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
    });

    test(`${copy}/ipfs.mjs --action pin: a complete pin prints the CID and exits 0, a connection closed and pin/ls listing the pin too, with the token in no output`, async (t) => {
        for (const answer of [streamed([...PROGRESS, PINNED]), closed]) {
            const api = await standInApi(t, answer, () => true);
            const run = await cli(api.url, TOKEN);
            assert.equal(run.status, 0, run.stderr);
            assert.equal(run.stdout.trim(), CID);
            assert.equal(api.seen[0].path, PIN_ADD_PATH);
            assert.ok(api.seen.every((r) => r.authorization === TOKEN));
            noToken(run.stdout + run.stderr);
        }
    });

    test(`${copy}/ipfs.mjs --action pin: a refused pin exits 1 and says the status, with the token in no output`, async (t) => {
        for (const token of ['', TOKEN]) {
            const api = await standInApi(t, answered(403, 'writes need a token'));
            const run = await cli(api.url, token);
            assert.equal(run.status, 1);
            assert.match(run.stdout, /status 403/);
            assert.deepEqual(paths(api.seen), [PIN_ADD_PATH]);
            assert.equal(api.seen[0].authorization, token || undefined);
            noToken(run.stdout + run.stderr);
        }
    });
}

test('nodenithy/ipfs.mjs and pynithy/ipfs.mjs are the same file', () => {
    assert.ok(fs.readFileSync(ipfsMjs('nodenithy')).equals(fs.readFileSync(ipfsMjs('pynithy'))));
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
