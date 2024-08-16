#!/bin/sh
source .env

# Function to write to .env file
write_env() {
    local key=$1
    local value=$2
    local env_file=".env"

    if [[ -f $env_file ]]; then
        if grep -q "^${key}=" "$env_file"; then
            sed -i '' "s/^${key}=.*/${key}=${value}/" "$env_file"
        else
            echo "${key}=${value}" >> "$env_file"
        fi
    else
        echo "${key}=${value}" > "$env_file"
    fi
}

# Function to display the options
display_options() {
    echo "Options:"
    for i in "${!options[@]}"; do
        echo "$((i + 1))) ${options[$i]}"
    done
}


if [[ -z $PROJECT_NAME ]] || [[ -z $BLOCKCHAIN_NETWORK ]] || [[ -z $PRIVATE_KEY ]] || [[ -z $DEVELOPER_FEE ]]; then
    echo "Do you have an existing wallet? (yes/no) "
    PS3="Select an option (default is yes): "
    options=("yes" "no")
    default_option="yes"

    while true; do
        display_options
        read -p "$PS3" REPLY
        if [[ -z "$REPLY" ]]; then
            has_wallet=$default_option
            echo "No option selected. Defaulting to $default_option."
            break
        elif [[ "$REPLY" =~ ^[0-9]+$ ]] && [[ "$REPLY" -ge 1 && "$REPLY" -le ${#options[@]} ]]; then
            has_wallet=${options[$REPLY-1]}
            echo "You have selected the $has_wallet."
            break
        else
            echo "Invalid option $REPLY. Please select a valid number."
        fi
    done

    if [[ $has_wallet == "no" ]]; then
        echo "Without a wallet, you will not be able to publish."
        echo "Please refer to Blockchain Wallets Documentation (https://docs.ethernity.cloud/ethernity-node/prerequisites-ethernity-node/blockchain-wallets)."
        exit 1
    fi

    echo ""

    # Prompt for private key
    echo "Enter your private key:"
    read private_key
    echo

    # Call the Python function
    result=$(python3 -c "
import sys
sys.path.insert(0, '$(pwd)/node_modules/ethernity-cloud-sdk-js/nodenithy/run')
from image_registry import is_string_private_key
print(is_string_private_key('$private_key'))
")

    while [[ $result != "OK" ]]; do
        # echo $private_key
        echo $result
        echo "Invalid private key. Please enter a valid private key:"
        echo ""
        # Prompt for private key
        echo "Enter your private key:"
        read private_key
        echo
        result=$(python3 -c "
import sys
sys.path.insert(0, '$(pwd)/node_modules/ethernity-cloud-sdk-js/nodenithy/run')
from image_registry import is_string_private_key
print(is_string_private_key('$private_key'))
")
    done

    echo "Inputed Private key is valid."


    # Write private key to .env
    write_env "PRIVATE_KEY" $private_key


    # Optionally check blockchain for required funds (placeholder for actual implementation)
    echo "Checking blockchain for required funds..."

    result=$(python3 -c "
import sys
sys.path.insert(0, '$(pwd)/node_modules/ethernity-cloud-sdk-js/nodenithy/run')
from image_registry import check_acount_balance
print(check_acount_balance())
")

    echo "Available funds: $result"
    echo

    # Check network and ownership (placeholder for actual implementation)
    echo "Checking if project name is available on ${BLOCKCHAIN_NETWORK} network and ownership..."
    echo
    python $(pwd)/node_modules/ethernity-cloud-sdk-js/nodenithy/run/image_registry.py "${BLOCKCHAIN_NETWORK}" "${PROJECT_NAME}" v3 "${PRIVATE_KEY}"
    if [ $? -ne 0 ]; then
    exit 1
    fi
    echo

    # Prompt for task percentage
    echo "Please specify the % of a task which will be transferred to your wallet upon successful execution (default 10%):"
    read task_percentage

    if [[ -z $task_percentage ]]; then
        task_percentage=10
    fi

    write_env "DEVELOPER_FEE" 10

else
    echo "Using PROJECT_NAME, BLOCKCHAIN_NETWORK, PRIVATE_KEY, DEVELOPER_FEE from .env"
    echo
    echo "Checking blockchain for required funds..."
    esult=$(python3 -c "
import sys
sys.path.insert(0, '$(pwd)/node_modules/ethernity-cloud-sdk-js/nodenithy/run')
from image_registry import check_acount_balance
print(check_acount_balance())
")
    echo "Available funds: $result"

    private_key="${PRIVATE_KEY}"
    # Call the Python function
    result=$(python3 -c "
import sys
sys.path.insert(0, '$(pwd)/node_modules/ethernity-cloud-sdk-js/nodenithy/run')
from image_registry import is_string_private_key
print(is_string_private_key('$private_key'))
")

    while [[ $result != "OK" ]]; do
        # echo $private_key
        echo $result
        echo "Invalid private key. Please enter a valid private key:"
        echo ""
        # Prompt for private key
        echo "Enter your private key:"
        read -s private_key
        echo
        result=$(python3 -c "
import sys
sys.path.insert(0, '$(pwd)/node_modules/ethernity-cloud-sdk-js/nodenithy/run')
from image_registry import is_string_private_key
print(is_string_private_key('$private_key'))
")
    done
    write_env "PRIVATE_KEY" $private_key
fi

if [ "${SERVICE_TYPE}" == "Nodenithy" ]; then
    echo "Adding prerequisites for Nodenithy..."
    ./node_modules/ethernity-cloud-sdk-js/nodenithy/run.sh
elif [ "${SERVICE_TYPE}" == "Pynithy" ]; then
    echo "Adding prerequisites for Pynithy..."
else
    echo "Somehthing went wrong"
    exit 1
fi