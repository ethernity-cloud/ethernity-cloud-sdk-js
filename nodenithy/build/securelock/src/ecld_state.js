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

// LOCAL TESTING ONLY (esr_local). In the real enclave these stay null: the node
// applies commitFor on-chain and _contract() builds a real ethers.Contract. The
// local ESR emulator overrides the "contract" with an in-memory object and
// applies commits itself, so ecld-test runs state-using backends with no chain.
let _contractOverride = null;
let _localCommitApply = null;

function setContractOverride(obj) { _contractOverride = obj; }
function setLocalCommitApply(fn) { _localCommitApply = fn; }

/**
 * Wire the registry to the enclave's identity, storage and chain access.
 * Called by securelock at task start; payload code never calls this.
 */
function configure({ identityPriv, swiftStreamService, bucket, contractAddress, provider, caller = null }) {
  _identityPriv = identityPriv;
  _swift = swiftStreamService;
  _bucket = bucket;
  _contractAddress = contractAddress;
  _provider = provider;
  _esrLedger = [];
  _taskNonces = {};
  _taskLedger = {};
  _taskCaller = normAddr(caller);
}

// The authenticated task caller: the wallet that placed the DO request, read
// from the PoX contract by the TRUSTEDZONE and forwarded over its signed
// handoff (caller.securelock + .sig, verified by securelock before configure).
// null when the trustedzone did not supply one -- anonymity is never a
// privilege: null cannot claim ownership or touch owned state.
let _taskCaller = null;

function taskCaller() {
  return _taskCaller;
}

function normAddr(addr) {
  return typeof addr === 'string' && addr ? addr.toLowerCase() : null;
}

/**
 * State container + ACL. Stored blobs are either legacy (raw state --
 * "unowned") or an owned container:
 *   { _ecld_state: 1, acl: {...}, data: <state> }
 * acl = { owner, read: [], write: [], public_read: false }. Enforcement
 * happens HERE, inside the enclave, against the trustedzone-attested caller.
 */
const CONTAINER_MARK = '_ecld_state';

class StatePermissionError extends Error {}

// A commit's idempotency nonce was already used: the dApp supplied `nonce` on
// commit() and it is not greater than the last accepted nonce for the key --
// a duplicate (or out-of-order) submission. The state was NOT changed.
class StateNonceError extends Error {}

function unwrapStored(stored) {
  if (stored && typeof stored === 'object' && stored[CONTAINER_MARK] === 1) {
    return [stored.acl || null, stored.data];
  }
  return [null, stored];
}

/** Last accepted idempotency nonce carried by a stored blob (0 if none). */
function storedNonce(stored) {
  if (stored && typeof stored === 'object' && stored[CONTAINER_MARK] === 1) {
    const n = parseInt(stored.nonce, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function wrapStored(acl, data, committedBy = null, nonce = null) {
  // For owned state, bind the authoring caller (committedBy) INTO the blob, so
  // it lands in the CID -- the field the securelock signs -- making the caller
  // cryptographically bound to the commit, not merely a re-stampable sidecar.
  // Unowned state keeps the legacy bare shape -- unless a nonce must be
  // carried, which forces the container so the nonce survives in the blob.
  if (!acl && nonce == null) return data;
  const container = { [CONTAINER_MARK]: 1, acl: acl || null, data };
  if (committedBy) container.committedBy = committedBy;
  if (nonce != null) container.nonce = Math.trunc(nonce);
  return container;
}

/**
 * Post-payload: re-assert the trusted caller across the ESR ledger. Called by
 * the securelock after the payload returns, with the attested caller captured
 * before execution (outside the payload's reach). Overwrites callerUsed (and
 * re-fixes enclave to the real signer) in every owned entry and RE-STAGES the
 * ledger, so a forged callerUsed cannot reach the trustedzone. Returns true if
 * any entry's callerUsed differed from the trusted value (tamper detected).
 * Defence in depth -- the trustedzone and the CID-bound caller are the sound
 * layers; this runs in the same process the payload subverted.
 */
async function restampLedgerCaller(trustedCaller) {
  const trusted = normAddr(trustedCaller);
  if (!_esrLedger.length) return false;
  let tampered = false;
  let signerAddr = null;
  try {
    signerAddr = await new StateRegistry()._signer().getAddress();
  } catch (e) { signerAddr = null; }
  for (const entry of _esrLedger) {
    if (!entry.owned) continue;
    if (normAddr(entry.callerUsed) !== trusted) tampered = true;
    entry.callerUsed = trusted || '';
    if (signerAddr) entry.enclave = signerAddr;
  }
  try {
    await _swift.putFileContent(
      _bucket, 'esr.authorizations.json', '',
      Buffer.from(JSON.stringify(_esrLedger), 'utf8'));
  } catch (e) { /* best-effort restage; trustedzone still adjudicates */ }
  return tampered;
}

function aclMembers(acl, field) {
  return new Set((acl[field] || []).map(normAddr).filter(Boolean));
}

function canRead(acl) {
  if (!acl || acl.public_read) return true;
  const c = _taskCaller;
  if (!c) return false;
  return c === normAddr(acl.owner) || aclMembers(acl, 'read').has(c) || aclMembers(acl, 'write').has(c);
}

function canWrite(acl) {
  if (!acl) return true;                 // unowned: writable; claimed when a caller exists
  const c = _taskCaller;
  if (!c) return false;
  return c === normAddr(acl.owner) || aclMembers(acl, 'write').has(c);
}

function newAcl(owner) {
  return { owner, read: [], write: [], public_read: false };
}

// Task-scoped ledger of every state key this execution touched, recorded by
// get()/commit(). ecldResult() snapshots it to attach fresh state to the task
// result, so callers (and the runner's state cache) get current state in the
// same result -- no separate read task needed. Reset per task in configure().
let _taskLedger = {};

function ledgerRecord(key, version, cid, state) {
  _taskLedger[key] = { key, version: Number(version), cid, state };
}

/**
 * The `esr` attachment for ecldResult: wallet + entries. Synchronous by
 * design (the securelock consumes results synchronously): entries come from
 * the in-memory ledger of keys this task already touched. To attach a key the
 * task did not touch, use the async esrFetch() helper, which awaits the reads
 * (populating the ledger) before building the result.
 */
function ledgerSnapshot(includeState = true, keys = null) {
  const reg = new StateRegistry();
  const wanted = keys ? keys : Object.keys(_taskLedger);
  const entries = [];
  for (const k of wanted) {
    const e = _taskLedger[k];
    if (!e) continue;
    const entry = { ...e };
    if (!includeState) delete entry.state;
    entries.push(entry);
  }
  return { wallet: reg.walletAddress, entries };
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
  'function commit(bytes32 key, string newCID, uint256 expectedVersion, uint256 nonce)',
  'function commitFor(address enclave, bytes32 key, string newCID, uint256 expectedVersion, uint256 relayNonce, uint256 nonce, bytes signature)',
  'function commitDigest(address enclave, bytes32 key, string newCID, uint256 expectedVersion, uint256 relayNonce, uint256 nonce) view returns (bytes32)',
  'function relayNonce(address enclave) view returns (uint256)',
  'function getState(address enclave, bytes32 key) view returns (string cid, uint256 version, uint64 updatedAt)',
  'function getVersion(address enclave, bytes32 key) view returns (uint256)',
  'function getNonce(address enclave, bytes32 key) view returns (uint256)',
  'function exists(address enclave, bytes32 key) view returns (bool)'
];

// Order-wide ledger of signed authorizations. ESR commits do NOT pay their own
// gas (see contracts/esr/RELAY-DESIGN.md): the enclave only SIGNS each commit
// (commitFor); the NODE relays it and pays, and does all gas accounting. The
// securelock does no gas math -- nothing it could claim about cost is trusted.
let _esrLedger = [];

// Per-task memo of the last idempotency nonce ACCEPTED per key, so a
// getNonce() right after a commit in the SAME task returns the fresh value
// even before the node's relay lands on-chain.
let _taskNonces = {};

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

  /**
   * Alias of walletAddress — the ENCLAVE's own on-chain address (its identity,
   * and the namespace all its state keys live under). Preferred name in new
   * code; walletAddress remains for compatibility.
   */
  get enclaveAddress() {
    return this.walletAddress;
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
    // Local emulator: use the in-memory contract object instead of a real one.
    if (_contractOverride) return _contractOverride;
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
    const [acl, data, version, cid] = await this._readContainer(key, fallback);
    if (!canRead(acl)) {
      throw new StatePermissionError(
        `caller ${_taskCaller || '<anonymous>'} has no read permission on ` +
          `state key '${key}' (owner: ${acl.owner})`
      );
    }
    ledgerRecord(key, version || 0, cid, data);
    return data;
  }

  /** [acl, data, version, cid, nonce] for `key`; NO permission check here. */
  async _readContainer(key, fallback = {}) {
    const [cid, version] = await this._contract().getState(this.walletAddress, keyHash(key));
    if (!version || !cid) {
      return [null, fallback, 0, null, 0];
    }
    if (!looksLikeCID(cid)) {
      throw new Error(
        `ESR entry for '${key}' holds a pointer that is not a CID (${cid.slice(0, 32)}…). ` +
          'The committing code is writing a non-CID value.'
      );
    }
    const blob = await this._fetch(key, cid);
    const stored = JSON.parse(decrypt(blob).toString('utf8'));
    const [acl, data] = unwrapStored(stored);
    return [acl, data, Number(version), cid, storedNonce(stored)];
  }

  /**
   * The last accepted idempotency nonce for `key` (0 if none was ever used).
   * A dApp that wants duplicate suppression reads this, picks a greater value
   * (e.g. +1, or a timestamp), and passes it to commit(..., { nonce }).
   *
   * The nonce is PUBLIC data: the registry records it on-chain next to the
   * version, and anyone can read it with a free eth_call (getNonce) -- so no
   * read-ACL applies here, and web3 clients see the same value via the
   * runner's esrNonce. Use opaque monotonic values (a counter or a
   * timestamp), never secret-derived ones.
   *
   * Reads chain-first (authoritative, post-relay), merged with this task's
   * own accepted commits so `commit(..., { nonce: N }); getNonce()` returns N
   * even before the node's relay lands. Falls back to the in-blob value when
   * the registry predates the on-chain field.
   */
  async getNonce(key) {
    let chain = 0;
    try {
      const n = await this._contract().getNonce(this.walletAddress, keyHash(key));
      chain = Number(n);
    } catch (e) {
      // Registry without getNonce (older deployment): in-blob fallback.
      try {
        const [, , , , blobNonce] = await this._readContainer(key);
        chain = Number(blobNonce) || 0;
      } catch (e2) {
        chain = 0;
      }
    }
    return Math.max(Number(chain) || 0, Number(_taskNonces[key] || 0));
  }

  /**
   * Read-modify-write `key` under optimistic concurrency.
   *
   * `mutate` receives the current state and returns the new state. If another
   * commit lands in between, the contract rejects ours and we re-read and
   * retry, so concurrent tasks cannot silently lose updates.
   */
  async commit(key, mutate, opts = 3) {
    // Back-compat: the third arg used to be `attempts` (a number); it may now
    // also be { attempts, nonce }. `nonce` is an idempotency guard the dApp
    // controls: it must be STRICTLY GREATER than the last accepted nonce for
    // the key (see getNonce). A duplicate or stale nonce throws
    // StateNonceError and the state is NOT changed.
    const { attempts = 3, nonce = null } =
      typeof opts === 'number' ? { attempts: opts } : (opts || {});
    const transform = async (acl, data) => {
      if (!canWrite(acl)) {
        throw new StatePermissionError(
          `caller ${_taskCaller || '<anonymous>'} has no write permission on ` +
            `state key '${key}' (owner: ${acl.owner})`
        );
      }
      let nextAcl = acl;
      if (!nextAcl && _taskCaller) nextAcl = newAcl(_taskCaller); // first-writer-owns
      return [nextAcl, await mutate(data)];
    };
    const [, newData] = await this._commitTransform(key, transform, attempts, nonce);
    return newData;
  }

  /**
   * Optimistic-concurrency commit of transform(acl, data, version) ->
   * [newAcl, newData]. The stored blob is the wrapped container (or the bare
   * data while unowned). On a version race we re-read and retry, so
   * concurrent tasks cannot silently lose updates.
   */
  async _commitTransform(key, transform, attempts = 3, nonce = null) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [acl, data, currentVersion, , priorNonce] = await this._readContainer(key);
      // The nonce check re-runs on every retry against the freshly read state,
      // so a racing commit that consumed the same nonce fails this one.
      let finalNonce;
      if (nonce != null) {
        const n = Math.trunc(nonce);
        if (n <= priorNonce) {
          throw new StateNonceError(
            `nonce ${n} was already used for state key '${key}' (last accepted: ` +
              `${priorNonce}); duplicate commit suppressed, state unchanged`
          );
        }
        finalNonce = n;
      } else {
        // Preserve the stored nonce so a nonce-less commit cannot reset the
        // guard and reopen replays.
        finalNonce = priorNonce > 0 ? priorNonce : null;
      }
      // eslint-disable-next-line no-await-in-loop
      const [nextAcl, newData] = await transform(acl, data, currentVersion);
      // Bind the authoring caller into the blob (hence the CID/signature) for
      // owned state.
      const stored = wrapStored(nextAcl, newData, nextAcl ? _taskCaller : null, finalNonce);

      const blob = encrypt(Buffer.from(JSON.stringify(stored), 'utf8'));
      // Compute the CID from OUR bytes — never accept one from the node.
      const cid = cidv1Raw(blob);

      // Hand the blob and the CID to the node for pinning. It verifies the CID
      // matches; it does not get to choose it. Fire-and-forget.
      // eslint-disable-next-line no-await-in-loop
      await this._publish(key, blob, cid);

      try {
        // On-chain, 0 means "no guard: preserve the stored nonce". Only a
        // caller-supplied nonce is sent; the preserved value stays inside the
        // blob for registries without nonce support.
        // eslint-disable-next-line no-await-in-loop
        await this._sendCommit(keyHash(key), cid, currentVersion,
          nextAcl ? normAddr(nextAcl.owner) : null,
          nonce != null ? Math.trunc(nonce) : 0);
        // Record the POST-commit values (the DATA -- the ACL never leaves in
        // results): this is what the chain shows once the relay lands.
        ledgerRecord(key, currentVersion + 1, cid, newData);
        if (finalNonce) _taskNonces[key] = Math.trunc(finalNonce);
        return [nextAcl, newData];
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

  async _sendCommit(keyHashHex, cid, expectedVersion, ownerAddr = null, nonce = 0) {
    // The enclave never pays gas and does NO gas math: it SIGNS the commit
    // (commitFor) and stages the signed authorization for the node, which
    // relays it and pays. The trustedzone independently re-prices the whole
    // ledger and adjudicates. Nothing the securelock could claim about cost is
    // trusted, so it claims nothing.
    const signer = this._signer();
    const enclave = await signer.getAddress();
    const contract = this._contract();

    const relayNonce = await contract.relayNonce(enclave);
    // The idempotency nonce is signature-bound: it is part of the digest the
    // enclave signs, so the relaying node cannot alter or strip it.
    const digest = await contract.commitDigest(
      enclave, keyHashHex, cid, expectedVersion, relayNonce, Math.trunc(nonce || 0));
    // Sign the raw 32-byte digest as an eth_sign message (matches the
    // contract's "\x19Ethereum Signed Message:\n32" recovery).
    const signature = await signer.signMessage(ethers.utils.arrayify(digest));

    const auth = {
      enclave,
      keyHash: keyHashHex,
      cid,
      expectedVersion: Number(expectedVersion),
      relayNonce: Number(relayNonce),
      // PUBLIC idempotency nonce (0 = no guard): recorded on-chain by
      // commitFor, enforced strictly increasing per (enclave, key).
      nonce: Math.trunc(nonce || 0),
      signature,
      // IMPERSONATION GUARD: the trustedzone requires callerUsed to equal the
      // DO owner it reads from the PoX contract, so a payload that forged the
      // in-enclave caller to impersonate another user is rejected outside the
      // payload's process. It does NOT verify the caller was a permitted
      // writer (it cannot read the encrypted ACL). Unowned commits carry no
      // constraint.
      callerUsed: _taskCaller || '',
      owned: Boolean(ownerAddr)
    };

    _esrLedger.push(auth);
    await _swift.putFileContent(
      _bucket, 'esr.authorizations.json', '',
      Buffer.from(JSON.stringify(_esrLedger), 'utf8'));
    await _swift.putFileContent(
      _bucket, `esr.commit.${Number(relayNonce)}.json`, '',
      Buffer.from(JSON.stringify(auth), 'utf8'));

    // LOCAL TESTING: with no node to relay commitFor, apply the commit to the
    // in-memory registry now so getState/getVersion reflect it. No-op in the
    // real enclave (hook is null) -- there the node applies it on-chain.
    if (_localCommitApply) {
      await _localCommitApply(enclave, keyHashHex, cid, Number(expectedVersion),
        Math.trunc(nonce || 0));
    }

    return { relayed: true, relayNonce: Number(relayNonce) };
  }
}

/** Owner-only ACL mutation; an unowned key is claimed first (owner = caller). */
async function ownerOp(key, mutator) {
  if (!_taskCaller) {
    throw new StatePermissionError(
      'state management requires an authenticated caller (the trustedzone supplied none)'
    );
  }
  const reg = new StateRegistry();
  const transform = async (acl, data) => {
    let nextAcl = acl || newAcl(_taskCaller);
    if (normAddr(nextAcl.owner) !== _taskCaller) {
      throw new StatePermissionError(
        `caller ${_taskCaller} is not the owner of state key '${key}' (owner: ${nextAcl.owner})`
      );
    }
    nextAcl = mutator({ ...nextAcl });
    return [nextAcl, data];
  };
  const [acl] = await reg._commitTransform(key, transform);
  return { ...acl };
}

function assertLevel(level) {
  if (level !== 'read' && level !== 'write') throw new Error("level must be 'read' or 'write'");
}

async function esrGrant(key, address, level = 'read') {
  assertLevel(level);
  const addr = normAddr(address);
  if (!addr) throw new Error('a grantee address is required');
  return ownerOp(key, (acl) => {
    const members = new Set((acl[level] || []).map(normAddr).filter(Boolean));
    members.add(addr);
    acl[level] = [...members].sort();
    return acl;
  });
}

async function esrRevoke(key, address, level = 'read') {
  assertLevel(level);
  const addr = normAddr(address);
  return ownerOp(key, (acl) => {
    acl[level] = (acl[level] || []).map(normAddr).filter((a) => a && a !== addr).sort();
    return acl;
  });
}

async function esrSetPublicRead(key, enabled = true) {
  return ownerOp(key, (acl) => {
    acl.public_read = Boolean(enabled);
    return acl;
  });
}

async function esrTransfer(key, newOwner) {
  const addr = normAddr(newOwner);
  if (!addr) throw new Error('a new owner address is required');
  return ownerOp(key, (acl) => {
    acl.owner = addr;
    return acl;
  });
}

/** Owner address of `key`, or null while unowned. Exposes nothing else. */
async function esrOwner(key) {
  const [acl] = await new StateRegistry()._readContainer(key);
  return acl ? acl.owner : null;
}

/** Owner-only: the full ACL of `key`. */
async function esrAcl(key) {
  const [acl] = await new StateRegistry()._readContainer(key);
  if (!acl) return null;
  if (!_taskCaller || normAddr(acl.owner) !== _taskCaller) {
    throw new StatePermissionError(
      `caller ${_taskCaller || '<anonymous>'} is not the owner of state key '${key}'`
    );
  }
  return { ...acl };
}

function setTaskCaller(caller) { _taskCaller = normAddr(caller); }

/**
 * The last accepted idempotency nonce for `key` (0 if none). See
 * StateRegistry.getNonce / commit(key, mutate, { nonce }).
 */
async function esrNonce(key) {
  return new StateRegistry().getNonce(key);
}

module.exports = {
  StateRegistry,
  configure,
  cidv1Raw,
  looksLikeCID,
  ledgerSnapshot,
  taskCaller,
  setTaskCaller,
  restampLedgerCaller,
  StatePermissionError,
  StateNonceError,
  esrGrant,
  esrRevoke,
  esrSetPublicRead,
  esrTransfer,
  esrOwner,
  esrAcl,
  esrNonce,
  // local-testing hooks (esr_local only)
  setContractOverride,
  setLocalCommitApply,
  normAddr
};
