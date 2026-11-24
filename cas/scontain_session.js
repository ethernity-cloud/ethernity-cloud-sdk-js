'use strict';
// The upload of a securelock session to the Scontain CAS, and the TLS client
// key it is made under.
//
// The CAS gives a session's read and update rights to the public key of the
// client certificate that uploaded it, unless the session's access_policy
// names other keys. ecld-publish uploads a session under the CAS client key
// of the publishing wallet (client_key.js), derived at each upload and
// written to no file, with a self-signed certificate built for the upload.
//
// A project published by an SDK up to 1.9.1 holds the random client key of
// that SDK as key.pem and cert.pem in its run directory. The update of such a
// project's session is made under those files and carries an access_policy
// whose read and update lists name the certificate of the wallet's key (the
// hand-over). .env records the hand-over as CAS_CLIENT_KEY=handover and an
// upload under the wallet's key as CAS_CLIENT_KEY=wallet; with either record
// the files are not read. They are never written or removed.

const fs = require('fs');
const https = require('https');
const path = require('path');
const tls = require('tls');
const axios = require('axios');
const forge = require('node-forge');
const { casClientKey } = require('./client_key.js');

const SESSION_URL = 'https://scone-cas.cf:8081/session';

// The .env variable that records which key holds the session, and its values.
const RECORD = 'CAS_CLIENT_KEY';
const HANDOVER = 'handover';
const WALLET = 'wallet';

// The key a session is uploaded under: HANDOVER, the project's key.pem and
// cert.pem with the access policy that names the wallet's key, for a session
// with a predecessor in a project that holds both files and no record;
// WALLET, the wallet's key, in every other case.
const uploadKey = ({ predecessor, legacyFiles, recorded }) =>
  (predecessor && legacyFiles && recorded !== HANDOVER && recorded !== WALLET ? HANDOVER : WALLET);

// A self-signed X.509 certificate over the RSA private key `keyPem`, in PEM,
// valid from one year before now to one year after, with `organization` as
// the O of its subject.
function selfSignedCertificate(keyPem, organization) {
  const { pki } = forge;
  const privateKey = pki.privateKeyFromPem(keyPem);
  const cert = pki.createCertificate();
  cert.publicKey = pki.setRsaPublicKey(privateKey.n, privateKey.e);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notBefore.setFullYear(cert.validity.notBefore.getFullYear() - 1);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);
  const attrs = [
    { name: 'countryName', value: 'AU' },
    { shortName: 'ST', value: 'Some-State' },
    { name: 'organizationName', value: organization },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: true },
    { name: 'basicConstraints', cA: true, critical: true },
  ]);
  cert.sign(privateKey, forge.md.sha256.create());
  return pki.certificateToPem(cert);
}

// The access_policy of a session whose read and update rights belong to the
// key of the certificate `certificatePem` and to no other.
function accessPolicy(certificatePem) {
  const entry = ['    - |', ...certificatePem.trim().split(/\r?\n/).map((line) => `      ${line}`)].join('\n');
  return `access_policy:\n  read:\n${entry}\n  update:\n${entry}\n`;
}

// Posts the session file `sessionFile` to the CAS at `url` and returns the
// answer (axios's response; a status outside 2xx rejects, as axios does).
//
// predecessor: whether the session names a predecessor. legacyDir: the
// directory of the project's key.pem and cert.pem. recorded: the project's
// CAS_CLIENT_KEY. walletKey: the publishing wallet's private key.
// organization: the O of the wallet key's certificate. writeRecord(value)
// stores CAS_CLIENT_KEY; log(line) prints a line.
//
// For a hand-over (uploadKey) the access policy is appended to the session
// file before it is posted. An answer that carries the session's hash records
// the key the upload was made under: HANDOVER after a hand-over, WALLET after
// an upload under the wallet's key, then with one line that says key.pem and
// cert.pem are no longer used when the project holds them.
async function upload({ url, sessionFile, predecessor, legacyDir, recorded, walletKey, organization, writeRecord, log }) {
  const legacyKey = path.join(legacyDir, 'key.pem');
  const legacyCert = path.join(legacyDir, 'cert.pem');
  const legacyFiles = fs.existsSync(legacyKey) && fs.existsSync(legacyCert);
  const under = uploadKey({ predecessor, legacyFiles, recorded });

  log('Deriving the CAS client key of the publishing wallet');
  const keyPem = casClientKey(walletKey).export({ type: 'pkcs8', format: 'pem' });
  const certPem = selfSignedCertificate(keyPem, organization);

  let client;
  if (under === HANDOVER) {
    const session = fs.readFileSync(sessionFile, 'utf8');
    fs.writeFileSync(sessionFile, `${session}${session.endsWith('\n') ? '' : '\n'}\n${accessPolicy(certPem)}`);
    client = { cert: fs.readFileSync(legacyCert), key: fs.readFileSync(legacyKey) };
    log(`The session is uploaded under key.pem and cert.pem of ${path.resolve(legacyDir)}; `
      + 'its access policy gives its read and update rights to the CAS client key of the publishing wallet');
  } else {
    client = { cert: certPem, key: keyPem };
    log('The session is uploaded under the CAS client key of the publishing wallet');
  }

  const response = await axios.post(url, fs.readFileSync(sessionFile), {
    // The key goes to the agent inside a TLS context, not as an option: an
    // error axios raises carries the agent, and what the caller prints of it
    // then holds nothing of the key. rejectUnauthorized: the CAS's
    // certificate is not checked, as with curl -k.
    httpsAgent: new https.Agent({
      secureContext: tls.createSecureContext({ ...client, secureProtocol: 'TLSv1_2_method' }),
      rejectUnauthorized: false,
    }),
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  if (response.data && response.data.hash) {
    if (under === HANDOVER) {
      writeRecord(HANDOVER);
      log('The session\'s read and update rights now belong to the CAS client key of the publishing wallet: '
        + 'the next publish uploads under it');
    } else if (recorded !== WALLET) {
      writeRecord(WALLET);
      if (legacyFiles) {
        log(`key.pem and cert.pem of ${path.resolve(legacyDir)} are no longer used: `
          + 'the session is uploaded under the CAS client key of the publishing wallet');
      }
    }
  }
  return response;
}

module.exports = { SESSION_URL, RECORD, HANDOVER, WALLET, uploadKey, selfSignedCertificate, accessPolicy, upload };
