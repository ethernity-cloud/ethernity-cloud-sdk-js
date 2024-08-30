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

# Configure Kubo to use the custom IPFS API endpoint
${IPFS_CMD} config Addresses.API /ip4/127.0.0.1/tcp/5001
${IPFS_CMD} config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
${IPFS_CMD} config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "POST", "GET"]'

${IPFS_CMD} daemon &

sleep 20

# Connect to the custom IPFS node
${IPFS_CMD} swarm connect /dns4/ipfs.ethernity.cloud/tcp/5001

# Adding Docker Compose hash
export IPFS_DOCKER_COMPOSE_HASH=$(${IPFS_CMD} add docker-compose-final.yml | grep added | tail -1 | awk '{print $2}')
echo "IPFS_DOCKER_COMPOSE_HASH=${IPFS_DOCKER_COMPOSE_HASH}"

echo ipfs pin add --progress ${IPFS_DOCKER_COMPOSE_HASH}
${IPFS_CMD} pin add --progress ${IPFS_DOCKER_COMPOSE_HASH}

# Downloading Docker Compose from IPFS hash
echo ipfs get ${IPFS_DOCKER_COMPOSE_HASH}
${IPFS_CMD} get ${IPFS_DOCKER_COMPOSE_HASH}

# Remove downloaded
rm -fr ${IPFS_DOCKER_COMPOSE_HASH}

echo "${REGISTRY_PATH}"
cd ${REGISTRY_PATH}

# Adding Docker image hash
export IPFS_HASH=$(${IPFS_CMD} add . -r | grep added | tail -1 | awk '{print $2}')
echo "IPFS_HASH=${IPFS_HASH}"

echo ipfs pin add --progress ${IPFS_HASH}
${IPFS_CMD} pin add --progress ${IPFS_HASH}

# Downloading Docker image from IPFS hash
echo ipfs get ${IPFS_HASH}
${IPFS_CMD} get ${IPFS_HASH}

if [ -d "${IPFS_PATH}" ]; then
  killall ipfs
  rm -fr ${IPFS_PATH}
fi

cd -

echo "${IPFS_DOCKER_COMPOSE_HASH}" > "IPFS_DOCKER_COMPOSE_HASH.ipfs"
echo "${IPFS_HASH}" > "IPFS_HASH.ipfs"