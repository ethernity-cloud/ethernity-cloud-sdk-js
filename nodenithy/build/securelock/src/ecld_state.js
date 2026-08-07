// Enclave State Registry (ESR) — in-enclave state API (Nodenithy).
//
// Gives payload code durable, encrypted state across tasks:
//
//     const { StateRegistry } = require('./ecld_state');
//     const state = new StateRegistry();
//     await state.commit('my-key', (s) => ({ ...s, n: (s.n || 0) + 1 }));
//
// State is encrypted inside the enclave, stored as an IPFS object, and only a
// POINTER (the CID) plus a version goes on-chain. The registry keeps one entry
// per (enclave, key) with monotonic versions and optimistic concurrency.
//
// ## Why the enclave computes the CID itself
//
// The node is untrusted. If it told the enclave which CID to commit, a
// malicious operator could pin the enclave's blob but return the CID of
// DIFFERENT content; the enclave would sign that onto the chain, and clients
// would fetch attacker-chosen state believing the enclave authored it.
//
// A CID is a hash of the content, so the enclave derives it from the bytes it
// just encrypted (CIDv1/raw = base32(0x01 0x55 0x12 0x20 || sha256(content)))
// and commits that. The node pins and verifies but never chooses. It also means
// the enclave never waits on the node: it writes the blob, writes the CID,
// commits, and moves on.
//
// ## Encryption
//
// State is encrypted with a key derived from the enclave identity under a
// SECOND domain separator (distinct from the ESR wallet's), so the state key
// cannot collide with the wallet key. State therefore inherits exactly the
// identity's security: enclave-only on mainnet, reproducible on testnet — which
// is the accepted testnet posture (functional testing, not secrecy).
//
// SECURITY: the state key and the wallet key never leave this module. Only the
// address and the CID are ever emitted.
const crypto = require('crypto');
const { ethers } = require('ethers');
const esr_wallet = require('./esr_wallet');

const DOMAIN_SEP_STATE = 'ethernity-cloud/esr-encryption/v1';

// AES-GCM parameters, pinned explicitly so the blob layout never depends on a
// library default: nonce(12) || tag(16) || ciphertext.
const NONCE_LEN = 12;
const TAG_LEN = 16;

let _identityPriv = null;
let _swift = null;
let _bucket = null;
let _contractAddress = null;
let _provider = null;

/**
 * Wire the registry to the enclave's identity, storage and chain access.
 * Called by securelock at task start; payload code never calls this.
 */
function configure({ identityPriv, swiftStreamService, bucket, contractAddress, provider }) {
  _identityPriv = identityPriv;
  _swift = swiftStreamService;
  _bucket = bucket;
  _contractAddress = contractAddress;
  _provider = provider;
}

function keccak256(buf) {
  return Buffer.from(ethers.utils.keccak256(buf).slice(2), 'hex');
}

/**
 * AES key for state, derived under its own domain separator. A separate
 * separator from the wallet's means the two keys are provably unrelated:
 * compromising one does not yield the other.
 */
function stateKey() {
  if (!_identityPriv) {
    throw new Error('StateRegistry is not configured (no enclave identity)');
  }
  const material = Buffer.isBuffer(_identityPriv)
    ? _identityPriv
    : Buffer.from(String(_identityPriv), 'utf8');
  return keccak256(Buffer.concat([Buffer.from(DOMAIN_SEP_STATE, 'utf8'), material]));
}

/**
 * CIDv1/raw/sha2-256 for `content`, computed without touching IPFS.
 * Matches `ipfs add --cid-version=1 --raw-leaves`, which is what lets the
 * enclave commit a CID it derived itself rather than one a node handed it.
 */
function cidv1Raw(content) {
  const digest = crypto.createHash('sha256').update(content).digest();
  const raw = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  return 'b' + base32Encode(raw).toLowerCase().replace(/=+$/, '');
}

// RFC4648 base32, no padding stripped here (the caller strips it).
function base32Encode(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

/**
 * True only for values shaped like an IPFS CID.
 *
 * The contract accepts any non-empty string as the pointer, so a buggy writer
 * can commit something that is not a CID (the live registry holds one 0x…
 * digest). That is a defect in the writer, not a supported format: such an
 * entry is rejected rather than fetched, because passing it on means an error
 * at best and a retry-loop at worst.
 */
function looksLikeCID(value) {
  const cid = (value || '').trim();
  if (!cid || cid.startsWith('0x')) return false;
  if (cid.startsWith('Qm') && cid.length === 46) return true;
  if (cid.startsWith('b') && cid.length >= 46 && cid === cid.toLowerCase()) return true;
  return false;
}

function encrypt(plaintext) {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', stateKey(), nonce, {
    authTagLength: TAG_LEN
  });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}

function decrypt(blob) {
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new Error('state blob is too short to be valid');
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const ct = blob.subarray(NONCE_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', stateKey(), nonce, {
    authTagLength: TAG_LEN
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** The bytes32 the contract is keyed by: keccak256(key). */
function keyHash(key) {
  return ethers.utils.id(key);
}

const ESR_ABI = [
  'function commit(bytes32 key, string newCID, uint256 expectedVersion)',
  'function getState(address enclave, bytes32 key) view returns (string cid, uint256 version, uint64 updatedAt)',
  'function getVersion(address enclave, bytes32 key) view returns (uint256)',
  'function exists(address enclave, bytes32 key) view returns (bool)'
];

class StateRegistry {
  constructor() {
    if (!_contractAddress) {
      throw new Error(
        'ESR is not enabled for this enclave. Enable it (ECLD_ESR_ENABLE) and ' +
          'rebuild, so the registry address is baked into the image.'
      );
    }
    this._priv = null;
  }

  /** The enclave's on-chain address — safe to publish and to fund. */
  get walletAddress() {
    return esr_wallet.deriveWalletAddress(_identityPriv);
  }

  _signer() {
    // Reuse esr_wallet's derivation rather than repeating it here: two copies
    // would eventually disagree, and the address a client funds would stop
    // matching the key that signs. The key stays inside this method.
    if (this._priv === null) {
      this._priv = esr_wallet._deriveWalletPrivateKey(_identityPriv);
    }
    return new ethers.Wallet(this._priv, _provider);
  }

  _contract(signerOrProvider) {
    return new ethers.Contract(_contractAddress, ESR_ABI, signerOrProvider || _provider);
  }

  /** Current on-chain version for `key`; 0 when never committed. */
  async getVersion(key) {
    const v = await this._contract().getVersion(this.walletAddress, keyHash(key));
    return Number(v);
  }

  /**
   * Decrypted state for `key`, or `fallback` ({} by default) when absent.
   *
   * Throws on a pointer that is not a CID: treating a broken pointer as "no
   * state" would let the next commit overwrite data that is still recoverable.
   */
  async get(key, fallback = {}) {
    const [cid, version] = await this._contract().getState(this.walletAddress, keyHash(key));
    if (!version || !cid) return fallback;
    if (!looksLikeCID(cid)) {
      throw new Error(
        `ESR entry for '${key}' holds a pointer that is not a CID (${cid.slice(0, 32)}…). ` +
          'The committing code is writing a non-CID value.'
      );
    }
    const blob = await this._fetch(key, cid);
    return JSON.parse(decrypt(blob).toString('utf8'));
  }

  /**
   * Read-modify-write `key` under optimistic concurrency.
   *
   * `mutate` receives the current state and returns the new state. If another
   * commit lands in between, the contract rejects ours and we re-read and
   * retry, so concurrent tasks cannot silently lose updates.
   */
  async commit(key, mutate, attempts = 3) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const currentVersion = await this.getVersion(key);
      // eslint-disable-next-line no-await-in-loop
      const current = currentVersion ? await this.get(key) : {};
      const newState = await mutate(current);

      const blob = encrypt(Buffer.from(JSON.stringify(newState), 'utf8'));
      // Compute the CID from OUR bytes — never accept one from the node.
      const cid = cidv1Raw(blob);

      // Hand the blob and the CID to the node for pinning. It verifies the CID
      // matches; it does not get to choose it. Fire-and-forget.
      // eslint-disable-next-line no-await-in-loop
      await this._publish(key, blob, cid);

      try {
        // eslint-disable-next-line no-await-in-loop
        await this._sendCommit(keyHash(key), cid, currentVersion);
        return newState;
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (/VersionMismatch/i.test(msg) || /version/i.test(msg)) {
          lastError = e;
          // eslint-disable-next-line no-continue
          continue;
        }
        throw e;
      }
    }
    throw new Error(`ESR commit failed after ${attempts} attempts: ${lastError}`);
  }

  async _publish(key, blob, cid) {
    await _swift.putFileContent(_bucket, `state.${key}.enc`, '', blob);
    await _swift.putFileContent(_bucket, `state.${key}.cid`, '', cid);
  }

  /**
   * Read a state object back, verifying it against the on-chain CID.
   *
   * The enclave cannot reach IPFS (the Kubo API binds loopback on the host), so
   * the node stages state objects in the bucket. That makes the node the
   * delivery path but not a trusted one: content is checked against the CID the
   * chain records, so a substituted blob is rejected rather than decrypted.
   */
  async _fetch(key, cid) {
    for (const name of [`state.${key}.enc`, `state.${cid}.enc`]) {
      // eslint-disable-next-line no-await-in-loop
      const data = await _swift.getFileContentBytes(_bucket, name).catch(() => null);
      if (data && data.length) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (cidv1Raw(buf) !== cid) {
          throw new Error(
            `State object ${name} does not match the committed CID ${cid} — refusing to use it`
          );
        }
        return buf;
      }
    }
    throw new Error(`Could not read state object for '${key}' (${cid})`);
  }

  async _sendCommit(keyHashHex, cid, expectedVersion) {
    const contract = this._contract(this._signer());
    const tx = await contract.commit(keyHashHex, cid, expectedVersion);
    return tx.wait();
  }
}

module.exports = {
  StateRegistry,
  configure,
  cidv1Raw,
  looksLikeCID
};
