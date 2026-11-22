// The directory add of ipfs.mjs (nodenithy/ and pynithy/, the copies the two
// runners run): upload and hashForIPFS post the directory to /api/v0/add with
// wrap-with-directory=true and the IPFS API's own timeout of 60m, as
// IPFSClient.upload_dir of the Python SDK does, and take the tree's CID from
// the answer's entry whose Name is empty. A 200 without such an entry is a
// failed add: it is reported with the length of the answer and asked again,
// and no CID of a file in it is taken for the tree's. No Kubo: an HTTP server
// on 127.0.0.1 answers in its place.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const COPIES = ['nodenithy', 'pynithy'];
const ipfsMjs = (copy) => path.join(__dirname, '..', copy, 'ipfs.mjs');

const ROOT = 'QmQcVkDbijRAT3uTTaKy2b6QNKE3JSQmLhjdaeUgk1ay4Y';
const LAYER = 'Qmd2idmoE5WcbpV1aLsnUChZWxjKpDDKK9uaq1n7phBgRW';
const COMPOSE = 'QmUMaJKoQgjCNc6Lmok3jcNE4DyQJC9F4NNgmnN2wDXvXy';
// Entries of an add answer: the files of the directory, and the wrapping
// directory, whose Name is empty.
const fileEntry = (name, hash, size) => JSON.stringify({ Name: name, Hash: hash, Size: String(size) });
const rootEntry = (hash) => JSON.stringify({ Name: '', Hash: hash, Size: '4096' });
// An add the API ended before it wrote the wrapping directory: 200, the
// entries of the files added until then.
const CUT = [fileEntry('etny-securelock/blobs/sha256/1f0c', LAYER, 3240000), ''].join('\n');
// A whole add, the wrapping directory's entry followed by a file's.
const WHOLE = [fileEntry('docker-compose.yml', COMPOSE, 812), rootEntry(ROOT), fileEntry('etny-securelock/blobs/sha256/1f0c', LAYER, 3240000), ''].join('\n');

// The add API on 127.0.0.1: the n-th add (from 1) is answered 200 with the
// n-th of `answers`, the last for every later one, once its body is read;
// `seen` records each request's method and path.
async function standInAdd(t, answers) {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ method: req.method, path: req.url });
        req.on('data', () => {});
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(answers[Math.min(seen.length, answers.length) - 1]);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

// A directory of two files, removed after the test.
function treeDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-upload-'));
    fs.mkdirSync(path.join(dir, 'etny-securelock'));
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
    fs.writeFileSync(path.join(dir, 'etny-securelock', 'index.json'), '{}\n');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// `fn()` awaited with every console line it prints in `lines`.
async function printed(fn) {
    const lines = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const saved = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...args) => lines.push(args.map(String).join(' '));
    try {
        return { value: await fn(), lines };
    } finally {
        methods.forEach((m, i) => { console[m] = saved[i]; });
    }
}

const query = (p) => new URL(p, 'http://127.0.0.1').searchParams;

for (const copy of COPIES) {
    test(`${copy}/ipfs.mjs: the tree's CID is the Hash of the entry whose Name is empty, from an add with wrap-with-directory and a 60m timeout`, async (t) => {
        const api = await standInAdd(t, [WHOLE]);
        const ipfs = await import(pathToFileURL(ipfsMjs(copy)).href);
        ipfs.initialize(api.url, undefined, undefined, '');
        const { value, lines } = await printed(() => ipfs.hashForIPFS(treeDir(t)));
        assert.equal(value, ROOT);
        assert.equal(api.seen.length, 1);
        assert.equal(api.seen[0].method, 'POST');
        const q = query(api.seen[0].path);
        assert.equal(new URL(api.seen[0].path, 'http://127.0.0.1').pathname, '/api/v0/add');
        assert.equal(q.get('wrap-with-directory'), 'true');
        assert.equal(q.get('timeout'), '60m');
        assert.equal(q.get('only-hash'), 'true');
        assert.deepEqual(lines.filter((l) => l.includes('Failed')), []);
    });

    test(`${copy}/ipfs.mjs: an add answered 200 without the wrapping directory's entry is reported and asked again; no file's CID is taken for the tree's`, async (t) => {
        const api = await standInAdd(t, [CUT, WHOLE]);
        const ipfs = await import(pathToFileURL(ipfsMjs(copy)).href);
        ipfs.initialize(api.url, undefined, undefined, '');
        const dir = treeDir(t);
        const cwd = process.cwd();
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-upload-cwd-'));
        t.after(() => fs.rmSync(work, { recursive: true, force: true }));
        process.chdir(work);
        let result;
        try {
            result = await printed(() => ipfs.upload(dir));
        } finally {
            process.chdir(cwd);
        }
        assert.equal(result.value, ROOT);
        assert.equal(api.seen.length, 2);
        for (const r of api.seen) {
            const q = query(r.path);
            assert.equal(q.get('timeout'), '60m');
            assert.equal(q.get('only-hash'), null);
        }
        assert.deepEqual(result.lines.filter((l) => l.startsWith('Failed')),
            [`Failed to upload to IPFS: the IPFS API returned no root hash (${CUT.length} bytes of response)`]);
        assert.equal(fs.readFileSync(path.join(work, 'IPFS_HASH.ipfs'), 'utf8'), ROOT);
        assert.ok(!result.lines.some((l) => l.includes(LAYER)), 'a line names the file CID of the cut answer');
    });
}
