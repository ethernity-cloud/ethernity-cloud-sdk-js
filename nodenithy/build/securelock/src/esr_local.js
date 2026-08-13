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
 *                  (getState / getVersion / relayNonce / commitDigest) plus the
 *                  commit APPLY the node would do on-chain, keyed by
 *                  (enclave, keyHash) -> { cid, version }.
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

  async createBucket() { return true; }
}

class MemContract {
  constructor(file) {
    this._file = file || null;
    this._entries = {};   // key -> { cid, version, updatedAt }
    this._nonce = {};     // enclave -> n
    if (this._file && fs.existsSync(this._file)) {
      try {
        const d = JSON.parse(fs.readFileSync(this._file, 'utf8'));
        this._entries = d.entries || {};
        this._nonce = d.nonce || {};
      } catch (e) { /* start empty */ }
    }
  }

  _persist() {
    if (!this._file) return;
    try {
      fs.writeFileSync(this._file + '.tmp', JSON.stringify({ entries: this._entries, nonce: this._nonce }));
      fs.renameSync(this._file + '.tmp', this._file);
    } catch (e) { /* best-effort */ }
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

  async relayNonce(enclave) {
    return ethers.BigNumber.from(this._nonce[String(enclave).toLowerCase()] || 0);
  }

  async commitDigest(enclave, keyHash, cid, expectedVersion, relayNonce) {
    // Deterministic 32-byte digest (no real signing needed locally; the
    // securelock still signs it with the local test key).
    return ethers.utils.id(JSON.stringify([String(enclave).toLowerCase(), keyHash, cid,
      Number(expectedVersion), Number(relayNonce)]));
  }

  async entryCount() {
    return ethers.BigNumber.from(Object.keys(this._entries).length);
  }

  // ---- the on-chain commitFor, applied locally ----
  applyCommit(enclave, keyHash, cid, expectedVersion) {
    const k = key(enclave, keyHash);
    const cur = this._entries[k] ? Number(this._entries[k].version) : 0;
    if (Number(expectedVersion) !== cur) {
      throw new Error(`VersionMismatch: expected ${expectedVersion} but current is ${cur}`);
    }
    this._entries[k] = { cid, version: cur + 1, updatedAt: 0 };
    const e = String(enclave).toLowerCase();
    this._nonce[e] = (this._nonce[e] || 0) + 1;
    this._persist();
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
    (enclave, keyHash, cid, expectedVersion) =>
      contract.applyCommit(enclave, keyHash, cid, expectedVersion));

  return { swift, contract };
}

module.exports = { install, MemSwift, MemContract };
