#!/bin/bash -v

cd /etny-securelock
ls
echo "####################"
cat .env
echo "####################"

cat securelock.js.tmpl | sed  s/"__ENCLAVE_NAME_SECURELOCK__"/"${ENCLAVE_NAME_SECURELOCK}"/g > securelock.js.tmp
cat securelock.js.tmp | sed  s/"__BUCKET_NAME__"/"${BUCKET_NAME}"/g > securelock.js

echo "starting building binary-fs..."
EXEC=(scone binaryfs / /binary-fs-dir -v \
  --include '/usr/local/bin/node' \
  --include '/etny-securelock/*' \
  --host-path=/etc/resolv.conf \
  --host-path=/etc/hosts)
echo "finished building binary-fs..."

exec "${EXEC[@]}"

exit
