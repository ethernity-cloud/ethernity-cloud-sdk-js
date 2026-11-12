# SGX key-gen module (`sgx_report.node`)

The JS SDK ships this module **only as a prebuilt N-API addon**
(`sgx_report.node`) — never the C source (`get_sgx_report.c`,
`sgx_report_napi.c`). The identity-key derivation (SGX EREPORT + obfuscated
MR_SIGNER + HKDF-SHA512 domain-separated derivation) lives entirely in the
compiled binary, so a developer inspecting the package or build tree never sees
the algorithm. `get_sgx_report.c` and `sgx_report_napi.c` are gitignored here
so they can never be committed.

## Where the source lives

The source of truth is the runtime repo, not this package:

- `etny-nodenithy` → `v3/build/trustedzone/src/`
  (`get_sgx_report.c` + `sgx_report_napi.c`); the securelock itself lives in
  this package (`nodenithy/build/securelock`), not in etny-nodenithy.

## How the `.node` is produced

`sgx_report.node` is a **build artifact of the etny-nodenithy pipeline** — its
trustedzone Dockerfile compiles `sgx_report_napi.c` (which `#include`s
`get_sgx_report.c`) into the addon with a single gcc command against node's
`node_api.h`, and `.gitlab/build.sh` copies it out of the `release` build
stage into the job's `keygen-artifacts/sgx_report.node`. To refresh the copy
the SDK ships, take that artifact and commit it here as
`securelock/src/sgx_report.node`.

The Pynithy securelock's key-gen module (`get_sgx_report.so`) is documented in
`pynithy/build/securelock/scripts/README-keygen.md`, which, like the whole
`pynithy/build/securelock` tree, is the Python SDK's copy synced by
`scripts/sync-pynithy.mjs` and never edited in this package.

The JS wrappers `sgx_report.js` (loader) and `self_sign.js` (calls
`deriveIdentityScalar`) ship as source — they contain no algorithm, only calls
into the addon.

## Why not compile it in the SDK build

The securelock Dockerfile bakes `src/` into binary-fs but does **not** compile
the addon, so the SDK must carry the prebuilt `.node`. `build.mjs` fails fast if
`src/sgx_report.node` is missing.

## Honest scope

This hides the SOURCE, not the algorithm: the `.node` still contains the
executable logic and the enclave image is public. On testnet (no attestation)
the derived key is reproducible by anyone who runs the image. Key exclusivity
comes from attestation, not from shipping only the binary.
