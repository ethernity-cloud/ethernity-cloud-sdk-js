// The node flags the securelock is built and run with.
//
// --jitless is derived from the securelock's protected heap (SCONE_HEAP). V8
// reserves a 512 MB code range for its JIT at start, which fits a 1024M heap
// and not a smaller one; a smaller heap runs node --jitless, which reserves
// no code range and runs JavaScript interpreted. ECLD_NODE_JITLESS=1 or 0
// overrides the derivation.
//
// Every securelock runs with FIXED_NODE_FLAGS after it:
//   --disable-sigusr1     node installs no SIGUSR1 handler, so a signal of
//                         the host starts no inspector;
//   --openssl-config=...  the OpenSSL configuration is the empty file the
//                         image holds at that path
//                         (build/securelock/scripts/binary-fs-build.sh).
// The flags are the image's ENTRYPOINT, the fixed start's vector
// (build/securelock/fixed-start/securelock.h) and the CAS session's command.
const MEBIBYTE = 1024 * 1024;
const JIT_HEAP_BYTES = 1024 * MEBIBYTE;
const OPENSSL_CONFIG = '/etny-securelock/fixed-start/openssl.cnf';
const FIXED_NODE_FLAGS = Object.freeze(['--disable-sigusr1', `--openssl-config=${OPENSSL_CONFIG}`]);

// Bytes of a SCONE_HEAP value: a whole number with an optional K, M or G.
const heapBytes = (heap) => {
    const m = /^(\d+)([KMG])?$/i.exec(String(heap).trim());
    if (!m) throw new Error(`heap ${JSON.stringify(heap)}: expected <n>, <n>K, <n>M or <n>G`);
    const unit = { K: 1024, M: MEBIBYTE, G: 1024 * MEBIBYTE }[(m[2] || '').toUpperCase()] || 1;
    return Number(m[1]) * unit;
};

const securelockNodeFlags = (heap, override = process.env.ECLD_NODE_JITLESS) => {
    const jitless = override === undefined || String(override).trim() === ''
        ? heapBytes(heap) < JIT_HEAP_BYTES
        : /^(1|true|yes)$/i.test(String(override).trim());
    return [...(jitless ? ['--jitless'] : []), ...FIXED_NODE_FLAGS];
};

module.exports = { securelockNodeFlags, heapBytes, JIT_HEAP_BYTES, FIXED_NODE_FLAGS, OPENSSL_CONFIG };
