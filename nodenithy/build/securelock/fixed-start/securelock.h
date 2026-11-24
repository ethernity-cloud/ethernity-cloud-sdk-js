/*
 * The securelock's fixed start (fixed_start.c, included with -include into
 * the extension Dockerfile.tmpl links).
 *
 * The link line defines FIXED_START_SESSION, a string literal: the name of
 * the securelock's CAS session, the one securelock.js reads its key and
 * certificate under, and FIXED_START_JITLESS: 1 when the build runs the
 * securelock with node --jitless (nodeFlags.js), else 0.
 *
 * The argument vector is the image's ENTRYPOINT: node, --jitless when the
 * build runs the securelock with that flag,
 *   --disable-sigusr1     no SIGUSR1 handler: a signal of the host starts no
 *                         inspector;
 *   --openssl-config=...  the OpenSSL configuration is the empty file the
 *                         image holds at that path
 *                         (scripts/binary-fs-build.sh), not the one of
 *                         OpenSSL's compiled directory, which the image does
 *                         not hold,
 * and securelock.js.
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
 *
 * The working directory is /, the pwd of the CAS session
 * (run/etny-securelock-test.yaml.tpl).
 *
 * The entries of the enclave's file system that are not the image's:
 *   /dev, /proc           the runtime's device and process directories, not
 *                         read;
 *   /etc                  holds hosts and resolv.conf, the host's
 *                         name-resolution files the binary-fs passes through
 *                         (--host-path), and nothing else;
 *   /app, /private        hold the session's directory and nothing else,
 *                         which holds the files the CAS session places: the
 *                         certificate authority's certificate, the
 *                         certificate and the key.
 */
#if !defined(FIXED_START_SESSION)
#error "the build defines FIXED_START_SESSION: the name of the securelock's CAS session, a string literal"
#endif
_Static_assert(sizeof FIXED_START_SESSION > 1, "FIXED_START_SESSION is not empty");
#if !defined(FIXED_START_JITLESS)
#error "the build defines FIXED_START_JITLESS: 1 for node --jitless, 0 for node with its JIT"
#endif

#if FIXED_START_JITLESS
#define FIXED_START_ARGS "/usr/local/bin/node" "\0" "--jitless" "\0" "--disable-sigusr1" "\0" "--openssl-config=/etny-securelock/fixed-start/openssl.cnf" "\0" "/etny-securelock/securelock.js"
#else
#define FIXED_START_ARGS "/usr/local/bin/node" "\0" "--disable-sigusr1" "\0" "--openssl-config=/etny-securelock/fixed-start/openssl.cnf" "\0" "/etny-securelock/securelock.js"
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
#define FIXED_START_PWD "/"
#define FIXED_START_EXCEPT \
    { 'S', "/dev", NULL }, \
    { 'S', "/proc", NULL }, \
    { 'N', "/etc", "hosts\0" "resolv.conf\0" }, \
    { 'N', "/app", FIXED_START_SESSION "\0" }, \
    { 'N', "/app/" FIXED_START_SESSION, "ca.pem\0" "cert.pem\0" }, \
    { 'N', "/private", FIXED_START_SESSION "\0" }, \
    { 'N', "/private/" FIXED_START_SESSION, "key.pem\0" },
