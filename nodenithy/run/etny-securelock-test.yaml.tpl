name: __ENCLAVE_NAME__
version: "0.3"
__PREDECESSOR__

security:
  attestation:
    # Both substituted per network by run.js. Mainnet attests production
    # enclaves only and lists the advisories it accepts; a testnet tolerates a
    # debug-signed enclave and takes the wildcard ["*"], so an operator's
    # platform is not refused for a TCB level that has no bearing on a test
    # network.
    tolerate: __TOLERATE__
    ignore_advisories: __IGNORE_ADVISORIES__

services:
   - name: application
     image_name: application_image
     mrenclaves: [ "__MRENCLAVE__" ]
     # The command the enclave runs, applied from the session at attestation:
     # the image ENTRYPOINT's, with the build's node flags (run.js NODE_FLAGS).
     command: /usr/local/bin/node __NODE_FLAGS__/etny-securelock/securelock.js
     pwd: /
     environment:
        GREETING: hello from ETNY SECURELOCK!!!!
        # A CAS-provisioned enclave takes its environment from this session,
        # not from the image's ENV; run.js fills in the ESR registry address.
        __ESR_ENVIRONMENT__

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
