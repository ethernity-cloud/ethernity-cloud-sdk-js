#!/bin/bash

set -e

# Source environment variables
if [ -f .env ]; then
    source .env
else
    echo "Error: .env file not found"
    exit 1
fi

write_env() {
    local key=$1
    local value=$2
    local env_file="$current_dir/.env"

    # Check if the .env file exists
    if [[ -f $env_file ]]; then
        # Check if the key exists in the .env file
        if grep -q "^${key}=" "$env_file"; then
            # Update the existing key with the new value
            sed -i '' "s/^${key}=.*/${key}=${value}/" "$env_file"
        else
            # Add the new key-value pair to the .env file
            echo "${key}=${value}" >> "$env_file"
        fi
    else
        # Create the .env file and add the key-value pair
        echo "${key}=${value}" > "$env_file"
    fi
}

current_dir=$(pwd)
echo "current_dir: $current_dir"

# Set up local registry path
export REGISTRY_PATH=${PWD}/registry


# check for sgx compatible machine
# check if image name is available in smart contract


RUNNER_TYPE="nodenithy"
echo "VERSION = ${VERSION}"

cd ${PWD}/node_modules/ethernity-cloud-sdk-js/nodenithy/run

echo "ETNY MODE: ${ETNY_MODE}"

# Determine MRENCLAVE values
export MRENCLAVE_SECURELOCK=$(docker-compose run -e SCONE_LOG=INFO -e SCONE_HASH=1 etny-securelock | grep -v Creating | grep -v Pulling | grep -v latest | grep -v Digest | tr -d '\r')
export MRENCLAVE_TRUSTEDZONE=$(docker-compose run -e SCONE_LOG=INFO -e SCONE_HASH=1 etny-trustedzone | grep -v Creating | grep -v Pulling | grep -v latest | grep -v Digest | tr -d '\r')
export MRENCLAVE_VALIDATOR=$(docker-compose run -e SCONE_LOG=INFO -e SCONE_HASH=1 etny-validator | grep -v Creating | grep -v Pulling | grep -v latest | grep -v Digest | tr -d '\r')

echo "MRENCLAVE_SECURELOCK: ${MRENCLAVE_SECURELOCK}"
echo "MRENCLAVE_TRUSTEDZONE: ${MRENCLAVE_TRUSTEDZONE}"
echo "MRENCLAVE_VALIDATOR: ${MRENCLAVE_VALIDATOR}"

write_env "MRENCLAVE_SECURELOCK" "${MRENCLAVE_SECURELOCK}"
write_env "MRENCLAVE_TRUSTEDZONE" "${MRENCLAVE_TRUSTEDZONE}"
write_env "MRENCLAVE_VALIDATOR" "${MRENCLAVE_VALIDATOR}"

export CI_COMMIT_BRANCH = ${PROJECT_NAME}
# Generate enclave names
ENCLAVE_NAME_SECURELOCK=$(echo ${ENCLAVE_NAME_SECURELOCK} | awk '{print toupper($0)}' | sed 's#/#_#g' | sed 's#-#_#g')
PREDECESSOR_NAME_SECURELOCK=$(echo PREDECESSOR_SECURELOCK_${VERSION}_${CI_COMMIT_BRANCH} | awk '{print toupper($0)}' | sed 's#/#_#g' | sed 's#-#_#g')

echo
echo "ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}"
echo "PREDECESSOR_NAME_SECURELOCK: ${PREDECESSOR_NAME_SECURELOCK}"
write_env "PREDECESSOR_NAME_SECURELOCK" "${PREDECESSOR_NAME_SECURELOCK}"
echo

export ENCLAVE_NAME_SECURELOCK
# write_env "ENCLAVE_NAME_SECURELOCK" "${ENCLAVE_NAME_SECURELOCK}"

PREDECESSOR_HASH_SECURELOCK=$(eval "echo \${$PREDECESSOR_NAME_SECURELOCK}")

# Set default values only if environment variables are not set
PREDECESSOR_HASH_SECURELOCK=${PREDECESSOR_HASH_SECURELOCK:-"EMPTY"}

# Debug: Print environment variables
echo "PREDECESSOR_HASH_SECURELOCK: ${PREDECESSOR_HASH_SECURELOCK}"
echo "MRENCLAVE_SECURELOCK: ${MRENCLAVE_SECURELOCK}"
echo "ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}"

# Process etny-securelock-test.yaml
if [ ! -f etny-securelock-test.yaml.tpl ]; then
    echo "Error: Template file etny-securelock-test.yaml.tpl not found!"
    exit 1
fi

if [ "${PREDECESSOR_HASH_SECURELOCK}" = "EMPTY" ]; then
    sed -e "s|__PREDECESSOR__ |#predecessor: ${PREDECESSOR_HASH_SECURELOCK}|g" \
        -e "s|__MRENCLAVE__|${MRENCLAVE_SECURELOCK}|g" \
        -e "s|__ENCLAVE_NAME__|${ENCLAVE_NAME_SECURELOCK}|g" \
        etny-securelock-test.yaml.tpl > etny-securelock-test.yaml
else
    sed -e "s|__PREDECESSOR__|predecessor: ${PREDECESSOR_HASH_SECURELOCK}|g" \
        -e "s|__MRENCLAVE__|${MRENCLAVE_SECURELOCK}|g" \
        -e "s|__ENCLAVE_NAME__|${ENCLAVE_NAME_SECURELOCK}|g" \
        etny-securelock-test.yaml.tpl > etny-securelock-test.yaml
fi

echo "Contents of etny-securelock-test.yaml:"
cat etny-securelock-test.yaml

echo "Checking for remaining placeholders:"
grep -n "__.*__" etny-securelock-test.yaml || echo "No placeholders found."

echo "##############################################################################################################"

ENCLAVE_NAME_TRUSTEDZONE=$(echo ${ENCLAVE_NAME_TRUSTEDZONE} | awk '{print toupper($0)}' | sed 's#/#_#g' | sed 's#-#_#g')
PREDECESSOR_NAME_TRUSTEDZONE=$(echo PREDECESSOR_TRUSTEDZONE_${VERSION}_${CI_COMMIT_BRANCH} | awk '{print toupper($0)}' | sed 's#/#_#g' | sed 's#-#_#g')

echo
echo "ENCLAVE_NAME_TRUSTEDZONE: ${ENCLAVE_NAME_TRUSTEDZONE}"
echo "PREDECESSOR_NAME_TRUSTEDZONE: ${PREDECESSOR_NAME_TRUSTEDZONE}"
echo

export ENCLAVE_NAME_TRUSTEDZONE
# write_env "ENCLAVE_NAME_TRUSTEDZONE" "${ENCLAVE_NAME_TRUSTEDZONE}"

PREDECESSOR_HASH_TRUSTEDZONE=$(eval "echo \${$PREDECESSOR_NAME_TRUSTEDZONE}")
PREDECESSOR_HASH_TRUSTEDZONE=${PREDECESSOR_HASH_TRUSTEDZONE:-"EMPTY"}

# Debug: Print environment variables
echo "PREDECESSOR_HASH_TRUSTEDZONE: ${PREDECESSOR_HASH_TRUSTEDZONE}"
echo "MRENCLAVE_TRUSTEDZONE: ${MRENCLAVE_TRUSTEDZONE}"
echo "MRENCLAVE_VALIDATOR: ${MRENCLAVE_VALIDATOR}"
echo "ENCLAVE_NAME_TRUSTEDZONE: ${ENCLAVE_NAME_TRUSTEDZONE}"

# Process etny-trustedzone-test.yaml
if [ ! -f etny-trustedzone-test.yaml.tpl ]; then
    echo "Error: Template file etny-trustedzone-test.yaml.tpl not found!"
    exit 1
fi

if [ "${PREDECESSOR_HASH_TRUSTEDZONE}" = "EMPTY" ]; then
    sed -e "s|__PREDECESSOR__|# predecessor: ${PREDECESSOR_HASH_TRUSTEDZONE}|g" \
        -e "s|__MRENCLAVE__|${MRENCLAVE_TRUSTEDZONE}|g" \
        -e "s|__MRENCLAVE_VALIDATOR__|${MRENCLAVE_VALIDATOR}|g" \
        -e "s|__ENCLAVE_NAME__|${ENCLAVE_NAME_TRUSTEDZONE}|g" \
        etny-trustedzone-test.yaml.tpl > etny-trustedzone-test.yaml
else
    sed -e "s|__PREDECESSOR__|predecessor: ${PREDECESSOR_HASH_TRUSTEDZONE}|g" \
        -e "s|__MRENCLAVE__|${MRENCLAVE_TRUSTEDZONE}|g" \
        -e "s|__MRENCLAVE_VALIDATOR__|${MRENCLAVE_VALIDATOR}|g" \
        -e "s|__ENCLAVE_NAME__|${ENCLAVE_NAME_TRUSTEDZONE}|g" \
        etny-trustedzone-test.yaml.tpl > etny-trustedzone-test.yaml
fi

echo "Contents of etny-trustedzone-test.yaml:"
cat etny-trustedzone-test.yaml

echo "Checking for remaining placeholders:"
grep -n "__.*__" etny-trustedzone-test.yaml || echo "No placeholders found."

echo "# Update docker-compose files"

# Update docker-compose files
for file in docker-compose.yml docker-compose-final.yml; do
    if [ ! -f "$file" ]; then
        echo "Error: $file not found!"
        continue
    fi

    echo "Processing $file"
    echo "ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}"
    echo "ENCLAVE_NAME_TRUSTEDZONE: ${ENCLAVE_NAME_TRUSTEDZONE}"

    echo "Checking for placeholders before replacement:"
    grep "__ENCLAVE_NAME_SECURELOCK__" "$file" || echo "No __ENCLAVE_NAME_SECURELOCK__ found in $file"
    grep "__ENCLAVE_NAME_TRUSTEDZONE__" "$file" || echo "No __ENCLAVE_NAME_TRUSTEDZONE__ found in $file"

    sed -i '' -e "s|__ENCLAVE_NAME_SECURELOCK__|${ENCLAVE_NAME_SECURELOCK}|g" \
              -e "s|__ENCLAVE_NAME_TRUSTEDZONE__|${ENCLAVE_NAME_TRUSTEDZONE}|g" \
              "$file"

    echo "Checking for placeholders after replacement:"
    grep "__ENCLAVE_NAME_SECURELOCK__" "$file" || echo "No __ENCLAVE_NAME_SECURELOCK__ found in $file"
    grep "__ENCLAVE_NAME_TRUSTEDZONE__" "$file" || echo "No __ENCLAVE_NAME_TRUSTEDZONE__ found in $file"

    echo "Contents of $file:"
    cat "$file"
    echo
done

# export binaries hashes from scontain base image (node/python)
# use them allong with the ipfs hash of the uploaded registry artefact

# Get PUBLIC_KEY for SECURELOCK
export PUBLIC_KEY_SECURELOCK_RES=$(docker-compose run etny-securelock | grep -v Creating | grep -v Pulling | grep -v latest | grep -v Digest | sed 's/.*PUBLIC_KEY:\s*//' | tr -d '\r')

echo "PUBLIC_KEY_SECURELOCK_RES: ${PUBLIC_KEY_SECURELOCK_RES}"


# Check if PUBLIC_KEY_SECURELOCK_RES is empty
if [ -z "${PUBLIC_KEY_SECURELOCK_RES}" ]; then
  echo
  echo
  echo "It seams that your machine is not SGX compatible."
  echo
  echo "Do you want to continue by generating the necesary certificates using the Ethernity Cloud signing service? (yes/no)"
    read -p "Select an option (default is no): " REPLY
    if [[ -z "$REPLY" ]]; then
        echo "No option selected. Exiting."
        exit 1
    elif [[ "$REPLY" == "yes" ]]; then
        echo
        echo "Generating certificates using the Ethernity Cloud signing service..."
        echo
        echo "**** Started ipfs initial pining ****"
        if [ -f ipfs.sh ]; then
            chmod +x ipfs_pre.sh
            ./ipfs_pre.sh
        else
            echo "Warning: ipfs_pre.sh not found. Skipping IPFS setup."
        fi
        echo "**** Finished ipfs initial pining ****"
        echo "ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}"
        echo "VERSION: ${VERSION}"
        echo "BLOCKCHAIN_NETWORK: ${BLOCKCHAIN_NETWORK}"
        python3 ./public_key_service.py --enclave_name "${PROJECT_NAME}" --protocol_version "${VERSION}" --network "${BLOCKCHAIN_NETWORK}" --template_version "0.1.12"
        # read PUBLIC_KEY_SECURELOCK_RES from PUBLIC_KEY.txt
        PUBLIC_KEY_SECURELOCK_RES=$(cat PUBLIC_KEY.txt)
    else
        echo "Exiting."
        exit 1
    fi
fi

export CERTIFICATE_CONTENT_SECURELOCK=$(echo "${PUBLIC_KEY_SECURELOCK_RES}" | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' | sed -e '/-----BEGIN CERTIFICATE-----/d' -e '/-----END CERTIFICATE-----/d')
if [ -z "${CERTIFICATE_CONTENT_SECURELOCK}" ]; then
  echo "ERROR! PUBLIC_KEY_SECURELOCK not found"
  exit 1
else
  echo "FOUND PUBLIC_KEY_SECURELOCK"
fi



echo -e "${PUBLIC_KEY_SECURELOCK}" > certificate.securelock.crt
echo "Listing certificate PUBLIC_KEY_SECURELOCK:"
cat certificate.securelock.crt


CERTIFICATE_CONTENT_TRUSTEDZONE="MIIBczCB+6ADAgECAgkAkZLVvEgT6QgwCgYIKoZIzj0EAwMwEjEQMA4GA1UEAwwHQ0FfQ0VSVDAgFw0yNDA2MDUwODEyMjhaGA80MDk2MDEwMTAwMDAwMFowFjEUMBIGA1UEAwwLU0VSVkVSX0NFUlQwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAARuZILgRDczZfYdvx+GP3MMNKWX0SsUYkG3ySN/lJL0iEm/rgjoLDRT2gV8p+xfzeGPqzAjL/6/5N7JLjKdmzMCSi0umbFKIzV1UOBQMoTye8Kq9pmrZSKW/gcDeg2tDb+jFzAVMBMGA1UdJQQMMAoGCCsGAQUFBwMBMAoGCCqGSM49BAMDA2cAMGQCMDjiF3lBtlj+AiPu7k4AiaPcluAk8V7AFrKpNwfLCsmR8iSkjKuhMSWN0+Y1htUg+wIwVSY9CI8vbUJYWvOCd7n5IjLq2G0SF8Kw9k5BmX6XucnZxHc9dFgLm+6pcpuQg3YG"
export PUBLIC_KEY_TRUSTEDZONE="-----BEGIN CERTIFICATE-----\n${CERTIFICATE_CONTENT_TRUSTEDZONE}\n-----END CERTIFICATE-----"
echo -e "${PUBLIC_KEY_TRUSTEDZONE}" > certificate.trustedzone.crt
echo "Listing certificate PUBLIC_KEY_TRUSTEDZONE:"
cat certificate.trustedzone.crt

echo "**** Started ipfs final ****"
if [ -f ipfs.sh ]; then
    chmod +x ipfs.sh
    ./ipfs.sh
else
    echo "Warning: ipfs.sh not found. Skipping IPFS setup."
fi
echo "**** Finished ipfs final ****"

echo "Adding certificates for SECURELOCK into IMAGE REGISTRY smart contract..."
if [ -f image_registry_runner.py ]; then
    brew install python3
    python3 -m venv venv
    source venv/bin/activate
    pip3 install --no-cache --upgrade pip minio web3==5.17.0 eth_account python-dotenv requests
    python3 image_registry_runner.py
    deactivate
else
    echo "Warning: image_registry_runner.py not found. Skipping certificate addition to IMAGE REGISTRY smart contract."
fi

echo "Script completed successfully."