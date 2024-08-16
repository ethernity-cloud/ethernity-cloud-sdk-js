#!/bin/bash

# Function to validate Ethereum account key
validate_ethereum_key() {
    local key=$1
    if [[ ${#key} -eq 66 && $key == 0x* ]]; then
        echo "Valid Ethereum key."
        return 0
    else
        echo "Invalid Ethereum key. Please ensure it starts with '0x' and is 66 characters long."
        return 1
    fi
}

# Function to create .env file and write to it
# Function to create .env file and write to it
write_env() {
    local key=$1
    local value=$2
    local env_file=".env"

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

# Function to prompt for a non-blank project name
get_project_name() {
    while true; do
        echo "Choose a name for your project: "
        read project_name
        if [[ -z "$project_name" ]]; then
            echo "Project name cannot be blank. Please enter a valid name."
        else
            echo "You have chosen the project name: $project_name"
            break
        fi
    done
}

# Function to display the options
display_options() {
    echo "Options:"
    for i in "${!options[@]}"; do
        echo "$((i + 1))) ${options[$i]}"
    done
}

# ask for a project name
get_project_name

echo ""


PS3="Select the type of code to be ran during the compute layer (default is Nodenity): "
options=("Nodenithy" "Pynithy" "Custom")
default_option="Nodenithy"



while true; do
    display_options
    read -p "$PS3" REPLY
    if [[ -z "$REPLY" ]]; then
        service_type=$default_option
        echo "No option selected. Defaulting to $default_option."
        break
    elif [[ "$REPLY" =~ ^[0-9]+$ ]] && [[ "$REPLY" -ge 1 && "$REPLY" -le ${#options[@]} ]]; then
        service_type=${options[$REPLY-1]}
        echo "You have selected the $service_type."
        break
    else
        echo "Invalid option $REPLY. Please select a valid number."
    fi
done

echo ""

if [ "$service_type" == "Custom" ]; then
    # Ask about using custom images
    echo "To use custom images, you need to specify the image tag, Docker login, password, and repository URL for the base image."
    echo "Enter Docker repository URL: "
    read docker_repo_url
    echo "Enter Docker Login (username): "
    read docker_login
    echo "Enter Password: "
    read docker_password
    echo "Enter the image tag: "
    read BASE_IMAGE_TAG

    echo "Validating docker login credentials..."
    echo "validating docker image tag..."
fi

echo ""

# Blockchain network setup
echo "On which Blockchain network do you want to have the app set up, as a starting point? (you can change it later in the .env file)"
echo "Note: The Ethernity Cloud supports Bloxberg and Polygon networks."
PS3="Select an option (default is Bloxberg Testnet): "
options=("Bloxberg Mainnet" "Bloxberg Testnet" "Polygon Mainnet" "Polygon Amoy Testnet")
default_option="Bloxberg Testnet"

while true; do
    display_options
    read -p "$PS3" REPLY
    if [[ -z "$REPLY" ]]; then
        blockchain_network=$default_option
        echo "No option selected. Defaulting to $default_option."
        break
    elif [[ "$REPLY" =~ ^[0-9]+$ ]] && [[ "$REPLY" -ge 1 && "$REPLY" -le ${#options[@]} ]]; then
        blockchain_network=${options[$REPLY-1]}
        echo "You have selected the $blockchain_network."
        break
    else
        echo "Invalid option $REPLY. Please select a valid number."
    fi
done

echo ""

echo "Checking if the project name (image name) is available on the "${blockchain_network// /_}" network and ownership..."
python $(pwd)/node_modules/ethernity-cloud-sdk-js/nodenithy/run/image_registry.py "${blockchain_network// /_}" "${project_name// /-}" v3

echo ""

# IPFS details
echo "Select the IPFS pinning service you want to use: "
PS3="Select an option (default is Ehternity): "
options=("Ehternity (best effort)" "Custom IPFS") #"Pinata" "Infura" have free tiers
default_option="Ehternity (best effort)"

while true; do
    display_options
    read -p "$PS3" REPLY
    if [[ -z "$REPLY" ]]; then
        ipfs_service=$default_option
        echo "No option selected. Defaulting to $default_option."
        break
    elif [[ "$REPLY" =~ ^[0-9]+$ ]] && [[ "$REPLY" -ge 1 && "$REPLY" -le ${#options[@]} ]]; then
        ipfs_service=${options[$REPLY-1]}
        echo "You have selected the $ipfs_service."
        break
    else
        echo "Invalid option $REPLY. Please select a valid number."
    fi
done

echo ""

if [ "$ipfs_service" == "Custom IPFS" ]; then
    echo "Enter the endpoint URL for the IPFS pinning service you want to use: "
    read custom_url
    echo "Enter the acceess token to be used when calling the IPFS pinning service: "
    read ipfs_token
fi
if [ "$ipfs_service" == "Ehternity (best effort)" ]; then
    echo "Using the Ehternity IPFS service endpoint."
    custom_url="https://ipfs.ethernity.cloud:5001"
fi
echo ""

# # Add project prerequisites based on the selected service
# if [ "$service_type" == "1" ]; then
#     echo "Adding prerequisites for Pynity..."
# elif [ "$service_type" == "2" ]; then
#     echo "Adding prerequisites for Nodenity..."
# fi

# Create src and src/serverless folders
mkdir -p src/serverless

# Ask if the user wants the app template as a starting point
echo "Do you want an 'Hello World' app template as a starting point? (yes/no)"
PS3="Select an option (default is yes): "
options=("yes" "no")
default_option="yes"

while true; do
    display_options
    read -p "$PS3" REPLY
    if [[ -z "$REPLY" ]]; then
        use_app_template=$default_option
        echo "No option selected. Defaulting to $default_option."
        break
    elif [[ "$REPLY" =~ ^[0-9]+$ ]] && [[ "$REPLY" -ge 1 && "$REPLY" -le ${#options[@]} ]]; then
        use_app_template=${options[$REPLY-1]}
        echo "You have selected the $use_app_template."
        break
    else
        echo "Invalid option $REPLY. Please select a valid number."
    fi
done

echo ""

if [ "$use_app_template" == "yes" ]; then
    echo "Bringing Frontend/Backend templates..."
    echo "  src/serverless/backend.js (Hello World function)"
    echo "  src/ec_helloworld_example.js (Hello World function call - Frontend)"
    # copy all files from node_modules/ethernity-cloud-sdk-js/nodenithy/src/ to src/
    cp -r node_modules/ethernity-cloud-sdk-js/nodenithy/src/* src/
    echo "Installing required packages..."
    npm install @ethernity-cloud/runner@0.0.26 @testing-library/jest-dom@5.17.0 @testing-library/react@13.4.0 @testing-library/user-event@13.5.0 react@18.3.1 react-dom@18.3.1 react-scripts@5.0.1 web-vitals@2.1.4 web3@4.9.0 dotenv@16.4.5


else
    echo "Define backend functions in src/ectasks to be available for Frontend interaction."
fi

write_env "PROJECT_NAME" "${project_name// /_}"
write_env "SERVICE_TYPE" "$service_type"
if [ "$service_type" == "Custom" ]; then
    write_env "BASE_IMAGE_TAG" "$base_image_tag"
    write_env "DOCKER_REPO_URL" "$docker_repo_url"
    write_env "DOCKER_LOGIN" "$docker_login"
    write_env "DOCKER_PASSWORD" "$docker_password"
elif [ "$service_type" == "Nodenithy" ]; then
    write_env "BASE_IMAGE_TAG" "$BASE_IMAGE_TAG"
    write_env "DOCKER_REPO_URL" "registry.scontain.com:5050"
    write_env "DOCKER_LOGIN" "ab@ethernity.cloud"
    write_env "DOCKER_PASSWORD" "BHtqnWPDmW5Qa!M"
elif [ "$service_type" == "Pynithy" ]; then
    write_env "BASE_IMAGE_TAG" "$BASE_IMAGE_TAG"
    write_env "DOCKER_REPO_URL" "$docker_repo_url"
    write_env "DOCKER_LOGIN" "$docker_login"
    write_env "DOCKER_PASSWORD" "$docker_password"
fi
# we need to "$blockchain_network" replace any space with _
write_env "BLOCKCHAIN_NETWORK" "${blockchain_network// /_}"
write_env "IPFS_ENDPOINT" "$custom_url"
write_env "IPFS_TOKEN" "$ipfs_token"
write_env "VERSION" "v3"
write_env "CI_COMMIT_BRANCH" "${project_name// /_}"

echo "To start the application, run the appropriate start command based on your setup."