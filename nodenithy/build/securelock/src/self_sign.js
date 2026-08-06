// Testnet non-CAS self-sign: derive a DETERMINISTIC secp384r1 key + self-signed
// X509 from the enclave's own MR_ENCLAVE / MR_SIGNER (read via the sgx_report
// N-API addon). Only the exact attested enclave can regenerate this key, so the
// harvested cert (registered on-chain) survives restarts and stays consistent.
// [TESTNET-INSECURE] -- testnet runs pre-release SGX; NOT a production guarantee.
//
// Cert-compatibility note: nodenithy's trustedzone fetches the securelock public
// key from the on-chain image registry (getImageCertPublicKey) and does NOT
// re-derive it from MR_ENCLAVE. Both enclaves are Node. So this cert only needs
// to be a valid P-384 X509 that is STABLE per MR_ENCLAVE and readable by
// etny_crypto (jsrsasign KEYUTIL for the key, crypto.createPublicKey/ec-key for
// the cert). It does NOT need to be byte-identical to pynithy's Python DER.
const rs = require('jsrsasign');
const sgx = require('./sgx_report');

// The identity-key derivation lives ENTIRELY in the compiled addon
// (get_sgx_report.c, via sgx_report.deriveIdentityScalar). It is not present in
// this interpreted source, so reading self_sign.js reveals nothing about how
// the key is derived. Each enclave uses its own role tag inside the addon, so
// the derivations are mutually decoupled. role: 0=securelock 1=trustedzone
// 2=validator, selected from the subject CN.
function roleForSubject(subjectCN) {
  const cn = String(subjectCN || '').toLowerCase();
  if (cn.includes('securelock')) return 0;
  if (cn.includes('validator')) return 2;
  return 1;
}

/**
 * Generate the deterministic self-signed cert for this enclave.
 * @param {string} subjectCN e.g. "SecureLock Enclave" / "TrustedZone Enclave [TESTNET-INSECURE]"
 * @returns {{privateKeyPem: string, certPem: string, mrEnclaveHex: string}}
 */
function generateCertFromMrEnclave(subjectCN) {
  const mrEnclaveHex = sgx.getMrEnclave();  // 64 hex chars (32 bytes)

  // Derivation performed inside the compiled addon; role from the subject CN.
  const privHex = sgx.deriveIdentityScalar(roleForSubject(subjectCN));

  // Build the EC keypair from the deterministic private scalar (jsrsasign).
  const ecKeypair = rs.KEYUTIL.generateKeypair('EC', 'secp384r1');
  const prvKey = new rs.KJUR.crypto.ECDSA({ curve: 'secp384r1' });
  prvKey.setPrivateKeyHex(privHex);
  prvKey.generatePublicKeyHex();  // derive pub from priv
  void ecKeypair;

  const pubKey = new rs.KJUR.crypto.ECDSA({ curve: 'secp384r1' });
  pubKey.setPublicKeyHex(prvKey.pubKeyHex);

  // Self-signed X509: fixed serial/validity so the cert is stable per key. No
  // custom MR_ENCLAVE extension -- unlike pynithy (whose cert carries it as an
  // informational OID), nothing in nodenithy reads it: the trustedzone uses the
  // securelock public key fetched from the on-chain image registry, not the cert
  // extensions. Keeping the cert minimal avoids jsrsasign generic-extension API
  // fragility across versions. mrEnclaveHex is still returned for logging.
  const cert = new rs.KJUR.asn1.x509.Certificate({
    version: 3,
    serial: { int: 31337 },
    issuer: { str: '/CN=' + subjectCN },
    subject: { str: '/CN=' + subjectCN },
    notbefore: '250101000000Z',
    notafter: '350101000000Z',
    sbjpubkey: pubKey,
    sigalg: 'SHA256withECDSA',
    cakey: prvKey,
  });

  const certPem = cert.getPEM();

  // Private key as PKCS8 PEM (etny_crypto reads it via rs.KEYUTIL.getKey().prvKeyHex).
  const privateKeyPem = rs.KEYUTIL.getPEM(prvKey, 'PKCS8PRV');

  return { privateKeyPem, certPem, mrEnclaveHex };
}

module.exports = { generateCertFromMrEnclave };
