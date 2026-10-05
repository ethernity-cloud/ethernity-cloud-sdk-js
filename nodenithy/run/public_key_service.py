import requests
import time
import argparse

BASE_URL = "https://publickey.ethernity.cloud"


def submit_ipfs_hash(
    hhash,
    enclave_name,
    protocol_version,
    network,
    template_version,
    docker_composer_hash,
):
    url = f"{BASE_URL}/api/addHash"
    payload = {
        "hash": hhash,
        "enclave_name": enclave_name,
        "protocol_version": protocol_version,
        "network": network,
        "template_version": template_version,
        "docker_composer_hash": docker_composer_hash,
    }
    response = requests.post(url, json=payload)
    print(f"response:{response}")
    if response.status_code == 200:
        return response.json()
    else:
        print("Error:", response.con)
        exit(1)


def check_ipfs_hash_status(hash):
    url = f"{BASE_URL}/api/checkHash/{hash}"
    response = requests.get(url)
    if response.status_code == 200:
        return response.json()
    else:
        print("Error:", response.json())
        exit(1)


if __name__ == "__main__":
    # Example usage
    # python3 ./public_key_service.py --enclave_name ${ENCLAVE_NAME_SECURELOCK} --protocol_version ${VERSION} --network ${BLOCKCHAIN_NETWORK} --template_version ${VERSION}

    # read enclave_name, protocol_version, network, template_version from command line arguments
    parser = argparse.ArgumentParser()
    parser.add_argument("--enclave_name", help="Enclave name", required=True)
    parser.add_argument("--protocol_version", help="Protocol version", required=True)
    parser.add_argument("--network", help="Network", required=True)
    parser.add_argument("--template_version", help="Template version", required=True)

    args = parser.parse_args()
    enclave_name = args.enclave_name
    protocol_version = args.protocol_version
    network = args.network.lower().split("_")[1]
    template_version = args.template_version

    hhash = ""
    with open("IPFS_HASH.ipfs", "r") as f:
        hhash = f.read().strip()
    docker_composer_hash = ""
    with open("IPFS_DOCKER_COMPOSE_HASH.ipfs", "r") as f:
        docker_composer_hash = f.read().strip()

    print("IPFS Hash:", hhash)
    print("Enclave Name:", enclave_name)
    print("Protocol Version:", protocol_version)
    print("Network:", network)
    print("Template Version:", template_version)
    print("Docker Composer Hash:", docker_composer_hash)

    # Submit IPFS Hash
    submit_response = submit_ipfs_hash(
        hhash,
        enclave_name,
        protocol_version,
        network,
        template_version,
        docker_composer_hash,
    )
    print("Submit IPFS Hash Response:", submit_response)

    # The service answers publicKey 0 while the image is queued or running
    # (with status, percent and queuePosition), -1 when the extraction failed
    # (with reason) and the certificate when done.
    while True:
        check_response = check_ipfs_hash_status(hhash)
        if "publicKey" in check_response:
            if check_response["publicKey"] == 0:
                if check_response.get("status") == "running":
                    print(f"Public key extraction running, {check_response.get('percent', 0)}% done")
                else:
                    print(
                        f"Public key not available yet. Queue position: {check_response.get('queuePosition', 'Unknown')}"
                    )
            elif check_response["publicKey"] in (-1, "-1"):
                print(f"Public key extraction failed: {check_response.get('reason', 'reason not reported by the service')}")
                print("Fix the cause (keep the image pinned, build with the current SDK) and publish again: a new submission of the same hash runs the extraction again.")
                exit(1)
            else:
                print("Public Key:", check_response["publicKey"])
                # save public key to file
                with open("PUBLIC_KEY.txt", "w") as f:
                    f.write(check_response["publicKey"])
                break
        else:
            print("Unexpected response:", check_response)
            exit(1)

        time.sleep(10)  # Wait for 10 seconds before checking again
