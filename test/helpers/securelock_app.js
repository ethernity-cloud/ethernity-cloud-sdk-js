// Test doubles for the nodenithy securelock's session executor: a stand-in
// for etny_crypto (its signData / verifySignature, ECDSA P-384 over SHA-256
// with the DER signature in hex, on node's own crypto: the securelock's
// jsrsasign, ec-key and ascii85 are dependencies of the enclave image, not of
// this package), P-384 key pairs, and a StubApp that holds the securelock's
// state the executor reads (bucket, binding, caller, keys, probe) and stores
// the objects it pushes in the clear in esr_local's MemSwift.
'use strict';

const crypto = require('crypto');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'nodenithy', 'build', 'securelock', 'src');
const CRYPTO_MODULE = path.join(SRC, 'etny_crypto.js');

function pem(value) {
  const v = String(value || '');
  return v.includes('-----BEGIN') ? v : require('fs').readFileSync(v, 'utf8');
}

const cryptoStub = {
  signData(privateKeyOrFile, data) {
    return crypto.sign('sha256', Buffer.from(String(data), 'utf8'), pem(privateKeyOrFile)).toString('hex');
  },
  verifySignature(certOrPublicKeyPem, data, sigHex) {
    try {
      return crypto.verify('sha256', Buffer.from(String(data), 'utf8'), pem(certOrPublicKeyPem), Buffer.from(String(sigHex), 'hex'));
    } catch (e) {
      return false;
    }
  },
  sha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  },
};

// Puts the stub in the require cache under etny_crypto's path and drops the
// cached securelock modules, so the next require of any of them loads fresh
// against the stub.
function freshModules() {
  for (const name of ['ecld_state.js', 'esr_local.js', 'etny_exec.js', 'etny_session_exec.js', 'securelock_probe.js', 'task_status.js']) {
    delete require.cache[path.join(SRC, name)];
  }
  const m = new (require('module').Module)(CRYPTO_MODULE, null);
  m.filename = CRYPTO_MODULE;
  m.loaded = true;
  m.exports = cryptoStub;
  require.cache[CRYPTO_MODULE] = m;
  return {
    ecldState: require(path.join(SRC, 'ecld_state.js')),
    esrLocal: require(path.join(SRC, 'esr_local.js')),
    sessionExec: require(path.join(SRC, 'etny_session_exec.js')),
    probe: require(path.join(SRC, 'securelock_probe.js')),
    TaskStatus: require(path.join(SRC, 'task_status.js')).TaskStatus,
  };
}

function p384KeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

class StubApp {
  constructor({ swift, bucket, orderId, challenge, caller, trustedzone, securelock }) {
    this.swiftStreamService = swift;
    this.etny_bucket = bucket;
    this.task_binding = { order_id: Number(orderId), challenge };
    this.task_caller = caller;
    this.trustedzone = trustedzone;
    this.securelock = securelock;
    this.trustedZonePublicKey = trustedzone.publicKeyPem;
    this.probe = null;
  }

  privateKeyMaterial() {
    return this.securelock.privateKeyPem;
  }

  async getTrustedZonePublicKey() {}

  // The securelock's put for the trustedzone, stored in the clear.
  async encryptFileAndPushToSwiftStream(data, name) {
    await this.swiftStreamService.putFileContent(this.etny_bucket, `${name}.securelock`, '', String(data));
  }

  async getFileContentAndDecrypt(bucket, name) {
    const v = await this.swiftStreamService.getFileContent(bucket, name);
    return v === null ? false : v;
  }

  // The trustedzone's staging of a signed object: the signature before the
  // data, over `binding` + data (the plain data for session.config,
  // session.input.<n> and session.control).
  async stageFromTrustedzone(data, baseName, { binding = '', signer = this.trustedzone } = {}) {
    const sig = cryptoStub.signData(signer.privateKeyPem, binding + data);
    await this.swiftStreamService.putFileContent(this.etny_bucket, `${baseName}.sig.securelock`, '', sig);
    await this.swiftStreamService.putFileContent(this.etny_bucket, `${baseName}.securelock`, '', data);
  }

  async object(name) {
    return this.swiftStreamService.getFileContent(this.etny_bucket, name);
  }

  async names() {
    return objectNames(this.swiftStreamService, this.etny_bucket);
  }
}

// The object names a MemSwift holds in `bucket`, in insertion order.
function objectNames(swift, bucket) {
  const prefix = `${bucket}/`;
  return [...swift._store.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

// Lets started work run up to its next timer.
async function settle(turns = 64) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

module.exports = { SRC, cryptoStub, freshModules, p384KeyPair, StubApp, objectNames, settle };
