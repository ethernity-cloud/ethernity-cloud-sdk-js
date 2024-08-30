#!/bin/bash -v

cd /etny-trustedzone
ls
echo "####################"
cat .env
echo "####################"

cat trustedzone.js.tmpl | sed  s/"__ENCLAVE_NAME_TRUSTEDZONE__"/"${ENCLAVE_NAME_TRUSTEDZONE}"/g > trustedzone.js


echo "starting building binary-fs..."
EXEC=(scone binaryfs / /binary-fs-dir -v \
  --include '/usr/local/bin/node' \
  --include '/etny-trustedzone/*' \
  --host-path=/etc/resolv.conf \
  --host-path=/etc/hosts)
echo "finished building binary-fs..."

exec "${EXEC[@]}"

exit
