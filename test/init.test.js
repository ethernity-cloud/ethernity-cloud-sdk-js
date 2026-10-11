// ecld-init's IPFS setting: the default choice leaves IPFS_ENDPOINT empty (the
// publish runs its own Kubo, the dApp uses the bootnode's payload intake); an
// API of the dApp's own is written with its token. No prompt and no chain:
// the choice is given.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { IPFS_OPTIONS, ipfsSettings, writeEnv } = require('../init.js');

test('the default choice writes an empty IPFS_ENDPOINT and IPFS_TOKEN', () => {
    assert.deepEqual(ipfsSettings(IPFS_OPTIONS[0], undefined, undefined), { IPFS_ENDPOINT: '', IPFS_TOKEN: '' });
});

test('an API of the dApp\'s own is written with its Authorization token', () => {
    assert.deepEqual(ipfsSettings(IPFS_OPTIONS[1], ' http://127.0.0.1:5001 ', ' Bearer t '),
        { IPFS_ENDPOINT: 'http://127.0.0.1:5001', IPFS_TOKEN: 'Bearer t' });
    assert.deepEqual(ipfsSettings(IPFS_OPTIONS[1], 'http://127.0.0.1:5001', ''),
        { IPFS_ENDPOINT: 'http://127.0.0.1:5001', IPFS_TOKEN: '' });
});

test('.env takes the empty setting in place of the public URL an earlier init wrote', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-init-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
        fs.writeFileSync('.env', 'PROJECT_NAME=demo\nIPFS_ENDPOINT=https://ipfs.ethernity.cloud\nIPFS_TOKEN=\n');
        const ipfs = ipfsSettings(IPFS_OPTIONS[0]);
        writeEnv('IPFS_ENDPOINT', ipfs.IPFS_ENDPOINT);
        writeEnv('IPFS_TOKEN', ipfs.IPFS_TOKEN);
        assert.equal(fs.readFileSync('.env', 'utf8'), 'PROJECT_NAME=demo\nIPFS_ENDPOINT=\nIPFS_TOKEN=\n');
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
