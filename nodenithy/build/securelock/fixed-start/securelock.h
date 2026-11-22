/*
 * The securelock's fixed start (fixed_start.c, included with -include into
 * the extension Dockerfile.tmpl links).
 *
 * The argument vector is the image's ENTRYPOINT: node, with --jitless when
 * the build runs the securelock with that flag (nodeFlags.js; the build then
 * defines FIXED_START_JITLESS as 1, else as 0), and securelock.js.
 *
 * The keys passed through are the ones securelock.js and its modules read from
 * their environment:
 *   ETNY_MODE, ETNY_ORDER_ID, ETNY_CLIENT_CHALLENGE
 *                         the per-task values: the mode (PUBLIC_KEY or a
 *                         task), the order and the client's challenge.
 *                         readEnv() takes each from the bucket .env when the
 *                         environment does not set it.
 *   ECAS_ATTEST_SESSION, ECAS_ENCLAVE_NONCE
 *                         the session and the nonce the CAS injects and
 *                         re-attests.
 *   ECAS_CAS_QUOTE        the CAS's quote, checked against the baked
 *                         ValidatorRegistry.
 *   ESR_CONTRACT_ADDRESS  the ESR registry the CAS session's environment
 *                         names; the securelock runs no ESR without it.
 * esr_wallet.js also reads ESR_IDENTITY_SECRET, which is not passed: no build
 * or session sets it, and it decides only whether the warning that the ESR
 * identity is reproducible is logged.
 */
#if !defined(FIXED_START_JITLESS)
#error "the build defines FIXED_START_JITLESS: 1 for node --jitless, 0 for node with its JIT"
#endif

#if FIXED_START_JITLESS
#define FIXED_START_ARGS "/usr/local/bin/node" "\0" "--jitless" "\0" "/etny-securelock/securelock.js"
#else
#define FIXED_START_ARGS "/usr/local/bin/node" "\0" "/etny-securelock/securelock.js"
#endif
#define FIXED_START_ENV
#define FIXED_START_ALLOWED \
    "ETNY_MODE", \
    "ETNY_ORDER_ID", \
    "ETNY_CLIENT_CHALLENGE", \
    "ECAS_ATTEST_SESSION", \
    "ECAS_ENCLAVE_NONCE", \
    "ECAS_CAS_QUOTE", \
    "ESR_CONTRACT_ADDRESS",
