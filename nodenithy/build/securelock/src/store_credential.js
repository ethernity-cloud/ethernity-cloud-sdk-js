const fs = require('fs');

// The file the node agent mounts read-only into the enclave's container.
const STORE_CREDENTIAL_PATH = '/run/ecld/store.json';
// A file of more bytes than this is not a credential.
const MAX_BYTES = 4096;
// The whole file: one JSON object of the members accessKey and secretKey, in
// that order, each a string of ASCII letters and digits, with JSON white
// space between the tokens.
const CREDENTIAL = /^[ \t\r\n]*\{[ \t\r\n]*"accessKey"[ \t\r\n]*:[ \t\r\n]*"([A-Za-z0-9]{3,20})"[ \t\r\n]*,[ \t\r\n]*"secretKey"[ \t\r\n]*:[ \t\r\n]*"([A-Za-z0-9]{8,40})"[ \t\r\n]*\}[ \t\r\n]*$/;
// Access key and secret key of a store whose agent mounts no file.
const LITERAL = 'swiftstreamadmin';

// The first MAX_BYTES + 1 bytes of the file at `path`, or all of a shorter one.
function readHead(path) {
    const fd = fs.openSync(path, 'r');
    try {
        const head = Buffer.alloc(MAX_BYTES + 1);
        let held = 0;
        while (held < head.length) {
            const read = fs.readSync(fd, head, held, head.length - held, null);
            if (read === 0) break;
            held += read;
        }
        return head.subarray(0, held);
    } finally {
        fs.closeSync(fd);
    }
}

// { accessKey, secretKey } of the file at `path`, or { reason }: why it gives
// no credential.
function fromFile(path) {
    let head;
    try {
        head = readHead(path);
    } catch (e) {
        const code = e && e.code;
        return { reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable' };
    }
    if (head.length > MAX_BYTES) return { reason: 'too large' };
    const found = CREDENTIAL.exec(head.toString('latin1'));
    if (found === null) return { reason: 'malformed' };
    return { accessKey: found[1], secretKey: found[2] };
}

// The store credential of this enclave: the file's at `path`, else the
// literal pair. Logs one line, which names the path and never a key.
function loadStoreCredential({ path = STORE_CREDENTIAL_PATH, log = console.log } = {}) {
    const read = fromFile(path);
    if (read.reason === undefined) {
        log(`store credential: file (${path})`);
        return { accessKey: read.accessKey, secretKey: read.secretKey, source: 'file' };
    }
    log(`store credential: literal (${path}: ${read.reason})`);
    return { accessKey: LITERAL, secretKey: LITERAL, source: 'literal' };
}

module.exports = { loadStoreCredential, STORE_CREDENTIAL_PATH };
