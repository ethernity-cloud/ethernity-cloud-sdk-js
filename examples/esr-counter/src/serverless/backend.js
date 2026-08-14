/* esr-counter — Enclave State Registry end-to-end example (Nodenithy).
 *
 * Exercises the whole ESR path in a single task:
 *
 *     read state -> mutate -> encrypt -> compute CID in-enclave
 *       -> publish blob + CID -> commit on-chain -> node pins and verifies
 *
 * Every function returns plain data, because ESR state is ENCLAVE-PRIVATE: a
 * client cannot decrypt it. Anything the caller should see has to be returned
 * explicitly — which is the intended pattern: the payload decides what leaves
 * the enclave.
 *
 * Run locally first (free, no chain): `npx ecld-test 'esrSelftest()'` — the
 * local ESR emulator is on by default, so every function here works with zero
 * orders and zero gas, and state persists between runs.
 */

/** The enclave's on-chain identity — the address its commits are filed under. */
function esrAddress() {
  const { StateRegistry } = require('../ecld_state');
  return { wallet: new StateRegistry().enclaveAddress };
}

/**
 * Increment a counter held in encrypted state; return before/after.
 *
 * Running this twice shows the counter advancing and the version incrementing
 * — which is the proof that state actually persisted and was read back
 * correctly, not just that a call returned.
 */
async function esrIncrement(key = 'e2e-counter') {
  const { StateRegistry } = require('../ecld_state');
  const state = new StateRegistry();
  const before = await state.get(key);
  const after = await state.commit(key, (s) => ({ ...s, n: (s.n || 0) + 1 }));
  return {
    wallet: state.enclaveAddress,
    key,
    before,
    after,
    version: await state.getVersion(key),
  };
}

/**
 * Exactly-once increment: the same nonce can never apply twice.
 *
 * Call it twice with the same nonce — the second run fails with task code 36
 * (ESR_NONCE_VIOLATION) and the state is untouched: "already applied", not a
 * failure. Pick the next nonce with `esrNonce(key) + 1` (esrNonce is in the
 * payload scope), or use any strictly-increasing number (e.g. a timestamp).
 */
async function esrIncrementOnce(nonce, key = 'e2e-counter') {
  const { StateRegistry } = require('../ecld_state');
  const state = new StateRegistry();
  const after = await state.commit(key, (s) => ({ ...s, n: (s.n || 0) + 1 }), { nonce });
  return { after, nonceUsed: nonce, nonceNow: await state.getNonce(key) };
}

/** Read state without writing. Returns {} when nothing was ever committed. */
async function esrRead(key = 'e2e-counter') {
  const { StateRegistry } = require('../ecld_state');
  const state = new StateRegistry();
  return {
    key,
    state: await state.get(key),
    version: await state.getVersion(key),
  };
}

/**
 * Check the pieces that need no gas, so failures are easy to localise.
 *
 * Verifies the module is wired, the wallet derives, and the in-enclave CID
 * computation matches a known IPFS vector. A failure here means the enclave
 * build is wrong; a failure only in esrIncrement means the chain or the
 * operator's relay side is.
 */
async function esrSelftest() {
  const ecldState = require('../ecld_state');
  const results = {};

  try {
    results.wallet = new ecldState.StateRegistry().enclaveAddress;
  } catch (e) {
    results.wallet_error = String(e.message || e);
  }

  // Known vector: must equal what `ipfs add --cid-version=1 --raw-leaves`
  // returns for the same bytes.
  results.cid_known_vector_ok =
    ecldState.cidv1Raw(Buffer.from('hello-esr\n')) ===
    'bafkreiadxa2sf2hlf3r4qchmh4g5vtpcx6i7smlh4po4yplefbpbcyf23m';

  try {
    results.nonce_readable = typeof (await new ecldState.StateRegistry().getNonce('e2e-counter')) === 'number';
  } catch (e) {
    results.nonce_error = String(e.message || e);
  }

  return results;
}

module.exports = { esrAddress, esrIncrement, esrIncrementOnce, esrRead, esrSelftest };
