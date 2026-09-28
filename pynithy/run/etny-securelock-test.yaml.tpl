name: __ENCLAVE_NAME__
version: "0.3"
__PREDECESSOR__

security:
  attestation:
    # Both substituted per network by run.js. Mainnet attests production
    # enclaves only and lists the advisories it accepts; a testnet tolerates a
    # debug-signed enclave and takes the wildcard ["*"], so an operator's
    # platform is not refused for a TCB level that has no bearing on a test
    # network. (A bare "*" is not a list: the CAS reads it as a literal
    # advisory id, which ignores nothing.)
    tolerate: __TOLERATE__
    ignore_advisories: __IGNORE_ADVISORIES__

services:
   - name: application
     image_name: application_image
     mrenclaves: [ "__MRENCLAVE__" ]
     command: /usr/local/bin/python /etny-securelock/securelock.py
     pwd: /
     environment:
        GREETING: hello ETNY!!!!

images:
   - name: application_image
     injection_files:
       - path: /app/__ENCLAVE_NAME__/ca.pem
         content: $$SCONE::CA_CERT:crt$$
       - path: /app/__ENCLAVE_NAME__/cert.pem
         content: $$SCONE::SERVER_CERT:crt$$
       - path: /private/__ENCLAVE_NAME__/key.pem
         content: $$SCONE::SERVER_CERT:privatekey$$

secrets:
   - name: CA_KEY
     kind: private-key
     key_type: P-384
     migrate: true
   - name: CA_CERT
     kind: x509-ca
     private_key: CA_KEY
     valid_for: 3560d
   - name: SERVER_KEY
     kind: private-key
     key_type: P-384
     migrate: false
   - name: SERVER_CERT
     issuer: CA_CERT
     kind: x509
     endpoint: server
     private_key: SERVER_KEY
