#!/bin/bash

export IPFS_HOME=${PWD}/ipfs
export IPFS_PATH=${IPFS_HOME}/.ipfs

export KUBO_URL="https://github.com/ipfs/kubo/releases/download/v0.17.0/kubo_v0.17.0_darwin-amd64.tar.gz"
echo KUBO_URL=${KUBO_URL}

mkdir -p ${IPFS_HOME}

curl -L ${KUBO_URL} | tar xvz

echo "*** KUBO Downloaded ***"

if [ -d "${IPFS_PATH}" ]; then
  killall ipfs
  rm -fr ${IPFS_PATH}
fi

export IPFS_CMD=${PWD}/kubo/ipfs
export REGISTRY_PATH=../../../../registry

${IPFS_CMD} init

sleep 20

${IPFS_CMD} daemon &

sleep 20

${IPFS_CMD} swarm connect /ip4/31.7.188.59/tcp/4001/ipfs/QmRBc1eBt4hpJQUqHqn6eA8ixQPD3LFcUDsn6coKBQtia5
${IPFS_CMD} bootstrap add /ip4/31.7.188.59/tcp/4001/ipfs/QmRBc1eBt4hpJQUqHqn6eA8ixQPD3LFcUDsn6coKBQtia5


cp certificate.securelock.crt "${REGISTRY_PATH}/certificate.securelock.crt"
cp certificate.trustedzone.crt "${REGISTRY_PATH}/certificate.trustedzone.crt"
echo "${REGISTRY_PATH}"
cd ${REGISTRY_PATH}

#ADDING DOCKER IMAGE hash
export IPFS_HASH=$(${IPFS_CMD} add . -r | grep added | tail -1 | awk '{print $2}')
echo "IPFS_HASH=${IPFS_HASH}"

echo ipfs pin add --progress ${IPFS_HASH}
${IPFS_CMD} pin add --progress ${IPFS_HASH}

#DOWNLOADING DOCKER IMAGE FROM IFPS HASH
echo ipfs get  ${IPFS_HASH}
${IPFS_CMD} get  ${IPFS_HASH}

if [ -d "${IPFS_PATH}" ]; then
  killall ipfs
  rm -fr ${IPFS_PATH}
fi

cd -

echo "${IPFS_HASH}" > "IPFS_HASH.ipfs"
