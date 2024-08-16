import os

from web3 import Web3
from web3.middleware import geth_poa_middleware
from eth_account import Account

privatekey = "abf7fc132da9391d9926918d772d50c0e5d6c81817f1e26d54789037ce23b625"


class ImageRegistry:
    def __init__(self):
        self.acct = Account.privateKeyToAccount(privatekey)
        image_registry_abi = self.__read_contract_abi('image_registry.abi')
        self.image_registry_address = "0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31"

        self.web3_provider = "https://bloxberg.ethernity.cloud"
        self.w3 = Web3(Web3.HTTPProvider(self.web3_provider))
        self.w3.middleware_onion.inject(geth_poa_middleware, layer=0)

        self.image_registry = self.w3.eth.contract(address=self.w3.toChecksumAddress(self.image_registry_address),
                                                   abi=image_registry_abi)

    def __read_contract_abi(self, contract_name):
        f = open(os.path.dirname(os.path.realpath(__file__)) + f'/{contract_name}')
        contract_abi = f.read()
        f.close()
        return contract_abi

    # (string memory ipfsHash, string memory publicKey, string memory version, string memory imageName, string memory dockerComposeHash)
    def add_trusted_zone_cert(self, cert_content, ipfs_hash, image_name, docker_compose_hash, enclave_name_trustedzone, fee):
        print('Adding trusted zone cert to image registry')
        nonce = self.w3.eth.getTransactionCount(self.acct.address)
        unicorn_txn = self.image_registry.functions.addTrustedZoneImage(
            ipfs_hash, cert_content, 'v3', image_name, docker_compose_hash, enclave_name_trustedzone, fee
        ).buildTransaction({
            'gas': 9000000,
            'chainId': 8995,
            'nonce': nonce,
            'gasPrice': self.w3.toWei("1", "mwei"),
        })

        signed_txn = self.w3.eth.account.sign_transaction(unicorn_txn, private_key=self.acct.key)
        self.w3.eth.sendRawTransaction(signed_txn.rawTransaction)
        # self.transaction = unicorn_tx signed
        hash = self.w3.toHex(self.w3.sha3(signed_txn.rawTransaction))

        try:
            receipt = self.w3.eth.waitForTransactionReceipt(hash)
        except Exception as e:
            print(f'An error occurred while sending transaction', e)
            raise

        print('transaction status: ', receipt.status)
        print('transaction receipt: ', receipt)
        if receipt.status == 1:
            print("Adding trusted zone cert transaction was successful!")
        else:
            print("Adding trusted zone cert  transaction was UNSUCCESSFUL!")

    def add_secure_lock_image_cert(self, cert_content, ipfs_hash, image_name, docker_compose_hash, enclave_name_securelock, fee):
        print('Adding secure lock cert to image registry')
        nonce = self.w3.eth.getTransactionCount(self.acct.address)
        unicorn_txn = self.image_registry.functions.addImage(
            ipfs_hash, cert_content, 'v3', image_name, docker_compose_hash, enclave_name_securelock, fee
        ).buildTransaction({
            'gas': 9000000,
            'chainId': 8995,
            'nonce': nonce,
            'gasPrice': self.w3.toWei("1", "mwei"),
        })
        signed_txn = self.w3.eth.account.sign_transaction(unicorn_txn, private_key=self.acct.key)
        self.w3.eth.sendRawTransaction(signed_txn.rawTransaction)
        # self.transaction = unicorn_tx signed
        hash = self.w3.toHex(self.w3.sha3(signed_txn.rawTransaction))

        try:
            receipt = self.w3.eth.waitForTransactionReceipt(hash)
        except Exception as e:
            print(f'An error occurred while sending transaction', e)
            raise

        print('transaction status: ', receipt.status)
        print('transaction receipt: ', receipt)
        if receipt.status == 1:
            print("Adding secure lock transaction was successful!")
        else:
            print("Adding secure lock transaction was UNSUCCESSFUL!")

    def validate_secure_lock_image_cert(self, ipfs_hash):
        print('Validating secure lock cert to image registry')
        nonce = self.w3.eth.getTransactionCount(self.acct.address)
        unicorn_txn = self.image_registry.functions.validateImage(
            ipfs_hash
        ).buildTransaction({
            'gas': 9000000,
            'chainId': 8995,
            'nonce': nonce,
            'gasPrice': self.w3.toWei("1", "mwei"),
        })
        signed_txn = self.w3.eth.account.sign_transaction(unicorn_txn, private_key=self.acct.key)
        self.w3.eth.sendRawTransaction(signed_txn.rawTransaction)
        # self.transaction = unicorn_tx signed
        hash = self.w3.toHex(self.w3.sha3(signed_txn.rawTransaction))

        try:
            receipt = self.w3.eth.waitForTransactionReceipt(hash)
        except Exception as e:
            print(f'An error occurred while sending transaction', e)
            raise

        print('transaction status: ', receipt.status)
        print('transaction receipt: ', receipt)
        if receipt.status == 1:
            print("Validating secure lock cert transaction was successful!")
        else:
            print("Validating secure lock cert transaction was UNSUCCESSFUL!")

    def add_secure_lock_and_validate_image_cert(self, cert_content, ipfs_hash, image_name, docker_compose_hash, enclave_name_securelock, fee):
        self.add_secure_lock_image_cert(cert_content, ipfs_hash, image_name, docker_compose_hash, enclave_name_securelock, fee)
        self.validate_secure_lock_image_cert(ipfs_hash)

    def get_trusted_zone_cert(self, image_ipfs_hash):
        cert = self.image_registry.caller().getTrustedZoneImageCertPublicKey(image_ipfs_hash)
        print(cert)

    def get_secure_lock_cert(self, image_ipfs_hash):
        cert = self.image_registry.caller().getImageCertPublicKey(image_ipfs_hash)
        print(cert)


if __name__ == '__main__':
    image_registry = ImageRegistry()

    # image_registry.add_trusted_zone_cert('cert-content', 'ipfs-hash')

    # image_registry.add_secure_lock_and_validate_image_cert('cert-content', 'ipfs-hash')

    image_registry.get_trusted_zone_cert('QmVPSWaDkSwMYjHd9G8SMrCwRH2KuXHzEWSnXQ7N7YsgvJ')
    image_registry.get_secure_lock_cert('QmVPSWaDkSwMYjHd9G8SMrCwRH2KuXHzEWSnXQ7N7YsgvJ')
