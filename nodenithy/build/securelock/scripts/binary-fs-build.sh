#!/bin/bash -v

cd /etny-securelock
ls
echo "####################"
cat .env
echo "####################"

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

echo "starting building binary-fs..."
EXEC=(scone binaryfs / /binary-fs-dir -v \
  --include '/usr/local/bin/node' \
  --include '/etny-securelock/*' \
  --host-path=/etc/resolv.conf \
  --host-path=/etc/hosts)
echo "finished building binary-fs..."

exec "${EXEC[@]}"

exit
