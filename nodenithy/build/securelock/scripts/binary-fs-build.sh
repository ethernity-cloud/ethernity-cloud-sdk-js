#!/bin/bash -v

cd /etny-securelock
ls
echo "####################"
cat .env
echo "####################"

cat securelock.js.tmpl | sed  s/"__ENCLAVE_NAME_SECURELOCK__"/"${ENCLAVE_NAME_SECURELOCK}"/g > securelock.js.tmp
sed -i "s/__BUCKET_NAME__/${BUCKET_NAME}/g" securelock.js.tmp
sed -i "s/__SMART_CONTRACT_ADDRESS__/${SMART_CONTRACT_ADDRESS}/g" securelock.js.tmp
sed -i "s/__IMAGE_REGISTRY_ADDRESS__/${IMAGE_REGISTRY_ADDRESS}/g" securelock.js.tmp
sed -i "s/__RPC_URL__/${RPC_URL}/g" securelock.js.tmp
sed -i "s/__CHAIN_ID__/${CHAIN_ID}/g" securelock.js.tmp
sed -i "s/__TRUSTED_ZONE_IMAGE__/${TRUSTED_ZONE_IMAGE}/g" securelock.js.tmp
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
