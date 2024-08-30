import os, sys

from web3 import Web3
from web3.middleware import geth_poa_middleware
from eth_account import Account

from dotenv import load_dotenv

load_dotenv()

PRIVATE_KEY = os.getenv("PRIVATE_KEY", "")

BLOCKCHAIN_NETWORK = os.getenv("BLOCKCHAIN_NETWORK", "Bloxberg_Testnet")

NETWORK_RPC = "https://bloxberg.ethernity.cloud"
IMAGE_REGISTRY_ADDRESS = "0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31"  # Bloxberg
CHAIN_ID = 8995
GAS = 9000000
GAS_PRICE = 1


def set_vars(network: str = "") -> None:
    global BLOCKCHAIN_NETWORK
    global IMAGE_REGISTRY_ADDRESS
    global NETWORK_RPC
    global CHAIN_ID
    global GAS
    global GAS_PRICE
    if "Bloxberg" in BLOCKCHAIN_NETWORK:
        if "Mainnet" in BLOCKCHAIN_NETWORK:
            IMAGE_REGISTRY_ADDRESS = "0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31"
        else:
            IMAGE_REGISTRY_ADDRESS = "0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31"
    elif "Polygon" in BLOCKCHAIN_NETWORK:
        if "Mainnet" in BLOCKCHAIN_NETWORK:
            NETWORK_RPC = "https://polygon-pokt.nodies.app"
            IMAGE_REGISTRY_ADDRESS = "0x689f3806874d3c8A973f419a4eB24e6fBA7E830F"
            CHAIN_ID = 137
            GAS = 20000000
            GAS_PRICE = 40500500010
        else:
            NETWORK_RPC = "https://rpc-amoy.polygon.technology`"
            IMAGE_REGISTRY_ADDRESS = "0xF7F4eEb3d9a64387F4AcEb6d521b948E6E2fB049"
            CHAIN_ID = 80002
            GAS = 20000000
            GAS_PRICE = 1300000010


set_vars()


def is_string_private_key(private_key: str) -> str:
    try:
        _acct = Account.privateKeyToAccount(private_key)
        return "OK"
    except Exception as e:
        return str(e)


def check_acount_balance() -> int:
    try:
        _acct = Account.privateKeyToAccount(PRIVATE_KEY)
        web3_provider = NETWORK_RPC
        w3 = Web3(Web3.HTTPProvider(web3_provider))
        w3.middleware_onion.inject(geth_poa_middleware, layer=0)

        address = _acct.address
        balance = w3.eth.getBalance(address)
        return Web3.fromWei(balance, "ether")  # type: ignore
    except Exception as e:
        print(e)
        return 0


class ImageRegistry:
    def __init__(self) -> None:
        self.acct = None  # type: ignore
        if PRIVATE_KEY:
            self.acct = Account.privateKeyToAccount(PRIVATE_KEY)

        image_registry_abi = self.__read_contract_abi("image_registry.abi")
        self.image_registry_address = IMAGE_REGISTRY_ADDRESS

        self.web3_provider = NETWORK_RPC
        self.w3 = Web3(Web3.HTTPProvider(self.web3_provider))
        self.w3.middleware_onion.inject(geth_poa_middleware, layer=0)

        self.image_registry = self.w3.eth.contract(
            address=self.w3.toChecksumAddress(self.image_registry_address),
            abi=image_registry_abi,
        )

    def __read_contract_abi(self, contract_name: str) -> str:
        f = open(os.path.dirname(os.path.realpath(__file__)) + f"/{contract_name}")
        contract_abi = f.read()
        f.close()
        return contract_abi

    # (string memory ipfsHash, string memory publicKey, string memory version, string memory imageName, string memory dockerComposeHash)
    def add_trusted_zone_cert(
        self,
        cert_content: str,
        ipfs_hash: str,
        image_name: str,
        docker_compose_hash: str,
        enclave_name_trustedzone: str,
        fee: str,
    ) -> None:
        print("Adding trusted zone cert to image registry")
        nonce = self.w3.eth.getTransactionCount(self.acct.address)
        print(f"Nonce: {nonce}")
        print("ipfs_hash: ", ipfs_hash)
        print("cert_content: ", cert_content)
        print("image_name: ", image_name)
        print("docker_compose_hash: ", docker_compose_hash)
        print("enclave_name_trustedzone: ", enclave_name_trustedzone)
        print("fee: ", fee)
        unicorn_txn = self.image_registry.functions.addTrustedZoneImage(
            ipfs_hash,
            cert_content,
            "v3",
            image_name,
            docker_compose_hash,
            enclave_name_trustedzone,
            fee,
        ).buildTransaction(
            {
                "gas": GAS,
                "chainId": CHAIN_ID,
                "nonce": nonce,
                "gasPrice": self.w3.toWei("1", "mwei") if GAS_PRICE == 1 else GAS_PRICE,
            }
        )

        signed_txn = self.w3.eth.account.sign_transaction(
            unicorn_txn, private_key=self.acct.key
        )
        self.w3.eth.sendRawTransaction(signed_txn.rawTransaction)
        # self.transaction = unicorn_tx signed
        hash = self.w3.toHex(self.w3.sha3(signed_txn.rawTransaction))

        try:
            receipt = self.w3.eth.waitForTransactionReceipt(hash)
        except Exception as e:
            print(f"An error occurred while sending transaction", e)
            raise

        print("transaction status: ", receipt.status)
        print("transaction receipt: ", receipt)
        if receipt.status == 1:
            print("Adding trusted zone cert transaction was successful!")
        else:
            print("Adding trusted zone cert  transaction was UNSUCCESSFUL!")

    def add_secure_lock_image_cert(
        self,
        cert_content: str,
        ipfs_hash: str,
        image_name: str,
        docker_compose_hash: str,
        enclave_name_securelock: str,
        fee: str,
    ) -> None:
        print("Adding secure lock cert to image registry")
        nonce = self.w3.eth.getTransactionCount(self.acct.address)
        unicorn_txn = self.image_registry.functions.addImage(
            ipfs_hash,
            cert_content,
            "v3",
            image_name,
            docker_compose_hash,
            enclave_name_securelock,
            int(fee),
        ).buildTransaction(
            {
                "gas": GAS,
                "chainId": CHAIN_ID,
                "nonce": nonce,
                "gasPrice": self.w3.toWei("1", "mwei") if GAS_PRICE == 1 else GAS_PRICE,
            }
        )
        signed_txn = self.w3.eth.account.sign_transaction(
            unicorn_txn, private_key=self.acct.key
        )
        self.w3.eth.sendRawTransaction(signed_txn.rawTransaction)
        # self.transaction = unicorn_tx signed
        hash = self.w3.toHex(self.w3.sha3(signed_txn.rawTransaction))

        try:
            receipt = self.w3.eth.waitForTransactionReceipt(hash)
        except Exception as e:
            print(f"An error occurred while sending transaction", e)
            raise

        print("transaction status: ", receipt.status)
        print("transaction receipt: ", receipt)
        if receipt.status == 1:
            print("Adding secure lock transaction was successful!")
        else:
            print("Adding secure lock transaction was UNSUCCESSFUL!")

    def validate_secure_lock_image_cert(self, ipfs_hash: str) -> None:
        print("Validating secure lock cert to image registry")
        nonce = self.w3.eth.getTransactionCount(self.acct.address)
        unicorn_txn = self.image_registry.functions.validateImage(
            ipfs_hash
        ).buildTransaction(
            {
                "gas": GAS,
                "chainId": CHAIN_ID,
                "nonce": nonce,
                "gasPrice": self.w3.toWei("1", "mwei") if GAS_PRICE == 1 else GAS_PRICE,
            }
        )
        signed_txn = self.w3.eth.account.sign_transaction(
            unicorn_txn, private_key=self.acct.key
        )
        self.w3.eth.sendRawTransaction(signed_txn.rawTransaction)
        # self.transaction = unicorn_tx signed
        hash = self.w3.toHex(self.w3.sha3(signed_txn.rawTransaction))

        try:
            receipt = self.w3.eth.waitForTransactionReceipt(hash)
        except Exception as e:
            print(f"An error occurred while sending transaction", e)
            raise

        print("transaction status: ", receipt.status)
        print("transaction receipt: ", receipt)
        if receipt.status == 1:
            print("Validating secure lock cert transaction was successful!")
        else:
            print("Validating secure lock cert transaction was UNSUCCESSFUL!")

    def add_secure_lock_and_validate_image_cert(
        self,
        cert_content: str,
        ipfs_hash: str,
        image_name: str,
        docker_compose_hash: str,
        enclave_name_securelock: str,
        fee: str,
    ) -> None:
        self.add_secure_lock_image_cert(
            cert_content,
            ipfs_hash,
            image_name,
            docker_compose_hash,
            enclave_name_securelock,
            fee,
        )
        # self.validate_secure_lock_image_cert(ipfs_hash)

    def get_trusted_zone_cert(self, image_ipfs_hash: str) -> None:
        cert = self.image_registry.caller().getTrustedZoneImageCertPublicKey(
            image_ipfs_hash
        )
        print(cert)

    def get_secure_lock_cert(self, image_ipfs_hash: str) -> None:
        cert = self.image_registry.caller().getImageCertPublicKey(image_ipfs_hash)
        print(cert)

    def get_image_details(self, image_ipfs_hash: str) -> list:
        imageDetails = self.image_registry.caller().imageDetails(image_ipfs_hash)
        return imageDetails

    def get_latest_image_version_public_key(
        self, image_name: str, image_version: str
    ) -> list:
        imageVersionPublicKey = (
            self.image_registry.caller().getLatestImageVersionPublicKey(
                image_name, image_version
            )
        )
        return imageVersionPublicKey


if __name__ == "__main__":
    try:
        network_name = sys.argv[1]
        project_name = sys.argv[2]
        version = sys.argv[3]
        if network_name and project_name:
            BLOCKCHAIN_NETWORK = network_name
    except Exception as e:
        print(e)
        exit(0)

    private_key = ""
    try:
        private_key = sys.argv[4]
    except:
        pass
    set_vars(network_name)

    image_registry = ImageRegistry()
    try:
        imageHash = image_registry.get_latest_image_version_public_key(
            project_name, version
        )[0]
        imageOwner = image_registry.get_image_details(imageHash)[0]

        if private_key:
            if is_string_private_key(private_key) == "OK":
                # check if the imageOwner is the same as the private key owner
                _acct = Account.privateKeyToAccount(private_key)
                # print("private key account address:" + _acct.address)
                if imageOwner != _acct.address:
                    print(
                        f"!!! Image: '{project_name}' Version: '{version}' is owned by '{imageOwner}'.\nYou are not the account holder of the image.\nPlease change the project name and try again.\n"
                    )
                    exit(1)

        # print(f"Image Owner: {imageOwner}")
        if imageOwner:
            print(
                f"Image: '{project_name}' Version: '{version}' is owned by '{imageOwner}'.\nIf you are not the account holder, you will not be able to publish your project with the current name. Please change the project name and try again.\n"
            )
            exit(0)
    except Exception as e:
        # print(e)
        pass

    print(
        f"Image: '{project_name}' Version: '{version}' is available on the {network_name} blockchain."
    )
