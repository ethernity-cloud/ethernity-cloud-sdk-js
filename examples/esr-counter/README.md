# esr-counter — Enclave State Registry end-to-end example (Nodenithy)

A minimal dApp that exercises the whole ESR path: encrypted state written by the
enclave, relayed and paid for by the node, pointed to on-chain, and read back on
the next run. The JavaScript twin of the Python SDK's `examples/esr-counter`.

Use it to verify an ESR deployment, or as the smallest working reference for
using `StateRegistry` in your own backend.

## What it does

```javascript
const { StateRegistry } = require('../ecld_state');

const state = new StateRegistry();
await state.commit('e2e-counter', (s) => ({ ...s, n: (s.n || 0) + 1 }));
```

Run `esrIncrement` twice: the counter advances and the on-chain version
increments. That is the proof state actually persisted and was read back — not
just that a call returned.

## Functions

| Function | Touches chain | Purpose |
|---|---|---|
| `esrSelftest()` | no | Wallet derives, CID matches a known IPFS vector, nonce readable |
| `esrAddress()` | no | The enclave's address — the namespace commits are filed under |
| `esrRead(key)` | no | Read state without writing |
| `esrIncrement(key)` | **yes** | Read-modify-write, commits on-chain |
| `esrIncrementOnce(nonce, key)` | **yes** | Exactly-once commit — a reused nonce returns task code 36 (`ESR_NONCE_VIOLATION`) and leaves state untouched |

Start with `esrSelftest`. It touches no chain, so if it fails the problem is the
enclave build; if only `esrIncrement` fails, the problem is the chain or the
operator.

## Try it locally first — free

`ecld-test` emulates ESR by default (no chain, no gas; state persists between
runs in `.ecld-esr-local.*.json`):

```sh
npx ecld-test 'esrSelftest()'
npx ecld-test 'esrIncrement()'        # run twice: n advances, version advances
npx ecld-test 'esrIncrementOnce(1)'   # run twice: second returns task code 36
```

## Running it on the network

```sh
cp .env.example .env    # add your PRIVATE_KEY for publish
npx ecld-build          # bakes the ESR registry address in; fails if the network has none
npx ecld-publish
npx ecld-run 'esrIncrement()'
```

**Nothing to fund**: the node that runs your task relays each commit and pays
the gas, so a published dApp is autonomous. `ECLD_ESR_ENABLE=true` is all the
configuration ESR needs — `ecld-build` resolves the canonical per-network
registry address itself.

Confirm a commit landed (free, read-only):

```sh
npx ecld-info esr state --enclave <wallet-from-esrAddress> --key e2e-counter
```

## State is enclave-private

Every function returns plain data because the client **cannot decrypt** the
state: it is encrypted with a key derived from the enclave identity. Anything
the caller should see must be returned explicitly — the payload decides what
leaves the enclave.

A client can still observe *metadata* (version, cid) for free via the runner:
`runner.esrVersion(...)`, and wait for a commit to land with
`runner.esrWaitForVersion(...)`.

## Caveat on testnet

The testnet enclave identity is reproducible by anyone who runs the published
image — there is no attestation. Treat testnet state as functional testing
only, and do not store real user data in it.
