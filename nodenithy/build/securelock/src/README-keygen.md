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

- `etny-nodenithy` → `v3/build/{securelock,trustedzone,validator}/src/`
  (`get_sgx_report.c` + `sgx_report_napi.c`)

## How the `.node` is produced

`sgx_report.node` is a **build artifact of the etny-nodenithy pipeline** — its
Dockerfile compiles `sgx_report_napi.c` (which `#include`s `get_sgx_report.c`)
into the addon with a single gcc command against node's `node_api.h`. To refresh
the copy the SDK ships, take the `sgx_report.node` that pipeline produces and
commit it here as `securelock/src/sgx_report.node`.

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
