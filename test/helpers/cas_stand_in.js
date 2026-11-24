// A stand-in for the session endpoint of a SCONE CAS: an HTTPS server on a
// loopback port that requires a TLS client certificate and keeps sessions by
// the rules of the SCONE session language 0.3 that cas/scontain_session.js
// relies on.
//
// POST /session takes a session in YAML. A request without a client
// certificate is answered 401. A session whose name is new names no
// predecessor (400 otherwise) and is created. A session whose name is taken
// names the stored hash as its predecessor (409 otherwise) and comes from a
// key that holds the stored session's update right (403 otherwise). That
// right belongs to the keys of the certificates the stored session's
// access_policy lists under `update`, CREATOR there being its uploader's key,
// and to the uploader's key alone when it has no access_policy. An accepted
// session is answered 201 with {"name", "hash"}: the hash is the SHA-256 of
// the body and the uploader's key, or is left out while `omitHash` is set.
//
// Every request is recorded in `requests`: the uploader's key (the DER of its
// SubjectPublicKeyInfo, in hex; null without a certificate), its certificate
// (DER), the TLS protocol, the method, the path, the content type, the body
// and the status answered.
'use strict';

const crypto = require('crypto');
const https = require('https');
const forge = require('node-forge');
const yaml = require('js-yaml');

// The DER of the SubjectPublicKeyInfo of a certificate (PEM or DER), in hex.
const keyOfCertificate = (certificate) => new crypto.X509Certificate(certificate)
  .publicKey.export({ type: 'spki', format: 'der' }).toString('hex');

// A throwaway RSA key and a self-signed certificate over it, both in PEM.
function throwawayIdentity(commonName) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const forgeKey = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const name = [{ name: 'commonName', value: commonName }];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.sign(forgeKey, forge.md.sha256.create());
  return { keyPem, certPem: forge.pki.certificateToPem(cert), key: keyOfCertificate(forge.pki.certificateToPem(cert)) };
}

// The keys an access_policy list names, CREATOR being `creator`.
const holders = (list, creator) => list.map((entry) => (entry === 'CREATOR' ? creator : keyOfCertificate(entry)));

async function startCas() {
  const identity = throwawayIdentity('cas stand-in');
  const cas = { sessions: new Map(), requests: [], omitHash: false };
  const server = https.createServer(
    { key: identity.keyPem, cert: identity.certPem, requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const peer = req.socket.getPeerCertificate();
        const record = {
          key: null,
          certificate: peer && peer.raw ? peer.raw : null,
          protocol: req.socket.getProtocol(),
          method: req.method,
          path: req.url,
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks),
          status: null,
        };
        cas.requests.push(record);
        const reply = (status, answer) => {
          record.status = status;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(answer));
        };
        if (!record.certificate) return reply(401, { msg: 'a client certificate is required' });
        record.key = keyOfCertificate(record.certificate);
        if (req.method !== 'POST' || req.url !== '/session') return reply(404, { msg: 'no such endpoint' });
        let session;
        try {
          session = yaml.load(record.body.toString('utf8'));
        } catch (e) {
          return reply(400, { msg: `the session is not YAML: ${e.message}` });
        }
        const stored = cas.sessions.get(session.name);
        if (!stored && session.predecessor !== undefined) {
          return reply(400, { msg: 'a new session names no predecessor' });
        }
        if (stored && String(session.predecessor) !== stored.hash) {
          return reply(409, { msg: 'the predecessor is not the stored session' });
        }
        if (stored && !stored.update.includes(record.key)) {
          return reply(403, { msg: 'the client key does not hold the session\'s update right' });
        }
        const policy = session.access_policy || {};
        const hash = crypto.createHash('sha256').update(record.body).update(record.key).digest('hex');
        cas.sessions.set(session.name, {
          hash,
          creator: record.key,
          read: holders(policy.read || ['CREATOR'], record.key),
          update: holders(policy.update || ['CREATOR'], record.key),
        });
        return reply(201, cas.omitHash ? { name: session.name } : { name: session.name, hash });
      });
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cas.url = `https://127.0.0.1:${server.address().port}/session`;
  cas.close = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  return cas;
}

// One POST of `body` to `url` under the client certificate `certPem` and its
// key `keyPem` (none when they are left out); resolves with the status and
// the parsed JSON answer.
function post(url, body, { keyPem, certPem } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST', key: keyPem, cert: certPem, rejectUnauthorized: false, agent: false,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

module.exports = { startCas, post, throwawayIdentity, keyOfCertificate };
