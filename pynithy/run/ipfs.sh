#!/bin/sh

apk add wget tar git screen

export IPFS_HOME=${PWD}/ipfs
export IPFS_PATH=${IPFS_HOME}/.ipfs

export KUBO_URL="https://github.com/ipfs/kubo/releases/download/v0.17.0/kubo_v0.17.0_linux-386.tar.gz"
echo KUBO_URL=${KUBO_URL}

echo "git clone https://ci:${CI_ACCESS_TOKEN}@gitlab.ethernity.cloud/etny-node/etny-hash-packages.git ${CI_PROJECT_DIR}/etny-hash-packages"
git clone https://ci:${CI_ACCESS_TOKEN}@gitlab.ethernity.cloud/etny-node/etny-hash-packages.git ${CI_PROJECT_DIR}/etny-hash-packages

git -C ${CI_PROJECT_DIR}/etny-hash-packages config --local user.email "ci@ethernity.cloud"
git -C ${CI_PROJECT_DIR}/etny-hash-packages config --local user.name "CI/CD"

mkdir -p ${IPFS_HOME}

wget -qO- ${KUBO_URL} | tar xvz

# wget -qO- ${KUBO_URL} | tar xvz

echo "*** KUBO Downloaded ***"

if [ -d "${IPFS_PATH}" ]; then
  killall ipfs
  rm -fr ${IPFS_PATH}
fi

export IPFS_CMD=${PWD}/kubo/ipfs

${IPFS_CMD} init

sleep 20

${IPFS_CMD} daemon &

sleep 20

${IPFS_CMD} swarm connect /ip4/31.7.188.59/tcp/4001/ipfs/QmRBc1eBt4hpJQUqHqn6eA8ixQPD3LFcUDsn6coKBQtia5
${IPFS_CMD} bootstrap add /ip4/31.7.188.59/tcp/4001/ipfs/QmRBc1eBt4hpJQUqHqn6eA8ixQPD3LFcUDsn6coKBQtia5

#ADDING DOCKER COMPOSE hash
export IPFS_DOCKER_COMPOSE_HASH=`${IPFS_CMD} add docker-compose-final.yml | grep added | tail -1 | awk '{print $2}'`
echo "IPFS_DOCKER_COMPOSE_HASH=${IPFS_DOCKER_COMPOSE_HASH}"

cp certificate.securelock.crt "${REGISTRY_PATH}/certificate.securelock.crt"
cp certificate.trustedzone.crt "${REGISTRY_PATH}/certificate.trustedzone.crt"
echo "${REGISTRY_PATH}"
cd ${REGISTRY_PATH}

echo ipfs pin add --progress ${IPFS_DOCKER_COMPOSE_HASH}
${IPFS_CMD} pin add --progress ${IPFS_DOCKER_COMPOSE_HASH}

#ADDING DOCKER IMAGE hash
export IPFS_HASH=`${IPFS_CMD} add . -r | grep added | tail -1 | awk '{print $2}'`
echo "IPFS_HASH=${IPFS_HASH}"

echo ipfs pin add --progress ${IPFS_HASH}
${IPFS_CMD} pin add --progress ${IPFS_HASH}

#DOWNLOADING DOCKER COMPOSE FROM IFPS HASH
echo ipfs get ${IPFS_DOCKER_COMPOSE_HASH}
${IPFS_CMD} get ${IPFS_DOCKER_COMPOSE_HASH}

#DOWNLOADING DOCKER IMAGE FROM IFPS HASH
echo ipfs get  ${IPFS_HASH}
${IPFS_CMD} get  ${IPFS_HASH}


#ADD DOCKER IMAGE to GIT
echo touch ${CI_PROJECT_DIR}/etny-hash-packages/etny-pynithy/v3/${IPFS_HASH}
touch ${CI_PROJECT_DIR}/etny-hash-packages/etny-pynithy/v3/${IPFS_HASH}

#Add DOCKER COMPOSE  to GIT
echo touch ${CI_PROJECT_DIR}/etny-hash-packages/etny-pynithy/v3/docker/${IPFS_DOCKER_COMPOSE_HASH}
touch ${CI_PROJECT_DIR}/etny-hash-packages/etny-pynithy/v3/docker/${IPFS_DOCKER_COMPOSE_HASH}

#ADDING CERTIFICATE TO GIT
mv certificate.securelock.crt "${CI_PROJECT_DIR}/etny-hash-packages/etny-pynithy/v3/cert/securelock/${IPFS_HASH}.crt"
cat "${CI_PROJECT_DIR}/etny-hash-packages/etny-pynithy/v3/cert/securelock/${IPFS_HASH}.crt"

mv certificate.trustedzone.crt "${CI_PROJECT_DIR}/etny-hash-packages/etny-pynithy/v3/cert/trustedzone/${IPFS_HASH}.crt"
cat "${CI_PROJECT_DIR}/etny-hash-packages/etny-pynithy/v3/cert/trustedzone/${IPFS_HASH}.crt"

cd -

echo "${IPFS_HASH}" > "IPFS_HASH.ipfs"
echo "${IPFS_DOCKER_COMPOSE_HASH}" > "IPFS_DOCKER_COMPOSE_HASH.ipfs"
