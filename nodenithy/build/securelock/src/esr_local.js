/**
 * Local ESR emulator for `ecld-test` -- run state-using backends with no chain.
 *
 * In-memory stand-ins for the two external things StateRegistry talks to, so
 * get/commit/esrGrant/... behave EXACTLY as on-chain but in-process, instantly,
 * with zero orders and zero gas:
 *
 *   MemSwift    -- state-blob store (replaces SwiftStream): putFileContent /
 *                  getFileContentBytes over a Map, optionally mirrored to a JSON
 *                  file so state survives across `ecld-test` runs.
 *   MemContract -- the ESR contract methods StateRegistry calls
 *                  (getState / getVersion / relayNonce / commitDigest), the
 *                  enumeration (getEntriesFrom / entryCount / commitSeq), the
 *                  StateCommitted logs (filters.StateCommitted + queryFilter,
 *                  as ethers.Contract serves them), the chain head
 *                  (provider.getBlockNumber) plus the commit APPLY the node
 *                  would do on-chain, keyed by (enclave, keyHash) ->
 *                  { cid, version }. A commit lands at the emulator's current
 *                  block; landAt(block) moves the landings that follow.
 *
 * install(ecldState, { caller, filePrefix }) wires these into ecld_state via its
 * local-testing hooks. Used only by the local test harness; the real enclave
 * never requires this file.
 */

'use strict';

const fs = require('fs');
const { ethers } = require('ethers');

function key(enclave, keyHash) {
  return `${String(enclave).toLowerCase()}|${String(keyHash).toLowerCase()}`;
}

class MemSwift {
  constructor(file) {
    this._file = file || null;
    this._store = new Map();
    if (this._file && fs.existsSync(this._file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
        for (const [k, v] of Object.entries(raw)) this._store.set(k, Buffer.from(v, 'base64'));
      } catch (e) { /* start empty */ }
    }
  }

  _persist() {
    if (!this._file) return;
    try {
      const obj = {};
      for (const [k, v] of this._store) obj[k] = Buffer.from(v).toString('base64');
      fs.writeFileSync(this._file + '.tmp', JSON.stringify(obj));
      fs.renameSync(this._file + '.tmp', this._file);
    } catch (e) { /* best-effort */ }
  }

  async putFileContent(bucket, name, _prefix, data) {
    const buf = Buffer.isBuffer(data) ? data
      : (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
    this._store.set(`${bucket}/${name}`, buf);
    this._persist();
    return true;
  }

  async getFileContentBytes(bucket, name) {
    const v = this._store.get(`${bucket}/${name}`);
    return v === undefined ? null : v;
  }

  async getFileContent(bucket, name) {
    const v = await this.getFileContentBytes(bucket, name);
    return v === null ? null : v.toString('utf8');
  }

  /** [stat, present], as SwiftStreamService answers it. */
  async isObjectInBucket(bucket, name) {
    return [null, this._store.has(`${bucket}/${name}`)];
  }

  async createBucket() { return true; }
}

class MemContract {
  constructor(file) {
    this._file = file || null;
    // key -> { enclave, keyHash, cid, version, updatedAt, nonce }, in
    // first-commit order: the contract's append-only entry list.
    this._entries = {};
    this._nonce = {};     // key -> relay nonce, advanced on every landing
    this._logs = [];      // every StateCommitted, in landing order
    this._block = 1;      // the chain head: the block the next commit lands in
    this._seq = 0;        // the contract's commitSeq
    if (this._file && fs.existsSync(this._file)) {
      try {
        const d = JSON.parse(fs.readFileSync(this._file, 'utf8'));
        this._entries = d.entries || {};
        this._nonce = d.nonce || {};
        this._logs = d.logs || [];
        this._block = Number(d.block || 1);
        this._seq = Number(d.seq || this._logs.length);
      } catch (e) { /* start empty */ }
    }
    this.filters = {
      StateCommitted: (enclave = null, keyHash = null) => ({ event: 'StateCommitted', enclave, keyHash }),
    };
    // The chain head, as ethers.Contract.provider.getBlockNumber answers it.
    this.provider = { getBlockNumber: async () => this._block };
  }

  _persist() {
    if (!this._file) return;
    try {
      fs.writeFileSync(this._file + '.tmp', JSON.stringify({
        entries: this._entries, nonce: this._nonce, logs: this._logs, block: this._block, seq: this._seq,
      }));
      fs.renameSync(this._file + '.tmp', this._file);
    } catch (e) { /* best-effort */ }
  }

  /** The block the next commit lands in. */
  get blockNumber() {
    return this._block;
  }

  /**
   * Lands every later commit at `block`, at or after the current one: the
   * emulator's chain never goes back.
   */
  landAt(block) {
    const b = Number(block);
    if (!Number.isInteger(b)) {
      throw new Error(`landAt: block ${block} is not an integer`);
    }
    if (b < this._block) {
      throw new Error(`landAt: block ${block} is before the current block ${this._block}`);
    }
    this._block = b;
    this._persist();
  }

  /**
   * The StateCommitted events of [fromBlock, toBlock], as ethers.Contract
   * returns them: { blockNumber, transactionHash, logIndex, event, args }, args
   * holding enclave, key, cid, version, seq, nonce by name and by position. A
   * null filter argument matches every value, as an unset indexed topic does.
   */
  async queryFilter(filter, fromBlock = 0, toBlock = 'latest') {
    const from = Number(fromBlock || 0);
    const to = (toBlock === 'latest' || toBlock === undefined || toBlock === null) ? this._block : Number(toBlock);
    const wantEnclave = filter && filter.enclave ? String(filter.enclave).toLowerCase() : null;
    const wantKey = filter && filter.keyHash ? String(filter.keyHash).toLowerCase() : null;
    const events = [];
    for (const log of this._logs) {
      if (log.blockNumber < from || log.blockNumber > to) continue;
      if (wantEnclave && log.enclave.toLowerCase() !== wantEnclave) continue;
      if (wantKey && log.keyHash.toLowerCase() !== wantKey) continue;
      const version = ethers.BigNumber.from(log.version);
      const seq = ethers.BigNumber.from(log.seq);
      const nonce = ethers.BigNumber.from(log.nonce);
      const args = Object.assign([log.enclave, log.keyHash, log.cid, version, seq, nonce], {
        enclave: log.enclave, key: log.keyHash, cid: log.cid, version, seq, nonce,
      });
      events.push({
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        event: 'StateCommitted',
        args,
      });
    }
    return events;
  }

  /** The contract's commitSeq: the number of commits ever landed. */
  async commitSeq() {
    return ethers.BigNumber.from(this._seq);
  }

  /** The (enclave, key) at `index` of the first-commit-ordered entry list. */
  async entryAt(index) {
    const all = Object.entries(this._entries);
    const i = Number(index);
    if (!(i >= 0 && i < all.length)) throw new Error(`entryAt: index ${index} is out of range (${all.length} entries)`);
    const [k, e] = all[i];
    const [enclave, keyHash] = k.split('|');
    const pair = [e.enclave || enclave, e.keyHash || keyHash];
    return Object.assign(pair, { enclave: pair[0], key: pair[1] });
  }

  /**
   * The entries [startIndex, startIndex + limit) in first-commit order, as the
   * contract returns them: enclaves, keys, cids, versions, updatedAts, total,
   * by name and by position; empty arrays past the end or for limit 0.
   */
  async getEntriesFrom(startIndex, limit) {
    const all = Object.entries(this._entries);
    const total = ethers.BigNumber.from(all.length);
    const start = Number(startIndex);
    const n = Number(limit);
    const page = (start >= all.length || n === 0) ? [] : all.slice(start, Math.min(all.length, start + n));
    const enclaves = [];
    const keys = [];
    const cids = [];
    const versions = [];
    const updatedAts = [];
    for (const [k, e] of page) {
      const [enclave, keyHash] = k.split('|');
      enclaves.push(e.enclave || enclave);
      keys.push(e.keyHash || keyHash);
      cids.push(e.cid);
      versions.push(ethers.BigNumber.from(e.version));
      updatedAts.push(ethers.BigNumber.from(e.updatedAt || 0));
    }
    return Object.assign([enclaves, keys, cids, versions, updatedAts, total], {
      enclaves, keys, cids, versions, updatedAts, total,
    });
  }

  // ---- the ethers.Contract methods StateRegistry calls ----
  async getState(enclave, keyHash) {
    const e = this._entries[key(enclave, keyHash)];
    if (!e) return ['', ethers.BigNumber.from(0), ethers.BigNumber.from(0)];
    return [e.cid, ethers.BigNumber.from(e.version), ethers.BigNumber.from(e.updatedAt || 0)];
  }

  async getVersion(enclave, keyHash) {
    const e = this._entries[key(enclave, keyHash)];
    return ethers.BigNumber.from(e ? e.version : 0);
  }

  async relayNonce(enclave, keyHash) {
    // Per (enclave, key), like the contract: same-key commits serialize,
    // different keys are independent.
    return ethers.BigNumber.from(this._nonce[key(enclave, keyHash)] || 0);
  }

  async commitDigest(enclave, keyHash, cid, expectedVersion, relayNonce, nonce = 0) {
    // Deterministic 32-byte digest (no real signing needed locally; the
    // securelock still signs it with the local test key). The idempotency
    // nonce is part of the digest, like on-chain.
    return ethers.utils.id(JSON.stringify([String(enclave).toLowerCase(), keyHash, cid,
      Number(expectedVersion), Number(relayNonce), Number(nonce || 0)]));
  }

  /** Last accepted idempotency nonce for (enclave, key) -- public data,
   * mirroring the on-chain getNonce view. */
  async getNonce(enclave, keyHash) {
    const e = this._entries[key(enclave, keyHash)];
    return ethers.BigNumber.from(e && e.nonce ? e.nonce : 0);
  }

  async entryCount() {
    return ethers.BigNumber.from(Object.keys(this._entries).length);
  }

  // ---- the on-chain commitFor, applied locally ----
  // The per-key nonce advances by EXACTLY 1 on every commit, like the
  // contract: nonce == 0 ("omitted") gets the next value assigned by the
  // registry itself; a non-zero nonce is a client-pinned guard and must be
  // EXACTLY the stored value + 1 (no gaps, no reuse) or NonceOutOfOrder.
  // The landing advances the relay nonce, stamps the next commitSeq and emits
  // StateCommitted(enclave, key, cid, version, seq, effective nonce) in the
  // current block, as the contract does.
  applyCommit(enclave, keyHash, cid, expectedVersion, nonce = 0) {
    const k = key(enclave, keyHash);
    const entry = this._entries[k] || {};
    const cur = entry.version ? Number(entry.version) : 0;
    if (Number(expectedVersion) !== cur) {
      throw new Error(`VersionMismatch: expected ${expectedVersion} but current is ${cur}`);
    }
    let storedNonce = Number(entry.nonce || 0);
    const n = Number(nonce || 0);
    if (n === 0) {
      storedNonce += 1;
    } else {
      if (n !== storedNonce + 1) {
        throw new Error(`NonceOutOfOrder: stored ${storedNonce}, given ${n}`);
      }
      storedNonce = n;
    }
    this._entries[k] = { enclave, keyHash, cid, version: cur + 1, updatedAt: 0, nonce: storedNonce };
    this._nonce[k] = (this._nonce[k] || 0) + 1;
    this._seq += 1;
    this._logs.push({
      enclave,
      keyHash,
      cid,
      version: cur + 1,
      seq: this._seq,
      nonce: storedNonce,
      blockNumber: this._block,
      transactionHash: ethers.utils.id(`esr-local-commit-${this._seq}`),
      logIndex: this._logs.filter((l) => l.blockNumber === this._block).length,
    });
    this._persist();
  }

  // ---- the node's relay of a staged esr.commit.<key16>.<relayNonce>.json ----
  // commitFor: the authorization's relayNonce must equal the registry's relay
  // nonce for (enclave, key) or RelayNonceMismatch is thrown and nothing
  // changes; then the commit applies as applyCommit does.
  relay(auth) {
    const expected = Number(this._nonce[key(auth.enclave, auth.keyHash)] || 0);
    const given = Number(auth.relayNonce);
    if (given !== expected) {
      throw new Error(`RelayNonceMismatch: expected ${expected}, given ${given}`);
    }
    this.applyCommit(auth.enclave, auth.keyHash, auth.cid, Number(auth.expectedVersion), Number(auth.nonce || 0));
  }
}

// A fixed local test identity so walletAddress is stable across runs.
const LOCAL_IDENTITY = Buffer.from('ecld-local-test-identity-key-0001');

function install(ecldState, { caller = null, filePrefix = '.ecld-esr-local' } = {}) {
  const swiftFile = filePrefix ? `${filePrefix}.swift.json` : null;
  const regFile = filePrefix ? `${filePrefix}.registry.json` : null;
  const swift = new MemSwift(swiftFile);
  const contract = new MemContract(regFile);

  ecldState.configure({
    identityPriv: LOCAL_IDENTITY,
    swiftStreamService: swift,
    bucket: 'ecld-local',
    contractAddress: '0xLOCAL',
    provider: null,
    caller,
  });
  ecldState.setContractOverride(contract);
  ecldState.setLocalCommitApply(
    (enclave, keyHash, cid, expectedVersion, nonce = 0) =>
      contract.applyCommit(enclave, keyHash, cid, expectedVersion, nonce));

  return { swift, contract };
}

module.exports = { install, MemSwift, MemContract };
