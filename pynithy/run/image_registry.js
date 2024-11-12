const Web3 = require('web3');
const { ethers } = require('ethers');
const { Account } = require('eth-lib/lib/account');
const { config } = require('dotenv');
const fs = require('fs');
const path = require('path');

config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
let BLOCKCHAIN_NETWORK = process.env.BLOCKCHAIN_NETWORK || "Bloxberg_Testnet";
let NETWORK_RPC = "https://bloxberg.ethernity.cloud";
let IMAGE_REGISTRY_ADDRESS = "0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31"; // bloxberg testnet
let CHAIN_ID = 8995;
let GAS = 9000000;
let GAS_PRICE = 1;

function setVars(network = "") {
    if (BLOCKCHAIN_NETWORK.includes("Bloxberg")) {
        IMAGE_REGISTRY_ADDRESS = "0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31";
    } else if (BLOCKCHAIN_NETWORK.includes("Polygon")) {
        if (BLOCKCHAIN_NETWORK.includes("Mainnet")) {
            NETWORK_RPC = "https://polygon-rpc.com";
            IMAGE_REGISTRY_ADDRESS = "0x689f3806874d3c8A973f419a4eB24e6fBA7E830F";
            CHAIN_ID = 137;
            GAS = 20000000;
            GAS_PRICE = 40500500010;
        } else {
            NETWORK_RPC = "https://rpc-amoy.polygon.technology";
            IMAGE_REGISTRY_ADDRESS = "0xF7F4eEb3d9a64387F4AcEb6d521b948E6E2fB049";
            CHAIN_ID = 80002;
            GAS = 20000000;
            GAS_PRICE = 1300000010;
        }
    }
}

setVars();

function isStringPrivateKey(privateKey) {
    try {
        let key = privateKey;
        if (!key.startsWith("0x")) {
            key = `0x${privateKey}`;
        }

        Web3.eth.accounts.privateKeyToAccount(key);
        return "OK";
    } catch (e) {
        return e.toString();
    }
}

async function checkAccountBalance() {
    try {
        const web3 = new ethers.providers.JsonRpcProvider(NETWORK_RPC);
        const account = new ethers.Wallet(PRIVATE_KEY, this.provider);
        const balance = await web3.getBalance(account.address);
        return Web3.utils.fromWei(balance, 'ether');
    } catch (e) {
        console.error(e);
        return 0;
    }
}

class ImageRegistry {
    constructor() {
        try {
            this.imageRegistryAbi = this.readContractAbi('image_registry.abi');
            this.imageRegistryAddress = IMAGE_REGISTRY_ADDRESS;
            console.log("imageRegistryAddress: ", this.imageRegistryAddress);
            this.provider = new ethers.providers.JsonRpcProvider(NETWORK_RPC);

            if (PRIVATE_KEY) {
                this.acct = new ethers.Wallet(PRIVATE_KEY, this.provider);
            } else {
                const _privateKey = new ethers.Wallet.createRandom().privateKey;
                this.acct = new ethers.Wallet(_privateKey, this.provider);
            }
            this.imageRegistryContract = new ethers.Contract(
                this.imageRegistryAddress,
                this.imageRegistryAbi,
                this.acct
            );
        } catch (e) {
            console.error(e);
        }
    }

    readContractAbi(contractName) {
        const filePath = path.join(__dirname, contractName);
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    async addTrustedZoneCert(certContent, ipfsHash, imageName, dockerComposeHash, enclaveNameTrustedZone, fee) {
        console.log("Adding trusted zone cert to image registry");
        const nonce = await this.provider.getTransactionCount(this.acct.address);

        const unicornTxn = this.imageRegistryContract.addTrustedZoneImage(
            ipfsHash, certContent, "v3", imageName, dockerComposeHash, enclaveNameTrustedZone, fee
        ).send({
            gas: GAS,
            chainId: CHAIN_ID,
            nonce: nonce,
            gasPrice: GAS_PRICE === 1 ? ethers.utils.parseUnits('1', 'mwei') : GAS_PRICE
        });

        console.log("transaction status: ", receipt.status);
        console.log("transaction receipt: ", receipt);
        if (receipt.status === 1) {
            console.log("Adding trusted zone cert transaction was successful!");
        } else {
            console.log("Adding trusted zone cert transaction was UNSUCCESSFUL!");
        }
        const signedTxn = await this.acct.signTransaction(unicornTxn);
        const receipt = await this.provider.sendTransaction(signedTxn.rawTransaction);
    }

    async addSecureLockImageCert(certContent, ipfsHash, imageName, version, dockerComposeHash, enclaveNameSecureLock, fee) {
        try {
            console.log("Adding secure lock image cert to image registry");
            // Fetch current nonce
            if (BLOCKCHAIN_NETWORK.includes("Polygon")) {
                console.log("Polygon Mainnet");
                let nonce = await this.provider.getTransactionCount(this.acct.address, 'pending');
                // Fetch current gas price and increase it
                let gasPrice = await this.provider.getGasPrice();
                gasPrice = gasPrice.mul(ethers.BigNumber.from(110)).div(ethers.BigNumber.from(100));
                const unicornTxn = await this.imageRegistryContract.addImage(
                    ipfsHash, certContent, version, imageName, dockerComposeHash, enclaveNameSecureLock, fee,
                    {
                        nonce: nonce,
                        gasPrice: gasPrice,
                    });
                // console.log("Transaction: ", unicornTxn);
                const receipt = await this.imageRegistryContract.provider.waitForTransaction(unicornTxn.hash);

                // console.log("transaction status: ", receipt.status);
                console.log("transaction receipt: ", unicornTxn.hash);
                if (receipt.status === 1) {
                    console.log("Adding secure lock image cert transaction was successful!");
                } else {
                    // console.log("receipt.status", receipt.status)
                    console.log("Image certificates already exist for this image!");
                }
            } else {
                const unicornTxn = await this.imageRegistryContract.addImage(
                    ipfsHash, certContent, version, imageName, dockerComposeHash, enclaveNameSecureLock, fee);
                // console.log("Transaction: ", unicornTxn);
                const receipt = await this.imageRegistryContract.provider.waitForTransaction(unicornTxn.hash);

                // console.log("transaction status: ", receipt.status);
                console.log("transaction receipt: ", unicornTxn.hash);
                if (receipt.status === 1) {
                    console.log("Adding secure lock image cert transaction was successful!");
                } else {
                    // console.log("receipt.status", receipt.status)
                    console.log("Image certificates already exist for this image!");
                }
            }

            // console.log("this.acct.address: ", this.acct.address);
            // console.log("private key", PRIVATE_KEY);
            // console.log('Getting nonce');
            // const nonce = await this.imageRegistryContract.provider.getTransactionCount(this.acct.address);


            // const signedTxn = await this.acct.signTransaction(unicornTxn);
            // const receipt = await this.provider.sendTransaction(signedTxn.rawTransaction);
        } catch (e) {
            // console.error(e);
            console.log("Image certificates already exist for this image!");
        }
    }

    async getImagePublicKeyCert(ipfsHash) {
        try {
            console.log("Getting image cert from image registry");
            // console.log("this.acct.address: ", this.acct.address);
            // console.log("private key", PRIVATE_KEY);
            // console.log('Getting nonce');
            // const nonce = await this.imageRegistryContract.provider.getTransactionCount(this.acct.address);
            const unicornTxn = await this.imageRegistryContract.getImageCertPublicKey(ipfsHash);
            console.log("unicornTxn: ", unicornTxn);
            // const receipt = await this.imageRegistryContract.provider.waitForTransaction(unicornTxn.hash);

            // console.log("transaction status: ", receipt.status);
            // // console.log("transaction receipt: ", unicornTxn);
            // if (receipt.status === 1) {
            //     console.log("");
            // } else {
            //     console.log("Adding secure lock image cert transaction was UNSUCCESSFUL!");
            // }
            // const signedTxn = await this.acct.signTransaction(unicornTxn);
            // const receipt = await this.provider.sendTransaction(signedTxn.rawTransaction);
        } catch (e) {
            console.error(e);
            console.log("Getting image cert transaction was UNSUCCESSFUL!");
        }
    }

    async validateSecureLockImageCert(certContent, ipfsHash, imageName, dockerComposeHash, enclaveNameSecureLock, fee) {
        console.log("Validating secure lock image cert in image registry");
        const nonce = await this.provider.getTransactionCount(this.acct.address);
        const unicornTxn = this.imageRegistryContract.validateSecureLockImage(
            ipfsHash, certContent, "v3", imageName, dockerComposeHash, enclaveNameSecureLock, fee
        ).send({
            gas: GAS,
            chainId: CHAIN_ID,
            nonce: nonce,
            gasPrice: GAS_PRICE === 1 ? ethers.utils.parseUnits('1', 'mwei') : GAS_PRICE
        });

        console.log("transaction status: ", receipt.status);
        console.log("transaction receipt: ", receipt);
        if (receipt.status === 1) {
            console.log("Validating secure lock image cert transaction was successful!");
        } else {
            console.log("Validating secure lock image cert transaction was UNSUCCESSFUL!");
        }
        const signedTxn = await this.acct.signTransaction(unicornTxn);
        const receipt = await this.provider.sendTransaction(signedTxn.rawTransaction);
    }

    async addSecureLockAndValidateImageCert(certContent, ipfsHash, imageName, dockerComposeHash, enclaveNameSecureLock, fee) {
        console.log("Adding and validating secure lock image cert in image registry");
        const nonce = await this.provider.getTransactionCount(this.acct.address);
        const unicornTxn = this.imageRegistryContract.addSecureLockAndValidateImage(
            ipfsHash, certContent, "v3", imageName, dockerComposeHash, enclaveNameSecureLock, fee
        ).send({
            gas: GAS,
            chainId: CHAIN_ID,
            nonce: nonce,
            gasPrice: GAS_PRICE === 1 ? ethers.utils.parseUnits('1', 'mwei') : GAS_PRICE
        });

        console.log("transaction status: ", receipt.status);
        console.log("transaction receipt: ", receipt);
        if (receipt.status === 1) {
            console.log("Adding and validating secure lock image cert transaction was successful!");
        } else {
            console.log("Adding and validating secure lock image cert transaction was UNSUCCESSFUL!");
        }
        const signedTxn = await this.acct.signTransaction(unicornTxn);
        const receipt = await this.provider.sendTransaction(signedTxn.rawTransaction);
    }

    async getTrustedZoneCert(ipfsHash) {
        const cert = await this.imageRegistryContract.getTrustedZoneCert(ipfsHash);
        return cert;
    }

    async getSecureLockCert(ipfsHash) {
        const cert = await this.imageRegistryContract.getSecureLockCert(ipfsHash);
        return cert;
    }

    async getImageDetails(ipfsHash) {
        try {
            const details = await this.imageRegistryContract.imageDetails(ipfsHash);
            return details;
        } catch (e) {
            return ['', '', ''];
        }
    }

    async _getLatestImageVersionPublicKey(projectName, version) {
        try {
            // console.log("Getting latest image version public key");
            const publicKey = await this.imageRegistryContract.getLatestImageVersionPublicKey(projectName, version);
            // console.log("public key: ", publicKey);
            return publicKey;
        } catch (e) {
            // console.error(e);
            return ['', '', ''];
        }
    }
}

(async () => {
    try {
        const [networkName, projectName, version, privateKey, action] = process.argv.slice(2);
        if (action === "validateAddress") {
            if (privateKey) {
                console.log(isStringPrivateKey(privateKey));
            }
            process.exit(0);
        }
        if (networkName && projectName) {
            BLOCKCHAIN_NETWORK = networkName;
        }
        setVars(networkName);
        if (action === "checkBalance") {
            const balance = await checkAccountBalance();
            console.log(`${balance} gas`);
            process.exit(0);
        }
        if (action === 'getTrustedZoneCert') {
            const imageRegistry = new ImageRegistry();
            const public = (await imageRegistry._getLatestImageVersionPublicKey(projectName, version))[1]
            console.log(public);
            return public;
        }

        const imageRegistry = new ImageRegistry();
        if (action === 'registerSecureLockImage') {
            const secureLock = fs.readFileSync("./registry/certificate.securelock.crt", 'utf8');
            // console.log("SECURELOCK:", secureLock);
            const ipfsHash = process.env.IPFS_HASH || "";
            console.log(`ipfsHash: ${ipfsHash}`);
            const ipfsDockerComposeHash = process.env.IPFS_DOCKER_COMPOSE_HASH || "";
            console.log(`ipfsDockerComposeHash: ${ipfsDockerComposeHash}`);
            const imageName = process.env.PROJECT_NAME || "";
            console.log(`imageName: ${imageName}`);
            const version = process.env.VERSION || "";
            const enclaveNameSecureLock = process.env.ENCLAVE_NAME_SECURELOCK || "";
            console.log(`enclaveNameSecureLock: ${enclaveNameSecureLock}`);
            const fee = process.env.DEVELOPER_FEE || "0";
            console.log(`fee: ${fee}`);
            await imageRegistry.addSecureLockImageCert(secureLock, ipfsHash, imageName, version, ipfsDockerComposeHash, enclaveNameSecureLock, fee);
            process.exit(0);
        }
        if (action === 'getImagePublicKey') {
            const ipfsHash = process.env.IPFS_HASH || "";
            await imageRegistry.getImagePublicKeyCert(ipfsHash);
            process.exit(0);
        }
        console.log(`Checking image: '${projectName}' on the ${networkName} blockchain...`);
        const imageHash = (await imageRegistry._getLatestImageVersionPublicKey(projectName, version))[0];
        console.log(`Image hash: ${imageHash}`);
        if (!imageHash) {
            console.log(`Image: '${projectName}' is available on the ${networkName} blockchain.`);
            process.exit(0);
        }
        const imageOwner = (await imageRegistry.getImageDetails(imageHash))[0];

        if (privateKey) {
            if (isStringPrivateKey(privateKey) === "OK") {
                const account = Account.fromPrivate(privateKey);
                if (imageOwner !== account.address) {
                    console.log(`!!! Image: '${projectName}' is owned by '${imageOwner}'.\nYou are not the account holder of the image.\nPlease change the project name and try again.\n`);
                    process.exit(1);
                }
            }
        }

        if (imageOwner) {
            console.log(`Image: '${projectName}' is owned by '${imageOwner}'.\nIf you are not the account holder, you will not be able to publish your project with the current name. Please change the project name and try again.\n`);
            process.exit(0);
        }

        console.log(`Image: '${projectName}' is available on the ${networkName} blockchain.`);
    } catch (e) {
        process.exit(0);
    }
})();