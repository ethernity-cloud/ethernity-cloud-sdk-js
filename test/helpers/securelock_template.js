// The nodenithy securelock's template off SGX, for the tests that run it, and
// stand-ins for what the enclave reaches outside its process.
//
// securelock.js.tmpl starts its run at load and carries the build's tokens:
// its text is read, the tokens are rendered (a testnet_cas network without a
// ValidatorRegistry), the statement that starts the run is exported as
// main(), and the rest is compiled with a require that resolves from the
// securelock's src/ and a process of the test's own (its environment, the
// handlers the template registers, its exit code). etny_crypto is stood in
// for by securelock_app.js's signatures and the AES-256-GCM sealing below,
// the object store by esr_local's MemSwift, SwiftStreamService by a class
// that answers the test's store, or by the module a test names for it.
//
// The securelock's own swift_stream_service.js requires the minio package, a
// dependency of the enclave image and not of this package: storeService
// compiles it over a MinioStandIn, whose clients record the options they are
// constructed with and the calls made on them. withCredentialFile opens a
// file of the test where the template's credential reader opens
// /run/ecld/store.json.
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const Module = require('module');
const { EventEmitter } = require('events');
const { SRC, cryptoStub, freshModules, p384KeyPair } = require('./securelock_app');
const { STORE_CREDENTIAL_PATH } = require(path.join(SRC, 'store_credential.js'));

const TEMPLATE = path.join(SRC, 'securelock.js.tmpl');
const BUCKET = 'etny-suite-v3';
const ORDER_ID = 4101;
const CHALLENGE = 'k7p2x9qv4m1zr8t3hw6n';
const RENDERED = Object.freeze({
  __ETNY_NETWORK_TYPE__: 'testnet_cas',
  __ETNY_BUCKET__: BUCKET,
  __ENCLAVE_NAME_SECURELOCK__: 'etny-suite-securelock',
  __ETNY_SMART_CONTRACT_ADDRESS__: '0x00000000000000000000000000000000000000A1',
  __ETNY_IMAGE_REGISTRY_ADDRESS__: '0x00000000000000000000000000000000000000B2',
  __ETNY_VALIDATOR_REGISTRY_ADDRESS__: '',
  __ETNY_CHAIN_ID__: '8995',
  __ETNY_WEB3_PROVIDER__: 'http://rpc.invalid',
});
// The statement at the end of the template that starts the run.
const START = '\n(async () => {\n    let failed = false;';
const METHODS = ['log', 'info', 'debug', 'error', 'warn', 'trace', 'dir'];

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// etny_crypto's sealing on node's crypto: AES-256-GCM under the SHA-256 of
// the recipient's public key (SPKI DER), the tuple stored as base64 JSON as
// the enclaves store it. encrypt reads its message as etny_crypto's
// encrypt_ecc does (cipher.update(message, 'utf8', 'hex')), so a message
// that is not text throws as it does there; decrypt answers false for an
// object that does not open, with etny_crypto's fixed log line.
const sealKey = (keyPem) => crypto.createHash('sha256')
  .update(crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' })).digest();
const sealing = {
  encrypt(certificate, message) {
    const nonce = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(certificate), nonce);
    let ciphertext = cipher.update(message, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    return { ciphertext, nonce, authTag: cipher.getAuthTag().toString('hex') };
  },
  encryptedDataToBase64Json(m) {
    return Buffer.from(JSON.stringify({ ciphertext: m.ciphertext, nonce: m.nonce.toString('hex'), authTag: m.authTag }), 'utf8').toString('base64');
  },
  encryptedDataFromBase64Json(base64Data) {
    return JSON.parse(Buffer.from(base64Data, 'base64').toString('utf8'));
  },
  decrypt(privateKeyPem, m) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(privateKeyPem), Buffer.from(m.nonce, 'hex'));
      decipher.setAuthTag(Buffer.from(m.authTag, 'hex'));
      return decipher.update(m.ciphertext, 'hex', 'utf8') + decipher.final('utf8');
    } catch (e) {
      console.log('Error while decrypting ECC');
      return false;
    }
  },
  // The data owner's encryption: the data read as Buffer.from reads it, as
  // etny_crypto's encryptWithPublicKey reads it.
  encryptWithPublicKey(publicKey, data) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(String(publicKey)).digest(), nonce);
    return Buffer.concat([nonce, cipher.update(Buffer.from(data)), cipher.final(), cipher.getAuthTag()]);
  },
};
const sealed = (publicPem, text) => sealing.encryptedDataToBase64Json(sealing.encrypt(publicPem, text));
const opened = (privatePem, stored) => sealing.decrypt(privatePem, sealing.encryptedDataFromBase64Json(String(stored)));

// The template compiled off SGX: its EtnySecureLock, reportFailure, execute
// (the run) and main() (the statement that starts the run), the process it
// was given, and the securelock modules it loaded. `store()` answers each
// construction of SwiftStreamService; `modules` maps a name the template
// requires to what that require answers in the place of src/'s module.
function loadTemplate({ store = null, modules = {} } = {}) {
  const mods = freshModules();
  let source = fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
  for (const [token, value] of Object.entries(RENDERED)) source = source.split(token).join(value);
  assert.ok(!/__[A-Z][A-Z0-9_]*__/.test(source), 'every token of the template is rendered');
  const start = source.lastIndexOf(START);
  assert.notEqual(start, -1, 'the template ends with the statement that starts the run');
  const tail = source.slice(start + 1);
  const end = tail.lastIndexOf('})();');
  assert.equal(tail.slice(end).trim(), '})();');
  source = `${source.slice(0, start)}\nmodule.exports = { EtnySecureLock, reportFailure, execute, main: ${tail.slice(1, end + 1)} };\n`;

  const storeOf = store || (() => new mods.esrLocal.MemSwift());
  const standIns = {
    dotenv: { config: () => ({}), parse: require('dotenv').parse },
    './etny_crypto': { ...cryptoStub, ...sealing },
    './swift_stream_service': class SwiftStreamService {
      constructor() { return storeOf(); }
    },
    './self_sign': { generateCertFromMrEnclave() { throw new Error('no SGX report off the enclave'); } },
    ...modules,
  };
  const fromSrc = Module.createRequire(path.join(SRC, 'securelock.js'));
  const requireOf = (name) => (Object.prototype.hasOwnProperty.call(standIns, name) ? standIns[name] : fromSrc(name));
  const handlers = {};
  const proc = {
    env: {},
    handlers,
    exitCode: undefined,
    on(event, fn) { handlers[event] = fn; return proc; },
    exit(code) { proc.exited = code; },
  };
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', source)(
    requireOf, compiled, compiled.exports, path.join(SRC, 'securelock.js'), SRC, proc);
  return { ...compiled.exports, process: proc, mods };
}

// Every securelock `L` constructs from here on reads its certificate from
// cert.pem of `directory` and writes enclave_pub_cert.pem there, the file
// savePublicCert puts as cert.pem, in the place of the enclave's /app paths.
function certificateIn(L, directory) {
  const { setInitializers } = L.EtnySecureLock.prototype;
  L.EtnySecureLock.prototype.setInitializers = function setInitializersIn() {
    setInitializers.call(this);
    this.cert_file = path.join(directory, 'cert.pem');
    this.pub_cert_file = path.join(directory, 'enclave_pub_cert.pem');
  };
}

// fn()'s value and every text console wrote while it ran, each method's
// arguments formatted as console formats them.
async function written(fn) {
  const lines = [];
  const saved = Object.fromEntries(METHODS.map((name) => [name, console[name]]));
  for (const name of METHODS) console[name] = (...args) => { lines.push(util.format(...args)); };
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

// An order handed to the template's securelock: the payload and the input
// sealed for it and signed by the trustedzone, the order metadata their
// checksums, the task binding the trustedzone's. The securelock is
// constructed over `swift`, whose objects `objects` maps from
// "<bucket>/<name>" (esr_local's MemSwift and its _store when not given).
// forward() puts an object and its signature as the trustedzone forwards
// the payload, the input and the caller (<name>, <name>.sig); stage() puts a
// session object as the trustedzone stages it, signed over the plain text.
function order({ payload, input, store = null, modules = {}, swift = null, objects = null } = {}) {
  const L = loadTemplate({ store, modules });
  const appStore = swift || new L.mods.esrLocal.MemSwift();
  const held = objects || appStore._store;
  const tz = p384KeyPair();
  const sl = p384KeyPair();
  const app = new L.EtnySecureLock(appStore);
  app.identity_private_key_pem = sl.privateKeyPem;
  app.trustedZonePublicKey = tz.publicKeyPem;
  app.image_registry = { getLatestTrustedZoneImageCertPublicKey: async () => ['v3', tz.publicKeyPem] };
  app.task_binding = { order_id: ORDER_ID, challenge: CHALLENGE };
  app._metadata = {
    image_metadata: 'v3:QmSecurelock:etny-suite-trustedzone',
    payload_metadata_obj: { has_checksum: true, checksum: sha256(payload) },
    input_metadata_obj: { has_checksum: true, checksum: sha256(input), ipfs_hash: 'QmInput' },
    public_key: `0x${'42'.repeat(32)}`,
  };
  const put = (name, text) => { held.set(`${BUCKET}/${name}`, Buffer.from(text, 'utf8')); };
  const get = (name) => {
    const v = held.get(`${BUCKET}/${name}`);
    return v === undefined ? undefined : v.toString('utf8');
  };
  const forward = (name, text) => {
    put(name, sealed(sl.publicKeyPem, text));
    put(`${name}.sig`, sealed(sl.publicKeyPem, cryptoStub.signData(tz.privateKeyPem, text)));
  };
  forward('payload.etny.securelock', payload);
  forward('input.txt.securelock', input);
  const stage = (base, text) => {
    put(`${base}.sig.securelock`, sealed(sl.publicKeyPem, cryptoStub.signData(tz.privateKeyPem, text)));
    put(`${base}.securelock`, sealed(sl.publicKeyPem, text));
  };
  // The store puts the objects of session object `from` in the place of `to`.
  const copy = (from, to) => {
    put(`${to}.sig.securelock`, get(`${from}.sig.securelock`));
    put(`${to}.securelock`, get(`${from}.securelock`));
  };
  return { ...L, app, swift: appStore, tz, sl, get, forward, stage, copy };
}

// The error minio-js makes of a store's answer: each element of the answer's
// XML is a property of the error, its name in lower case.
class S3Error extends Error {}

// A stream of one chunk, as getObject's callback takes it. The chunk and the
// end are delivered in a microtask: the tests advance the securelock by
// microtask turns under mocked timers.
function chunkStream(chunk) {
  const stream = new EventEmitter();
  Promise.resolve().then(() => {
    stream.emit('data', chunk);
    stream.emit('end');
  });
  return stream;
}

// A stand-in for the minio package. A Client records the options it is
// constructed with (clients) and each call made on it (calls: the method,
// the bucket and, for an object, its name), and keeps the objects put, by
// "<bucket>/<name>" (objects). It has the five methods the securelock's
// SwiftStreamService calls and answers them as minio-js 7.1 does: every
// bucket exists, the presence check of an absent object ends in an error of
// code NotFound, the get of one in NoSuchKey. With `refuse` set every call
// ends in the error of a store that answers InvalidAccessKeyId and names the
// request's access key (the AWSAccessKeyId element of S3's answer).
class MinioStandIn {
  constructor() {
    this.refuse = false;
    this.clients = [];
    this.calls = [];
    this.objects = new Map();
    const store = this;
    this.Client = class Client {
      constructor(options) {
        this.options = options;
        store.clients.push(options);
      }

      bucketExists(bucket, done) {
        const refusal = store.asked(this, ['bucketExists', bucket]);
        return refusal ? done(refusal) : done(null, true);
      }

      makeBucket(bucket, done) {
        const refusal = store.asked(this, ['makeBucket', bucket]);
        return refusal ? done(refusal) : done(null);
      }

      getObject(bucket, name, done) {
        const refusal = store.asked(this, ['getObject', bucket, name]);
        if (refusal) return done(refusal);
        const held = store.objects.get(`${bucket}/${name}`);
        if (held === undefined) {
          return done(Object.assign(new S3Error('The specified key does not exist.'), { code: 'NoSuchKey', key: name, bucketname: bucket }));
        }
        return done(null, chunkStream(held));
      }

      // putObject(bucket, name, data, done) for a string or a Buffer,
      // putObject(bucket, name, stream, size, done) for a stream.
      putObject(bucket, name, data, size, callback) {
        const done = typeof size === 'function' ? size : callback;
        const refusal = store.asked(this, ['putObject', bucket, name]);
        const stream = typeof data !== 'string' && !Buffer.isBuffer(data);
        if (refusal) {
          if (stream) data.destroy();
          return done(refusal);
        }
        if (!stream) {
          store.objects.set(`${bucket}/${name}`, Buffer.from(data));
          return done(null, { etag: '' });
        }
        const chunks = [];
        data.on('data', (chunk) => { chunks.push(chunk); });
        data.on('error', done);
        data.on('end', () => {
          store.objects.set(`${bucket}/${name}`, Buffer.concat(chunks));
          done(null, { etag: '' });
        });
        return undefined;
      }

      statObject(bucket, name, done) {
        const refusal = store.asked(this, ['statObject', bucket, name]);
        if (refusal) return done(refusal);
        const held = store.objects.get(`${bucket}/${name}`);
        if (held === undefined) return done(Object.assign(new S3Error('Not Found'), { code: 'NotFound' }));
        return done(null, { size: held.length });
      }
    };
  }

  // Records `call` of `client`; the refusal when the store refuses, else
  // null.
  asked(client, call) {
    this.calls.push(call);
    if (!this.refuse) return null;
    return Object.assign(new S3Error('The Access Key Id you provided does not exist in our records.'), {
      code: 'InvalidAccessKeyId',
      awsaccesskeyid: client.options.accessKey,
      resource: `/${call.slice(1).join('/')}`,
    });
  }

  // The names of the objects put, in the order of the puts.
  puts() {
    return this.calls.filter((call) => call[0] === 'putObject').map((call) => call[2]);
  }
}

// The securelock's SwiftStreamService (src/swift_stream_service.js) with its
// require of the minio package answered by `minio`.
function storeService(minio) {
  const file = path.join(SRC, 'swift_stream_service.js');
  const fromSrc = Module.createRequire(file);
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(
    (name) => (name === 'minio' ? minio : fromSrc(name)), compiled, compiled.exports);
  return compiled.exports;
}

// fn()'s value where an open of STORE_CREDENTIAL_PATH, the path the
// template's reader opens, opens `file` in its place, and the number of
// those opens. Every other open is fs's own.
async function withCredentialFile(file, fn) {
  const { openSync } = fs;
  let opens = 0;
  fs.openSync = (target, ...rest) => {
    if (target !== STORE_CREDENTIAL_PATH) return openSync(target, ...rest);
    opens += 1;
    return openSync(file, ...rest);
  };
  try {
    const value = await fn();
    return { value, opens };
  } finally {
    fs.openSync = openSync;
  }
}

module.exports = {
  SRC, TEMPLATE, BUCKET, ORDER_ID, CHALLENGE, METHODS, STORE_CREDENTIAL_PATH,
  sha256, sealing, sealed, opened, loadTemplate, certificateIn, written, order,
  S3Error, MinioStandIn, storeService, withCredentialFile,
};
