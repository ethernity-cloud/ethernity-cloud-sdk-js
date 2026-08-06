// Loader for the SGX EREPORT N-API addon (sgx_report.node), which exposes the
// enclave's own MR_ENCLAVE / MR_SIGNER (used to deterministically derive the
// testnet self-signed cert). The addon is compiled from sgx_report_napi.c +
// get_sgx_report.c at build time and baked into binary-fs (see the Dockerfile).
const path = require('path');

let addon = null;
function load() {
  if (addon) return addon;
  // The addon sits next to the enclave sources in the image; try a couple of
  // resolutions so it works in the enclave (/etny-securelock) and in local test.
  const candidates = [
    path.join(__dirname, 'sgx_report.node'),
    '/etny-trustedzone/sgx_report.node',
    './sgx_report.node',
  ];
  let lastErr;
  for (const p of candidates) {
    try {
      addon = require(p);
      return addon;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('Failed to load sgx_report.node addon: ' + (lastErr && lastErr.message));
}

function getMrEnclave() {
  const v = load().getMrEnclave();
  if (!v) throw new Error('get_mr_enclave() returned null (EREPORT failed)');
  return v;
}

function getMrSigner() {
  const v = load().getMrSigner();
  if (!v) throw new Error('get_mr_signer() returned null (EREPORT failed)');
  return v;
}

// Consolidated identity-key derivation, performed inside the compiled addon
// (get_sgx_report.c). role: 0=securelock, 1=trustedzone, 2=validator.
// Returns the 96-hex secp384r1 scalar. The algorithm is NOT in self_sign.js.
function deriveIdentityScalar(role) {
  const v = load().deriveIdentityScalar(role | 0);
  if (!v) throw new Error('deriveIdentityScalar() returned null');
  return v;
}

module.exports = { getMrEnclave, getMrSigner, deriveIdentityScalar };
