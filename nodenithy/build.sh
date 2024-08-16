#!/bin/sh
source .env
echo "Building ${VERSION}"

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

# Downloading dependencies

rm -rf "./registry"

brew install jq
brew install wget
brew install python3
python3 -m venv venv
source venv/bin/activate
pip3 install --no-cache --upgrade pip minio web3==5.17.0 eth_account python-dotenv requests

docker stop $(docker ps -q)
docker rm $(docker ps -q) -f
docker rmi $(docker images -q) -f
docker system prune -f


# Changing to build directory
# cd build
# save current directory so that we can cd back to it at the end
current_dir=$(pwd)
echo "current_dir: $current_dir"
build_dir=$(pwd)/node_modules/ethernity-cloud-sdk-js/nodenithy/build
echo "build_dir: $build_dir"

src_dir="./src/serverless"
dest_dir="$build_dir/securelock/src/serverless"
# Create destination directory if it doesn't exist
echo "Creating destination directory: $dest_dir"
mkdir -p "$dest_dir"
if [ $? -eq 0 ]; then
    echo "Directory created successfully: $dest_dir"
else
    echo "Failed to create directory: $dest_dir"
fi

# Copy all files from source to destination
echo "Copying files from $src_dir to $dest_dir"
cp -r "$src_dir/"* "$dest_dir/"
if [ $? -eq 0 ]; then
    echo "Files copied successfully"
else
    echo "Failed to copy files"
fi

cd $build_dir

# Pulls default docker registry image and starts on local port 5001
docker pull registry:2
docker run -d --restart=always -p 5001:5000 --name registry registry:2

# Login to scontain registry using enviornment variables (The are set in Gitlab now)
docker login ${DOCKER_REPO_URL} -u ${DOCKER_LOGIN} -p ${DOCKER_PASSWORD}

CI_COMMIT_BRANCH=PROJECT_NAME

# Defining ENV variables for build
ENCLAVE_NAME_SECURELOCK=$(echo ENCLAVE_NAME_SECURELOCK_${VERSION}_${CI_COMMIT_BRANCH} | awk '{print toupper($0)}' | sed 's#/#_#' | sed 's#-#_#')

# Create new variable PREDECESSOR_NAME if it doesn't exits
# curl -s --request POST --header "PRIVATE-TOKEN: ${PRIVATE_TOKEN}" "https://gitlab.ethernity.cloud/api/v4/projects/${CI_PROJECT_ID}/variables" --form "key=${ENCLAVE_NAME_SECURELOCK}" --form "value=etny-${RUNNER_TYPE}-securelock-${VERSION}-testnet-0.0.0"
# echo "ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}"

# ENCLAVE_NAME_SECURELOCK=${ENCLAVE_NAME_SECURELOCK}"

echo
echo "ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}"
write_env "ENCLAVE_NAME_SECURELOCK" "${ENCLAVE_NAME_SECURELOCK}"
echo


echo "Building etny-securelock"
cd securelock/
cat Dockerfile.tmpl | sed  s/"__ENCLAVE_NAME_SECURELOCK__"/"${ENCLAVE_NAME_SECURELOCK}"/g > Dockerfile
docker build --build-arg ENCLAVE_NAME_SECURELOCK=${ENCLAVE_NAME_SECURELOCK} -t etny-securelock:latest .
docker tag etny-securelock localhost:5001/etny-securelock
# Pushes the resulting image to local registry
docker push localhost:5001/etny-securelock

docker save etny-securelock:latest -o etny-securelock.tar


# Defining ENV variables for build
ENCLAVE_NAME_TRUSTEDZONE=$(echo ENCLAVE_NAME_TRUSTEDZONE_${VERSION}_${CI_COMMIT_BRANCH} | awk '{print toupper($0)}' | sed 's#/#_#' | sed 's#-#_#')

# Create new variable PREDECESSOR_NAME if it doesn't exits
#curl -s --request POST --header "PRIVATE-TOKEN: ${PRIVATE_TOKEN}" "https://gitlab.ethernity.cloud/api/v4/projects/${CI_PROJECT_ID}/variables" --form "key=${ENCLAVE_NAME_TRUSTEDZONE}" --form "value=etny-${RUNNER_TYPE}-trustedzone-${VERSION}-testnet-0.0.0"

# ENCLAVE_NAME_TRUSTEDZONE=$(eval "echo \${$ENCLAVE_NAME_TRUSTEDZONE}")

echo
echo "ENCLAVE_NAME_TRUSTEDZONE: ${ENCLAVE_NAME_TRUSTEDZONE}"
write_env "ENCLAVE_NAME_TRUSTEDZONE" "${ENCLAVE_NAME_TRUSTEDZONE}"

echo

cd ../trustedzone/
echo "Building etny-trustedzone"
cat Dockerfile.tmpl | sed  s/"__ENCLAVE_NAME_TRUSTEDZONE__"/"${ENCLAVE_NAME_TRUSTEDZONE}"/g > Dockerfile
docker build --build-arg ENCLAVE_NAME_TRUSTEDZONE=${ENCLAVE_NAME_TRUSTEDZONE} -t etny-trustedzone:latest .
docker tag etny-trustedzone localhost:5001/etny-trustedzone
# Pushes the resulting image to local registry
docker push localhost:5001/etny-trustedzone
docker save etny-trustedzone:latest -o etny-trustedzone.tar


cd ../validator/
echo "Building validator"
docker build -t etny-validator:latest .
docker tag etny-validator localhost:5001/etny-validator
# Pushes the resulting image to local registry
docker push localhost:5001/etny-validator

docker save etny-validator:latest -o etny-validator.tar

cd ../

# Downloads las, squashes and pushes it to local registry
cd las
docker build -t etny-las .
docker tag etny-las localhost:5001/etny-las
docker push localhost:5001/etny-las
docker save etny-las:latest -o etny-las.tar


# Copying from the registry container the whole storage of the registry and saves it under 'registry'. This is where the artifacts are picked up from.
# cd ../../

# delete the ecld-backend.js files we copied to the build directory
rm -rf "$dest_dir"

# exit the python virtual environment
deactivate

cd $current_dir
docker cp registry:/var/lib/registry registry
