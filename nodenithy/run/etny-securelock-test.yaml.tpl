name: __ENCLAVE_NAME__
version: "0.3"
__PREDECESSOR__

security:
  attestation:
    tolerate: [hyperthreading, outdated-tcb, software-hardening-needed, debug-mode]
    ignore_advisories: ["INTEL-SA-00220", "INTEL-SA-00270", "INTEL-SA-00293", "INTEL-SA-00320", "INTEL-SA-00329", "INTEL-SA-00334", "INTEL-SA-00381", "INTEL-SA-00389", "INTEL-SA-00477", "INTEL-SA-00614", "INTEL-SA-00615", "INTEL-SA-00617", "INTEL-SA-00828"]

services:
   - name: application
     image_name: application_image
     mrenclaves: [ "__MRENCLAVE__" ]
     command: /usr/local/bin/node /etny-securelock/securelock.js
     pwd: /
     environment:
        GREETING: hello from ETNY SECURELOCK!!!!

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
