#!/bin/bash -v
set -e

cd /etny-securelock
ls

cat securelock.js.tmpl | sed  s/"__ENCLAVE_NAME_SECURELOCK__"/"${ENCLAVE_NAME_SECURELOCK}"/g > securelock.js.tmp
# "|" delimits: the RPC URL contains "/".
sed -i "s|__ETNY_NETWORK_TYPE__|${NETWORK_TYPE}|g" securelock.js.tmp
sed -i "s|__ETNY_BUCKET__|${BUCKET_NAME}|g" securelock.js.tmp
sed -i "s|__ETNY_SMART_CONTRACT_ADDRESS__|${SMART_CONTRACT_ADDRESS}|g" securelock.js.tmp
sed -i "s|__ETNY_IMAGE_REGISTRY_ADDRESS__|${IMAGE_REGISTRY_ADDRESS}|g" securelock.js.tmp
sed -i "s|__ETNY_WEB3_PROVIDER__|${RPC_URL}|g" securelock.js.tmp
sed -i "s|__ETNY_CHAIN_ID__|${CHAIN_ID}|g" securelock.js.tmp
# ethernity-cas ValidatorRegistry for CAS self-attestation. Deliberately NOT
# overridable from the runtime environment (unlike the addresses above): the
# session env comes from the CAS itself, and a rogue CAS must not get to
# choose the registry that judges it. Empty -> the check is skipped.
sed -i "s/__ETNY_VALIDATOR_REGISTRY_ADDRESS__/${VALIDATOR_REGISTRY_ADDRESS}/g" securelock.js.tmp
mv securelock.js.tmp securelock.js

# The enclave's root: a new directory that holds the enclave's files and
# nothing else, each at its path in the enclave. The binary-fs is made of it
# whole, fixed-start/tree_digest.sh writes its digest, and the launcher
# refuses a start whose file system holds another entry (fixed_start.c). It
# holds:
#   /usr/local/bin/node                 the node of this stage;
#   /etny-securelock                    this directory as it is;
#   /etny-securelock/fixed-start/openssl.cnf
#                                       an empty file, the OpenSSL
#                                       configuration the fixed vector names
#                                       (nodeFlags.js,
#                                       fixed-start/securelock.h).
# mkdir fails when the directory exists. The binary-fs holds no empty
# directory, so the root holds none.
ROOT=/enclave-root
mkdir "${ROOT}"
mkdir -p "${ROOT}/usr/local/bin"
cp /usr/local/bin/node "${ROOT}/usr/local/bin/node"
cp -a /etny-securelock "${ROOT}/etny-securelock"
mkdir "${ROOT}/etny-securelock/fixed-start"
: > "${ROOT}/etny-securelock/fixed-start/openssl.cnf"
find "${ROOT}" -depth -type d -empty -exec rmdir {} \;

echo "starting building binary-fs..."
# The root whole (no --include), its symbolic links as they are
# (--preserve-symbolic-links: a link's target is a path of the enclave).
EXEC=(scone binaryfs "${ROOT}" /binary-fs-dir -v \
  --preserve-symbolic-links \
  --host-path=/etc/resolv.conf \
  --host-path=/etc/hosts)
echo "finished building binary-fs..."

exec "${EXEC[@]}"
