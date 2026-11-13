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
const ESR_ABI = require('./esr_abi');

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
  _taskWrites = {};
  _taskRelayNonces = {};
  _taskLedger = {};
  _stepHeld = null;
  _stepSnapshot = null;
  _commitsClosed = false;
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

// Per-run cap on state commits: bounds the number of relayed transactions the
// node must track/pay and the size of the adjudicated ledger bound into the
// result transaction. 256 so the on-chain count fits ONE BYTE (bias-1:
// 0x00 = 1 commit ... 0xFF = 256; an all-zero root means no commits at all).
// The over-limit commit is NOT applied; earlier commits stand. Surfaces as
// task code 38 (ESR_COMMIT_LIMIT_EXCEEDED).
const MAX_COMMITS_PER_TASK = 256;

// How long a read waits for the node to stage a state object the chain names
// before the task fails, and how often it looks for it: the node writes the
// objects pinned on it within seconds of the order's start and the ones it has
// to fetch from the network as they arrive.
const STATE_STAGE_WAIT_MS = 120000;
const STATE_STAGE_POLL_MS = 2000;

class StateLimitError extends Error {}

function unwrapStored(stored) {
  if (stored && typeof stored === 'object' && stored[CONTAINER_MARK] === 1) {
    return [stored.acl || null, stored.data];
  }
  return [null, stored];
}

function wrapStored(acl, data, committedBy = null, nonce = null) {
  // For owned state, bind the authoring caller (committedBy) INTO the blob, so
  // it lands in the CID -- the field the securelock signs -- making the caller
  // cryptographically bound to the commit, not merely a re-stampable sidecar.
  // Unowned state keeps the bare shape (no ACL, no binding) -- unless a nonce
  // must be carried, which forces the container shape.
  //
  // `nonce` is a REPORTING COPY of the registry's stored idempotency nonce as
  // of this commit. The on-chain value (getNonce) is always the primary; the
  // blob copy exists so the signed CID cryptographically commits to the nonce
  // the enclave intended, and reads verify the two match (_readContainer).
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
  if (!_esrLedger.length) return false;
  const tampered = await restampRecords(_esrLedger, trustedCaller);
  try {
    await writeAuthorizations();
  } catch (e) { /* best-effort restage; trustedzone still adjudicates */ }
  return tampered;
}

// Overwrites callerUsed with the trusted caller (and enclave with the real
// signer) in every owned record of `records`; returns whether any differed.
async function restampRecords(records, trustedCaller) {
  const trusted = normAddr(trustedCaller);
  let tampered = false;
  let signerAddr = null;
  try {
    signerAddr = (await new StateRegistry()._signer().getAddress()).toLowerCase();
  } catch (e) { signerAddr = null; }
  for (const entry of records) {
    if (!entry.owned) continue;
    if (normAddr(entry.callerUsed) !== trusted) tampered = true;
    entry.callerUsed = trusted || '';
    if (signerAddr) entry.enclave = signerAddr;
  }
  return tampered;
}

// esr.authorizations.json: the compact JSON array of every staged record in
// staging order, the bytes the agent pins as the attested ledger.
async function writeAuthorizations() {
  await _swift.putFileContent(
    _bucket, 'esr.authorizations.json', '',
    Buffer.from(JSON.stringify(_esrLedger), 'utf8'));
}

// A session step's commit hold (RESERVATION-DESIGN.md section 2). While a
// step is open, _sendCommit signs each commit and appends the record to
// _stepHeld instead of staging it; the session executor takes the held
// records with the step's output and stages them as
// session.commit.<n>.<key16>.<relayNonce>.json, or discards them when the
// step is cut by the transfer control. The memos of nonces, writes and relay
// nonces are snapshotted at the step's start so a discard rolls them back.
let _stepHeld = null;
let _stepSnapshot = null;
// Set by closeCommits once the session ended: a commit a handler issues
// after its step was cut, or after the session closed, is refused.
let _commitsClosed = false;

function beginStep() {
  if (_stepHeld !== null) return;
  _stepHeld = [];
  _stepSnapshot = {
    nonces: { ..._taskNonces },
    writes: { ..._taskWrites },
    relayNonces: { ..._taskRelayNonces },
  };
}

// Closes the registry to commits for the rest of the process: the session
// executor calls it when the transfer control cut a step and when the
// session ended, so a handler still running writes nothing more.
function closeCommits() {
  _commitsClosed = true;
}

function assertCommitsOpen() {
  if (_commitsClosed) {
    throw new StatePermissionError(
      'the session ended; the state registry accepts no further commits'
    );
  }
}

// Closes the step: its records, restamped with the trusted caller, join the
// staged ledger in commit order and are returned for the step's envelope,
// with whether any record carried another caller. The next step opens with
// beginStep.
async function takeStepCommits(trustedCaller) {
  if (_stepHeld === null) return { records: [], tampered: false };
  const records = _stepHeld;
  _stepHeld = null;
  _stepSnapshot = null;
  const tampered = await restampRecords(records, trustedCaller);
  _esrLedger.push(...records);
  return { records, tampered };
}

// Drops the step's records and restores the memos the step advanced, so a
// later commit to a discarded key signs the relay nonce the chain expects.
function discardStepCommits() {
  if (_stepHeld === null) return [];
  const records = _stepHeld;
  _stepHeld = null;
  _taskNonces = _stepSnapshot.nonces;
  _taskWrites = _stepSnapshot.writes;
  _taskRelayNonces = _stepSnapshot.relayNonces;
  _stepSnapshot = null;
  return records;
}

// A session that ends before any output stages its held records as a plain
// task stages its commits: esr.commit.<key16>.<relayNonce>.json each, the
// ledger and esr.authorizations.json rewritten. Returns what takeStepCommits
// returns.
async function flushStepCommits(trustedCaller) {
  const taken = await takeStepCommits(trustedCaller);
  for (const auth of taken.records) {
    // eslint-disable-next-line no-await-in-loop
    await _swift.putFileContent(
      _bucket, commitFileName('esr.commit', auth), '',
      Buffer.from(JSON.stringify(auth), 'utf8'));
  }
  if (taken.records.length) await writeAuthorizations();
  return taken;
}

// <prefix>.<key16>.<relayNonce>.json: the key prefix keeps commits to
// different keys apart, and the per-key relay order is explicit.
function commitFileName(prefix, auth) {
  const kh16 = String(auth.keyHash).toLowerCase().replace(/^0x/, '').slice(0, 16);
  return `${prefix}.${kh16}.${Number(auth.relayNonce)}.json`;
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

// The fence's scope (RESERVATION-DESIGN.md section 2): a container whose ACL
// names the task caller as owner or write member. An unowned container is
// outside it.
function fenceWritable(acl) {
  const c = _taskCaller;
  if (!acl || !c) return false;
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

/**
 * The ledger this securelock staged, for the securelock to attest inside the
 * signed result envelope AFTER restampLedgerCaller: the enclave's ESR wallet
 * plus the signed authorization records (the same objects written to
 * esr.authorizations.json). The trustedzone adjudicates from this copy, which
 * the node's storage cannot delete, truncate or edit. Never called from
 * payload code. wallet is null when the registry was never configured.
 */
function ledgerAttestation() {
  const wallet = _identityPriv ? esr_wallet.deriveWalletAddress(_identityPriv) : null;
  return { wallet, commits: _esrLedger.map((e) => ({ ...e })) };
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

// A state object is stored as the node's Kubo stores it with `add
// --cid-version=1 --raw-leaves` and its default chunker: in raw sha256 blocks
// of BLOCK_SIZE bytes (the last one shorter), a single block as it is, several
// under a balanced UnixFS tree of at most LINKS_PER_NODE blocks per node.
// unixfsCid() computes the resulting CID from the bytes, so the enclave
// commits a CID it derived itself rather than one a node handed it, and the
// node stores the object under that CID (mvp-pox-node utils.py unixfs_cid).
const BLOCK_SIZE = 262144;
const LINKS_PER_NODE = 174;

function cidB32(cid) {
  return 'b' + base32Encode(cid).toLowerCase().replace(/=+$/, '');
}

function pbVarint(n) {
  const out = [];
  for (;;) {
    const byte = n % 128;
    n = Math.floor(n / 128);
    if (n === 0) {
      out.push(byte);
      return Buffer.from(out);
    }
    out.push(byte | 0x80);
  }
}

// A protobuf field: varint (wire 0) or length-delimited (wire 2).
function pbField(number, wire, payload) {
  const tag = pbVarint(number * 8 + wire);
  return wire === 2 ? Buffer.concat([tag, pbVarint(payload.length), payload]) : Buffer.concat([tag, payload]);
}

// CIDv1, codec raw (0x55), sha2-256 (0x12, 32 bytes).
function pbRawCid(content) {
  return Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), crypto.createHash('sha256').update(content).digest()]);
}

// A dag-pb UnixFS File node over `children`, each [cid, tsize, filesize];
// returns [cid, tsize, filesize]. Links come before Data in dag-pb; a link
// carries the child's CID, an empty Name and its Tsize, the size of the
// child's subtree; Data is UnixFS Type=File(2), filesize, blocksizes.
function pbFileNode(children) {
  const links = Buffer.concat(children.map(([cid, tsize]) =>
    pbField(2, 2, Buffer.concat([pbField(1, 2, cid), pbField(2, 2, Buffer.alloc(0)), pbField(3, 0, pbVarint(tsize))]))));
  const filesize = children.reduce((n, [, , size]) => n + size, 0);
  const data = Buffer.concat([pbField(1, 0, pbVarint(2)), pbField(3, 0, pbVarint(filesize)),
    ...children.map(([, , size]) => pbField(4, 0, pbVarint(size)))]);
  const block = Buffer.concat([links, pbField(1, 2, data)]);
  const cid = Buffer.concat([Buffer.from([0x01, 0x70, 0x12, 0x20]), crypto.createHash('sha256').update(block).digest()]);
  return [cid, block.length + children.reduce((n, [, tsize]) => n + tsize, 0), filesize];
}

/**
 * The CID the node's Kubo gives `content`: the raw block's CID up to one
 * block, else the root of the balanced UnixFS tree over the blocks,
 * LINKS_PER_NODE to a node, every node full but the last.
 */
function unixfsCid(content, blockSize = BLOCK_SIZE) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (buf.length <= blockSize) return cidB32(pbRawCid(buf));
  let nodes = [];
  for (let i = 0; i < buf.length; i += blockSize) {
    const chunk = buf.subarray(i, i + blockSize);
    nodes.push([pbRawCid(chunk), chunk.length, chunk.length]);
  }
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += LINKS_PER_NODE) next.push(pbFileNode(nodes.slice(i, i + LINKS_PER_NODE)));
    nodes = next;
  }
  return cidB32(nodes[0][0]);
}

/**
 * CIDv1/raw/sha2-256 for `content`: its CID as one raw block, which is its CID
 * through the node's Kubo up to BLOCK_SIZE bytes.
 */
function cidv1Raw(content) {
  return cidB32(pbRawCid(content));
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

// Order-wide ledger of signed authorizations. ESR commits do NOT pay their own
// gas (see contracts/esr/RELAY-DESIGN.md): the enclave only SIGNS each commit
// (commitFor); the NODE relays it and pays, and does all gas accounting. The
// securelock does no gas math -- nothing it could claim about cost is trusted.
let _esrLedger = [];

// Per-task memo, by key hash, of the last idempotency nonce ACCEPTED per key,
// so a getNonce() right after a commit in the SAME task returns the fresh
// value even before the node's relay lands on-chain.
let _taskNonces = {};

// Per-task memo, by key hash, of this task's last commit per key, [acl, data,
// version, cid] as the chain shows them once the node's relay lands. A read
// prefers it while the chain still shows an older version, so get() after
// commit() returns the committed state and a second commit to the key builds
// on the first. The fence sets it to each fenced key's landed state.
let _taskWrites = {};

// Per-task memo of the NEXT relay nonce per key hash, so multiple commits to
// the same key within one task sign sequential relay nonces even while the
// node is still relaying the earlier ones.
let _taskRelayNonces = {};

// The fence's chain reads, the values of the Python securelock's ecld_state:
// getEntriesFrom is paged by ENTRIES_PAGE entries and StateCommitted logs
// are read in spans of at most LOG_RANGE_BLOCKS blocks, inclusive (the LitVM
// LiteForge RPC hosted by Zeeve refuses a wider eth_getLogs range:
// "eth_getLogs range exceeds 3000 blocks; split the range").
const ENTRIES_PAGE = 500;
const LOG_RANGE_BLOCKS = 3000;
// The blocks a replica behind the chain's head may lack (PHASE-D-PLAN.md
// section 12): the state as of the bound is read once the head is this far
// past it, every read of it pinned to head minus this.
const RPC_REPLICA_LAG_BLOCKS = 8;
// How long the fence waits for one key's re-commit to land, polling every
// STATE_STAGE_POLL_MS, before the fence fails.
const FENCE_LANDING_WAIT_MS = 120000;

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

  /** [acl, data, version, cid] for `key`; NO permission check here. */
  async _readContainer(key, fallback = {}) {
    const kh = keyHash(key);
    const [cid, version] = await this._contract().getState(this.walletAddress, kh);
    // This task's last commit of the key serves the read while the chain
    // still shows an older version, and once the chain shows that very
    // commit (its version and CID): the bytes are the ones this enclave
    // encrypted, so the bucket is not consulted for them.
    const own = _taskWrites[kh];
    if (own && (own[2] > Number(version || 0) || (own[2] === Number(version || 0) && own[3] === cid))) {
      return own;
    }
    if (!version || !cid) {
      return [null, fallback, 0, null];
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
    if (stored && typeof stored === 'object' && stored[CONTAINER_MARK] === 1
        && stored.nonce != null) {
      // The blob carries a REPORTING COPY of the idempotency nonce; the chain
      // is primary. Both were written by the same commit (the CID the chain
      // points at IS this blob), so they must agree -- a mismatch means the
      // registry entry and the state object have been tampered with or torn
      // apart. Compare against the RAW chain value (not the task memo): the
      // blob we fetched is the chain's cid.
      const chainNonce = Number(await this._contract().getNonce(this.walletAddress, keyHash(key)));
      const blobNonce = Math.trunc(Number(stored.nonce));
      if (blobNonce !== chainNonce) {
        throw new Error(
          `ESR nonce mismatch for '${key}': the state object reports nonce ` +
            `${blobNonce} but the registry records ${chainNonce} -- refusing ` +
            'to use this state'
        );
      }
    }
    return [acl, data, Number(version), cid];
  }

  /**
   * The last accepted idempotency nonce for `key` (0 if none was ever used).
   * A dApp that wants duplicate suppression reads this and passes
   * getNonce(key) + 1 to commit(..., { nonce }) -- the contract accepts
   * EXACTLY the next value in sequence, nothing else.
   *
   * The nonce is PUBLIC data: the registry records it on-chain next to the
   * version, and anyone can read it with a free eth_call (getNonce) -- so no
   * read-ACL applies here, and web3 clients see the same value via the
   * runner's esrNonce.
   *
   * Reads the chain (authoritative, post-relay), merged with this task's
   * own accepted commits so `commit(..., { nonce: N }); getNonce()` returns N
   * even before the node's relay lands.
   */
  async getNonce(key) {
    const kh = keyHash(key);
    const chain = Number(await this._contract().getNonce(this.walletAddress, kh));
    return Math.max(chain || 0, Number(_taskNonces[kh] || 0));
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
    // also be { attempts, nonce }. The per-key nonce sequence advances by
    // exactly 1 on EVERY commit (1, 2, 3, ... -- no gaps, no reuse; see
    // getNonce).
    //   - Omitted: the SDK takes the next value in sequence automatically.
    //     Always succeeds (subject to permissions/versioning) but carries NO
    //     exactly-once guarantee -- a resubmitted task picks a fresh number.
    //   - Explicit: must be EXACTLY the last accepted nonce + 1, pinned by
    //     the CLIENT before submitting. Anything else throws StateNonceError
    //     (task code 36) and the state is NOT changed.
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
    assertCommitsOpen();
    const made = _esrLedger.length + (_stepHeld ? _stepHeld.length : 0);
    if (made >= MAX_COMMITS_PER_TASK) {
      throw new StateLimitError(
        `this task already made ${made} state commits -- the ` +
          `per-run limit is ${MAX_COMMITS_PER_TASK}. Batch your writes (one ` +
          'commit can update a whole object) or split the work across tasks.'
      );
    }
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [acl, data, currentVersion] = await this._readContainer(key);
      // The nonce check re-runs on every retry against the freshest visible
      // nonce (chain merged with this task's own accepted commits), so a
      // duplicate fails in-enclave with task code 36 instead of as a failed
      // relay. The contract re-enforces the same rule on-chain either way.
      let finalNonce;
      if (nonce != null) {
        finalNonce = Math.trunc(nonce);
        if (finalNonce === 0) {
          throw new StateNonceError(
            `nonce=0 is reserved for 'not set' (the registry then assigns the ` +
              `next value itself) -- omit the nonce on commit('${key}', ...) ` +
              'instead of passing 0. Pinned nonces start at 1: use getNonce() + 1.'
          );
        }
        // eslint-disable-next-line no-await-in-loop
        const storedNonce = await this.getNonce(key);
        if (finalNonce !== storedNonce + 1) {
          throw new StateNonceError(
            `nonce ${finalNonce} is out of sequence for state key '${key}' (last accepted: ` +
              `${storedNonce}, expected: ${storedNonce + 1}); commit suppressed, ` +
              'state unchanged'
          );
        }
      } else {
        // No explicit nonce: the CONTRACT assigns the next value in sequence
        // itself (wire nonce 0 = "omitted"); this predicted value feeds the
        // blob's reporting copy and the task memo. The sequence advances on
        // EVERY commit; only an EXPLICIT nonce carries the exactly-once
        // guarantee (an omitted one is auto-assigned a fresh number, so it
        // cannot deduplicate -- by design).
        // eslint-disable-next-line no-await-in-loop
        finalNonce = (await this.getNonce(key)) + 1;
      }
      // eslint-disable-next-line no-await-in-loop
      const [nextAcl, newData] = await transform(acl, data, currentVersion);
      // The blob carries a REPORTING COPY of the nonce the registry will
      // store for this key after this commit. Chain stays primary; reads
      // verify the two match.
      // Bind the authoring caller into the blob (hence the CID/signature) for
      // owned state.
      const stored = wrapStored(nextAcl, newData, nextAcl ? _taskCaller : null, finalNonce);

      const blob = encrypt(Buffer.from(JSON.stringify(stored), 'utf8'));
      // Compute the CID from OUR bytes — never accept one from the node.
      const cid = unixfsCid(blob);

      // Hand the blob and the CID to the node for pinning. It verifies the CID
      // matches; it does not get to choose it. Fire-and-forget.
      // eslint-disable-next-line no-await-in-loop
      await this._publish(key, blob, cid);

      try {
        // Wire value: the pinned nonce, or 0 = "omitted" -- the contract
        // then assigns the next value atomically on-chain.
        // eslint-disable-next-line no-await-in-loop
        await this._sendCommit(keyHash(key), cid, currentVersion,
          nextAcl ? normAddr(nextAcl.owner) : null,
          nonce != null ? Math.trunc(nonce) : 0);
        // Record the POST-commit values (the DATA -- the ACL never leaves in
        // results): this is what the chain shows once the relay lands.
        ledgerRecord(key, currentVersion + 1, cid, newData);
        const kh = keyHash(key);
        _taskNonces[kh] = finalNonce;
        _taskWrites[kh] = [nextAcl, newData, currentVersion + 1, cid];
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
   *
   * The node stages it as state.<cid>.enc, within seconds of the order's start
   * when the object is pinned on it and as it arrives when it has to fetch it
   * from the network, so the object is looked for every STATE_STAGE_POLL_MS
   * for up to STATE_STAGE_WAIT_MS. state.<key>.enc is the last blob a commit
   * of this key published, which matches only while no later commit was
   * published; one that does not match is passed over.
   */
  async _fetch(key, cid) {
    const deadline = Date.now() + STATE_STAGE_WAIT_MS;
    let mismatched = [];
    for (;;) {
      mismatched = [];
      for (const name of [`state.${cid}.enc`, `state.${key}.enc`]) {
        // eslint-disable-next-line no-await-in-loop
        const data = await _swift.getFileContentBytes(_bucket, name).catch(() => null);
        if (data && data.length) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (unixfsCid(buf) === cid) {
            return buf;
          }
          mismatched.push(name);
        }
      }
      if (Date.now() >= deadline) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, STATE_STAGE_POLL_MS); });
    }
    if (mismatched.length) {
      throw new Error(
        `State object ${mismatched.join(' and ')} does not match the committed CID ${cid} — refusing to use it`
      );
    }
    throw new Error(`Could not read state object for '${key}' (${cid}): not staged within ${STATE_STAGE_WAIT_MS / 1000} s`);
  }

  // Signs the commit and stages it, or holds it while a session step is open
  // (beginStep). A fence re-commit (`fence`) is staged at once as
  // esr.commit.<key16>.<relayNonce>.json whatever the step and outside the
  // ledger: esr.authorizations.json holds the steps' records alone
  // (spec/session-commits.json). Returns the signed authorization record.
  async _sendCommit(keyHashHex, cid, expectedVersion, ownerAddr = null, nonce = 0, fence = false) {
    assertCommitsOpen();
    // The enclave never pays gas and does NO gas math: it SIGNS the commit
    // (commitFor) and stages the signed authorization for the node, which
    // relays it and pays. The trustedzone independently re-prices the whole
    // ledger and adjudicates. Nothing the securelock could claim about cost is
    // trusted, so it claims nothing.
    const signer = this._signer();
    // Lower-case in the record, as the Python securelock writes it; the
    // trustedzone and the node normalise it before use.
    const enclave = (await signer.getAddress()).toLowerCase();
    const contract = this._contract();

    // Relay nonce is PER (enclave, key): same-key commits are strictly
    // serialized network-wide, different keys relay in parallel. Merge the
    // chain value with this task's own staged commits so a second commit to
    // the same key in ONE task signs the next number even before (or while)
    // the node relays the first.
    const khHex = String(keyHashHex).toLowerCase();
    const chainRn = Number(await contract.relayNonce(enclave, keyHashHex));
    const relayNonce = Math.max(chainRn, Number(_taskRelayNonces[khHex] || 0));
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

    _taskRelayNonces[khHex] = Number(relayNonce) + 1;
    if (fence) {
      await _swift.putFileContent(
        _bucket, commitFileName('esr.commit', auth), '',
        Buffer.from(JSON.stringify(auth), 'utf8'));
    } else if (_stepHeld !== null) {
      _stepHeld.push(auth);
    } else {
      _esrLedger.push(auth);
      await writeAuthorizations();
      await _swift.putFileContent(
        _bucket, commitFileName('esr.commit', auth), '',
        Buffer.from(JSON.stringify(auth), 'utf8'));
    }

    // LOCAL TESTING: with no node to relay commitFor, apply the commit to the
    // in-memory registry now so getState/getVersion reflect it. No-op in the
    // real enclave (hook is null) -- there the node applies it on-chain.
    if (_localCommitApply) {
      await _localCommitApply(enclave, keyHashHex, cid, Number(expectedVersion),
        Math.trunc(nonce || 0));
    }

    return auth;
  }

  // Re-commits one key at the state of the bound: the container re-wrapped
  // with the fence's own nonce (getNonce + 1) as a new CID the node pins,
  // published as state.fence.<key16>.enc / .cid as the Python securelock
  // publishes it, signed on the key's current version and relay nonce and
  // staged at once. Re-signs on fresh values whenever another commit lands
  // first (the staged signature then cannot land) until a StateCommitted
  // after the bound names the fence's CID. Returns the landing record.
  async _fenceKey(kh, acl, data, bound) {
    const contract = this._contract();
    const enclave = this.walletAddress;
    const deadline = Date.now() + FENCE_LANDING_WAIT_MS;
    let auth = null;
    let cid = null;
    for (;;) {
      if (auth === null) {
        // eslint-disable-next-line no-await-in-loop
        const version = Number(await contract.getVersion(enclave, kh));
        // eslint-disable-next-line no-await-in-loop
        const nonce = Number(await contract.getNonce(enclave, kh)) + 1;
        const stored = wrapStored(acl, data, _taskCaller, nonce);
        const blob = encrypt(Buffer.from(JSON.stringify(stored), 'utf8'));
        cid = unixfsCid(blob);
        // eslint-disable-next-line no-await-in-loop
        await this._publish(`fence.${kh.slice(2, 18)}`, blob, cid);
        // The relay nonce the chain holds is the one the fence signs: nothing
        // of this task has landed for the key.
        delete _taskRelayNonces[kh];
        // eslint-disable-next-line no-await-in-loop
        auth = await this._sendCommit(kh, cid, version, normAddr(acl.owner), nonce, true);
      }
      // eslint-disable-next-line no-await-in-loop
      const head = Number(await contract.provider.getBlockNumber());
      // eslint-disable-next-line no-await-in-loop
      const logs = await logsInRange(contract, contract.filters.StateCommitted(enclave, kh), bound + 1, head);
      const landed = logs.find((log) => String(log.args.cid) === cid);
      if (landed) {
        _taskNonces[kh] = auth.nonce;
        _taskWrites[kh] = [acl, data, Number(landed.args.version), cid];
        _taskRelayNonces[kh] = Number(auth.relayNonce) + 1;
        return auth;
      }
      // eslint-disable-next-line no-await-in-loop
      const version = Number(await contract.getVersion(enclave, kh));
      // eslint-disable-next-line no-await-in-loop
      const relayNonce = Number(await contract.relayNonce(enclave, kh));
      if (version !== auth.expectedVersion || relayNonce !== auth.relayNonce) {
        auth = null;
        // eslint-disable-next-line no-continue
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`fence: the re-commit of key ${kh} did not land within ${FENCE_LANDING_WAIT_MS / 1000} s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, STATE_STAGE_POLL_MS); });
    }
  }
}

/**
 * The fence (RESERVATION-DESIGN.md section 2), on the trustedzone's signal
 * carrying `bound`: every key of this identity whose container as of the
 * bound names the task caller as owner or write member (the ACL read
 * without a permission check; an unowned container is outside the fence) is
 * re-committed at its state as of the bound, the data and ACL of the key's
 * last StateCommitted at or before the bound, its blob fetched as the node
 * staged it (state.<cid>.enc). A key whose every commit landed after the
 * bound had no state as of it and is left as it is. The state as of the
 * bound is read once the head is RPC_REPLICA_LAG_BLOCKS past it, at that
 * block. Returns the landing record of each key re-committed, in the
 * registry's entry order; nothing without a task caller.
 */
async function fence(bound) {
  const b = Number(bound);
  if (!Number.isInteger(b) || b < 0) throw new Error(`fence: bound ${bound} is not a block number`);
  if (!_taskCaller) return [];
  const reg = new StateRegistry();
  const contract = reg._contract();
  const enclave = reg.walletAddress;
  const readAt = await settledBlock(contract, b);
  const atBound = await commitsAtOrBefore(contract, enclave, b, readAt);
  const fenced = [];
  for (const [kh, last] of atBound) {
    // eslint-disable-next-line no-await-in-loop
    const blob = await reg._fetch(kh.slice(2), last.cid);
    const stored = JSON.parse(decrypt(blob).toString('utf8'));
    const [acl, data] = unwrapStored(stored);
    if (!fenceWritable(acl)) continue;
    // eslint-disable-next-line no-await-in-loop
    fenced.push(await reg._fenceKey(kh, acl, data, b));
  }
  return fenced;
}

// The StateCommitted logs of `filter` in [from, to], as queryFilter answers
// them, read forward in spans of at most LOG_RANGE_BLOCKS blocks.
async function logsInRange(contract, filter, from, to) {
  const logs = [];
  for (let lo = from; lo <= to; lo += LOG_RANGE_BLOCKS) {
    const hi = Math.min(lo + LOG_RANGE_BLOCKS - 1, to);
    // eslint-disable-next-line no-await-in-loop
    logs.push(...await contract.queryFilter(filter, lo, hi));
  }
  return logs;
}

// The first block at or after `bound` that is RPC_REPLICA_LAG_BLOCKS behind
// the head, polled every STATE_STAGE_POLL_MS until the head is that far past
// the bound: the block every read of the state as of the bound is pinned to,
// so a replica behind the head answers the logs and the versions alike.
async function settledBlock(contract, bound) {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const head = Number(await contract.provider.getBlockNumber());
    if (head - RPC_REPLICA_LAG_BLOCKS >= bound) return head - RPC_REPLICA_LAG_BLOCKS;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, STATE_STAGE_POLL_MS); });
  }
}

// The identity's keys, by hash, with their version as of `readAt` (the
// number of commits landed to each by then), from the registry's entry
// enumeration.
async function identityKeys(contract, enclave, readAt) {
  const wanted = String(enclave).toLowerCase();
  const keys = new Map();
  for (let start = 0; ; start += ENTRIES_PAGE) {
    // eslint-disable-next-line no-await-in-loop
    const page = await contract.getEntriesFrom(start, ENTRIES_PAGE, { blockTag: readAt });
    for (let i = 0; i < page.enclaves.length; i += 1) {
      if (String(page.enclaves[i]).toLowerCase() === wanted) {
        keys.set(String(page.keys[i]).toLowerCase(), Number(page.versions[i]));
      }
    }
    if (page.enclaves.length === 0 || start + page.enclaves.length >= Number(page.total)) break;
  }
  return keys;
}

// The last StateCommitted at or before `bound` of every key of the identity
// that has one, as Map(keyHash -> { cid, version, block }) in the registry's
// entry order (first commit first), every read at block `readAt`. The
// commits in (bound, readAt] are counted first, so a key whose version at
// readAt equals that count has no state as of the bound and is not looked
// for; the others are read from the bound backwards in LOG_RANGE_BLOCKS
// spans until each is found.
async function commitsAtOrBefore(contract, enclave, bound, readAt) {
  const after = new Map();
  for (const log of await logsInRange(contract, contract.filters.StateCommitted(enclave), bound + 1, readAt)) {
    const kh = String(log.args.key).toLowerCase();
    after.set(kh, (after.get(kh) || 0) + 1);
  }
  const keys = await identityKeys(contract, enclave, readAt);
  const need = new Set();
  for (const [kh, version] of keys) {
    if (version - (after.get(kh) || 0) > 0) need.add(kh);
  }
  const found = new Map();
  let to = bound;
  while (need.size > 0) {
    const from = Math.max(0, to - LOG_RANGE_BLOCKS + 1);
    // eslint-disable-next-line no-await-in-loop
    const logs = await logsInRange(contract, contract.filters.StateCommitted(enclave), from, to);
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      const kh = String(logs[i].args.key).toLowerCase();
      if (!need.has(kh)) continue;
      found.set(kh, { cid: String(logs[i].args.cid), version: Number(logs[i].args.version), block: logs[i].blockNumber });
      need.delete(kh);
    }
    if (from === 0) break;
    to = from - 1;
  }
  const ordered = new Map();
  for (const kh of keys.keys()) {
    if (found.has(kh)) ordered.set(kh, found.get(kh));
  }
  return ordered;
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
  ledgerAttestation,
  writeAuthorizations,
  beginStep,
  takeStepCommits,
  discardStepCommits,
  flushStepCommits,
  closeCommits,
  commitFileName,
  fence,
  StatePermissionError,
  StateNonceError,
  StateLimitError,
  unixfsCid,
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
