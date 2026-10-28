// The node flags the securelock is built and run with, derived from its
// protected heap (SCONE_HEAP). V8 reserves a 512 MB code range for its JIT at
// start, which fits a 1024M heap and not a smaller one; a smaller heap runs
// node --jitless, which reserves no code range and runs JavaScript
// interpreted. ECLD_NODE_JITLESS=1 or 0 overrides the derivation.
const MEBIBYTE = 1024 * 1024;
const JIT_HEAP_BYTES = 1024 * MEBIBYTE;

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
    return jitless ? ['--jitless'] : [];
};

module.exports = { securelockNodeFlags, heapBytes, JIT_HEAP_BYTES };
