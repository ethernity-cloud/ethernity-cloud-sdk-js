// ESR identity wallet derivation (ESR RFC §5.1) — Nodenithy/JS parity with the
// Python SDK's esr_wallet.py.
//
// The enclave's Ethereum wallet is derived from the enclave's IDENTITY PRIVATE
// KEY (the cert key), never from MR_ENCLAVE:
//
//     eth_priv    = keccak256(DOMAIN_SEP || identity_priv_der)  // secp256k1 scalar
//     eth_address = address(secp256k1(eth_priv))
//
// Why derive instead of reusing the cert key: the cert is secp384r1 (P-384) and
// Ethereum signing requires secp256k1, so a P-384 key can never sign a
// transaction. Deriving from the identity key means the wallet inherits the
// identity's security properties automatically:
//
//   * mainnet — the identity is PROVISIONED BY CAS as a certificate + private
//     key over the attested channel. The enclave reads that key from its key
//     file; it is the same for every node running this MRENCLAVE, so the wallet
//     is enclave-only and stable.
//   * testnet — the enclave self-signs, deriving the key from MR_SIGNER/
//     MR_ENCLAVE (both PUBLIC), so the wallet is public too. Functional testing
//     only; isSecretIdentity() returns false and callers must warn loudly.
//
// BINDING INPUT — the identity private key exactly as the enclave holds it (the
// certificate's key bytes), matching the Python SDK byte for byte. The cert is
// the same for a given MR_ENCLAVE on both paths, so its private key is already
// the stable, canonical input: same MRENCLAVE ⇒ same cert ⇒ same key ⇒ same
// address. Parsing the key to pull out a raw scalar would add enclave-side
// parsing surface and a second place for the two languages to disagree, without
// making a stable value more stable.
//
// This does NOT change the enclave's certificate: the P-384 identity keypair and
// the cert built from it are untouched. ESR only *reads* that key to derive a
// separate secp256k1 wallet key.
//
// DOMAIN_SEP keeps this key from colliding with any other use of the identity
// key; a second separator derives the state-encryption key in a later phase.
//
// SECURITY: nothing here may serialize, log or return the private key. The only
// value that ever leaves the enclave is the ADDRESS (RFC §5.2) — that is what
// makes the wallet fundable and readable without weakening secrecy.
const { ethers } = require('ethers');

const DOMAIN_SEP = 'ethernity-cloud/esr-wallet/v1';

// secp256k1 group order; a valid private scalar is in [1, N-1].
const SECP256K1_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'
);

// keccak256 of DOMAIN_SEP (raw bytes) concatenated with `dataBuf`.
function keccak(dataBuf) {
  const sep = Buffer.from(DOMAIN_SEP, 'utf8');
  return ethers.utils.keccak256(Buffer.concat([sep, dataBuf]));
}

// The identity key as bytes, exactly as held (PEM text or DER buffer). No
// re-encoding: whatever the enclave read is what gets hashed, mirroring Python
// which hashes the private_bytes() PEM/DER it already has.
function identityKeyBytes(identityPrivDer) {
  if (Buffer.isBuffer(identityPrivDer)) {
    if (identityPrivDer.length === 0) {
      throw new Error('empty enclave identity key; cannot derive ESR wallet');
    }
    return identityPrivDer;
  }
  const s = String(identityPrivDer || '');
  if (!s) throw new Error('empty enclave identity key; cannot derive ESR wallet');
  return Buffer.from(s, 'utf8');
}

/**
 * 32-byte secp256k1 private key derived from the enclave identity key.
 * Kept private to this module's callers; never log or transmit the result.
 * @param {Buffer|string} identityPrivDer the enclave identity private key (PEM/DER)
 * @returns {string} 0x-prefixed 32-byte private key hex
 */
function deriveWalletPrivateKey(identityPrivDer) {
  let digest = keccak(identityKeyBytes(identityPrivDer)); // 0x + 64 hex
  // Astronomically unlikely, but a scalar of 0 or >= N is invalid: re-hash
  // until valid so derivation is total rather than probabilistically broken.
  for (;;) {
    const scalar = BigInt(digest);
    if (scalar > 0n && scalar < SECP256K1_N) return digest;
    digest = keccak(Buffer.from(digest.slice(2), 'hex'));
  }
}

/**
 * Checksummed 0x address of the enclave's ESR wallet (safe to publish).
 * @param {Buffer|string} identityPrivDer the enclave identity private key (PEM/DER)
 * @returns {string} EIP-55 checksummed address
 */
function deriveWalletAddress(identityPrivDer) {
  const priv = deriveWalletPrivateKey(identityPrivDer);
  return new ethers.Wallet(priv).address;
}

/**
 * True only when the identity key is genuinely unpredictable to outsiders.
 *
 * This is NOT "is the enclave genuine" — SGX protects enclave memory on every
 * network. It is the narrower question the ESR wallet depends on: could someone
 * outside the enclave reproduce the private key? The distinction is
 * ATTESTATION, not SGX:
 *   * mainnet — CAS attests the enclave before provisioning the identity, so the
 *     key is effectively enclave-only. Intended posture.
 *   * testnet — NO attestation; the derivation input (MR_ENCLAVE) is public, so
 *     anyone who rebuilds the image can reproduce the keypair. Deliberate
 *     testnet tradeoff — treat these wallets as disposable.
 *
 * @param {string} networkType "mainnet" | "testnet"
 * @returns {boolean}
 */
function isSecretIdentity(networkType) {
  const override = String(process.env.ESR_IDENTITY_SECRET || '').trim().toLowerCase();
  if (override === '1' || override === 'true' || override === 'yes') return true;
  if (override === '0' || override === 'false' || override === 'no') return false;
  // Secrecy tracks attestation, not the network name: mainnet is attested,
  // testnet is not. The override exists for a future attested-testnet build.
  return String(networkType || '').trim().toLowerCase() === 'mainnet';
}

const INSECURE_IDENTITY_WARNING =
  '[TESTNET-INSECURE] This network runs the enclave on SGX but WITHOUT ' +
  "attestation, so the ESR wallet's keypair — though generated inside the " +
  'enclave — is reproducible by anyone who rebuilds the image (its derivation ' +
  'input, MR_ENCLAVE, is public and nothing verifies the enclave). This is a ' +
  'deliberate testnet tradeoff, not a defect. Treat the wallet as disposable ' +
  'and do not fund it with real value. (An attested testnet build can set ' +
  'ESR_IDENTITY_SECRET=1 to suppress this warning.)';

module.exports = {
  DOMAIN_SEP,
  deriveWalletPrivateKey,
  deriveWalletAddress,
  isSecretIdentity,
  INSECURE_IDENTITY_WARNING,
};
