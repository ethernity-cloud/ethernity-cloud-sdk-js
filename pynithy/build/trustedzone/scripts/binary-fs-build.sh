#!/bin/bash -v

pip3 install pyinstaller
apk add binutils

cd /etny-trustedzone

cat trustedzone.py.tmpl | sed  s/"__ENCLAVE_NAME_TRUSTEDZONE__"/"${ENCLAVE_NAME_TRUSTEDZONE}"/g > trustedzone.py

pyinstaller trustedzone.py

EXEC=(scone binaryfs / /binary-fs-dir -v \
  --include '/usr/local/lib/python3.10/*' \
  --include '/etny-trustedzone/*' \
  --host-path=/etc/resolv.conf \
  --host-path=/etc/hosts)


for FILE in `cat ./build/trustedzone/COLLECT-00.toc | grep '.so' | grep BINARY | awk -F "'" '{print $4}'`
do
  EXEC+=(--include "${FILE}"'*')
done

rm -rf build dist trustedzone.spec

echo "${EXEC[@]}"

SCONE_MODE=auto
exec "${EXEC[@]}"


exit
