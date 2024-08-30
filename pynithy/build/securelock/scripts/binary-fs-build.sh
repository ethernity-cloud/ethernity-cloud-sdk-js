#!/bin/bash -v


pip3 install pyinstaller
apk add binutils

cd /etny-securelock

echo "ENCLAVE_NAME_SECURE_LOCK = ${ENCLAVE_NAME_SECURELOCK}"
cat securelock.py.tmpl | sed  s/"__ENCLAVE_NAME_SECURELOCK__"/"${ENCLAVE_NAME_SECURELOCK}"/g > securelock.py

pyinstaller securelock.py

EXEC=(scone binaryfs / /binary-fs-dir -v \
  --include '/usr/local/lib/python3.10/*' \
  --include '/etny-securelock/*' \
  --host-path=/etc/resolv.conf \
  --host-path=/etc/hosts)


for FILE in `cat ./build/securelock/COLLECT-00.toc | grep '.so' | grep BINARY | awk -F "'" '{print $4}'`
do
  EXEC+=(--include "${FILE}"'*')
done

rm -rf build dist securelock.spec

echo "${EXEC[@]}"

SCONE_MODE=auto
exec "${EXEC[@]}"

exit
