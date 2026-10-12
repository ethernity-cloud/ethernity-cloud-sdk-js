// `node ipfs.mjs --action pin`: a recursive pin/add on the API named by --host,
// carrying IPFS_TOKEN as the Authorization header, reported by exit code. No
// Kubo: a local HTTP server answers in its place.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

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
