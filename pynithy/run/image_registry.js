const Web3 = require('web3');
const { ethers } = require('ethers');
const { config } = require('dotenv');
const fs = require('fs');
const path = require('path');
const { isRevert, revertReason } = require('../../revert.js');

config();

// The publishing wallet's key comes from the environment only: a command line
// is visible to other processes and is printed when the command fails.
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
let BLOCKCHAIN_NETWORK = process.env.BLOCKCHAIN_NETWORK || "Bloxberg_Testnet";
let NETWORK_RPC = "https://bloxberg.ethernity.cloud";
let IMAGE_REGISTRY_ADDRESS = "0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1"; // bloxberg testnet (ECImageRegistryV3)
let CHAIN_ID = 8995;
let GAS = 9000000;
let GAS_PRICE = 1;

function setVars(network = "") {
    if (BLOCKCHAIN_NETWORK.includes("Bloxberg")) {
        // The bloxberg testnet reads ECImageRegistryV3; mainnet the original registry.
        IMAGE_REGISTRY_ADDRESS = BLOCKCHAIN_NETWORK.includes("Testnet")
            ? "0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1"
            : "0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31";
    } else if (BLOCKCHAIN_NETWORK.includes("Polygon")) {
        if (BLOCKCHAIN_NETWORK.includes("Mainnet")) {
            NETWORK_RPC = "https://polygon-rpc.com";
            IMAGE_REGISTRY_ADDRESS = "0x689f3806874d3c8A973f419a4eB24e6fBA7E830F";
            CHAIN_ID = 137;
            GAS = 20000000;
            GAS_PRICE = 40500500010;
        } else {
            NETWORK_RPC = "https://polygon-amoy-bor-rpc.publicnode.com";
            IMAGE_REGISTRY_ADDRESS = "0xF7F4eEb3d9a64387F4AcEb6d521b948E6E2fB049";
            CHAIN_ID = 80002;
            GAS = 20000000;
            GAS_PRICE = 1300000010;
        }
    } else if (BLOCKCHAIN_NETWORK.includes("LitVM")) {
        NETWORK_RPC = "https://liteforge.rpc.caldera.xyz/infra-partner-http";
        IMAGE_REGISTRY_ADDRESS = "0x55e0ad455Be85162b71a790f00Fc305680E3CE53";
        CHAIN_ID = 4441;
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

// The address of a private key given with or without its 0x prefix.
function walletAddress(privateKey) {
    return new ethers.Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`).address;
}

// REWARD_ADDRESS from the environment: where the image's developer fee is
// paid when not the publishing wallet, or "" when unset. ECImageRegistryV3
// refuses the zero address, so it is refused here before any transaction.
function rewardAddressFromEnv() {
    const rewardAddress = (process.env.REWARD_ADDRESS || "").trim();
    if (!rewardAddress) return "";
    if (!ethers.utils.isAddress(rewardAddress)) {
        throw new Error(`REWARD_ADDRESS ${rewardAddress} is not an address`);
    }
    if (rewardAddress.toLowerCase() === ethers.constants.AddressZero) {
        throw new Error("REWARD_ADDRESS is the zero address; leave it empty to be paid at the publishing wallet");
    }
    return rewardAddress;
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
            // stderr: callers read an action's result from stdout.
            console.error("imageRegistryAddress: ", this.imageRegistryAddress);
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

    // Record the securelock with its certificate on a V1 registry, in one
    // addImage call. A failure, including the registry's refusal, throws.
    async addSecureLockImageCert(certContent, ipfsHash, imageName, version, dockerComposeHash, enclaveNameSecureLock, fee) {
        console.log("Adding secure lock image cert to image registry");
        await this.write('addImage', ipfsHash, certContent, version, imageName, dockerComposeHash, enclaveNameSecureLock, fee);
        console.log("Adding secure lock image cert transaction was successful!");
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

    // Where the image's developer fee is paid. The registry records the
    // publishing wallet at registration; only the image's owner changes it.
    async setRewardAddress(ipfsHash, rewardAddress) {
        const current = await this.imageRegistryContract.getRewardAddress(ipfsHash);
        if (current.toLowerCase() === rewardAddress.toLowerCase()) {
            console.log(`Reward address is already ${rewardAddress}`);
            return;
        }
        console.log(`Setting the reward address to ${rewardAddress}`);
        await this.write('changeImageRewardAddress', ipfsHash, rewardAddress);
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

    // Whether the registry is an ECImageRegistryV2 or later, which records an
    // image before its certificate exists (registerImage, then setImageCert).
    // A V1 registry has no pendingImages() and reverts; a node that does not
    // answer is an error, not a V1 registry.
    async isV2() {
        try {
            await this.imageRegistryContract.pendingImages();
            return true;
        } catch (e) {
            if (isRevert(e)) return false;
            throw e;
        }
    }

    // The wallet that owns the securelock name on an ECImageRegistryV3 or
    // later (the zero address while nobody does), or null on a registry
    // without name owners. Only the owner publishes under the name, and a
    // name and its -unsafe twin have one owner.
    async imageNameOwner(imageName) {
        try {
            return await this.imageRegistryContract.imageNameOwner(imageName);
        } catch (e) {
            if (isRevert(e)) return null;
            throw e;
        }
    }

    // Send `method(...args)` from the publishing wallet. It is simulated
    // first, so a call the registry refuses stops here with the registry's
    // reason, then sent with its gas estimate plus 30%: what a registry write
    // costs depends on the pending list, which other publishers change
    // between the estimate and the block.
    async write(method, ...args) {
        try {
            await this.imageRegistryContract.callStatic[method](...args);
        } catch (e) {
            throw new Error(`the image registry refuses ${method}: ${revertReason(e, this.imageRegistryContract.interface)}`);
        }
        const gas = await this.imageRegistryContract.estimateGas[method](...args);
        const overrides = { gasLimit: gas.mul(13).div(10) };
        if (BLOCKCHAIN_NETWORK.includes("Polygon")) {
            overrides.nonce = await this.provider.getTransactionCount(this.acct.address, 'pending');
            overrides.gasPrice = (await this.provider.getGasPrice()).mul(110).div(100);
        }
        const tx = await this.imageRegistryContract[method](...args, overrides);
        const receipt = await this.imageRegistryContract.provider.waitForTransaction(tx.hash);
        console.log("transaction receipt: ", tx.hash);
        if (receipt.status !== 1) {
            throw new Error(`${method} reverted (${tx.hash})`);
        }
    }

    // Record the securelock on a V2 registry before its certificate exists:
    // name, protocol version v3, compose, session, the publisher's fee and the
    // IPFS node that holds the image (a multiaddr, or ""). A hash this wallet
    // already registered with the same name, compose and session is left as
    // it is; a hash another wallet registered is refused, and so is a name
    // another wallet owns. The record cannot be changed, so a hash registered
    // with another compose or session is refused too: the nodes would fetch
    // the compose the record names.
    async registerImage(ipfsHash, imageName, dockerComposeHash, session, fee, ipfsPeer) {
        const details = await this.imageRegistryContract.imageDetails(ipfsHash);
        if (details.owner !== ethers.constants.AddressZero) {
            if (details.owner.toLowerCase() !== this.acct.address.toLowerCase()) {
                throw new Error(`${ipfsHash} is registered by ${details.owner}, not by this wallet`);
            }
            const differing = [
                ['name', details.name, imageName],
                ['compose', details.dockerComposeHash, dockerComposeHash],
                ['session', details.session, session],
            ].filter(([, recorded, wanted]) => recorded !== wanted);
            if (differing.length) {
                const recorded = differing.map(([field, value]) => `${field} ${value}`).join(', ');
                const wanted = differing.map(([field, , value]) => `${field} ${value}`).join(', ');
                throw new Error(`${ipfsHash} is registered with ${recorded}, and this publish has ${wanted}; run ecld-build to publish a new version`);
            }
            console.log(`${ipfsHash} is already registered`);
            return false;
        }
        const nameOwner = await this.imageNameOwner(imageName);
        if (nameOwner && nameOwner !== ethers.constants.AddressZero
            && nameOwner.toLowerCase() !== this.acct.address.toLowerCase()) {
            throw new Error(`the image name ${imageName} belongs to ${nameOwner}; publish under another PROJECT_NAME`);
        }
        console.log(`Registering ${imageName} v3 as ${ipfsHash} (compose ${dockerComposeHash}, peer ${ipfsPeer || 'none'})`);
        await this.write('registerImage',
            ipfsHash, "v3", imageName, dockerComposeHash, session, Number(fee), ipfsPeer || "");
        return true;
    }

    // Write the certificate of a registered image, once, from the wallet that
    // registered it. A certificate already there is left as it is.
    async setImageCert(ipfsHash, cert) {
        const details = await this.imageRegistryContract.imageDetails(ipfsHash);
        if (details.owner === ethers.constants.AddressZero) {
            throw new Error(`${ipfsHash} is not registered`);
        }
        if (details.certPublicKey) {
            if (details.certPublicKey.trim() === cert.trim()) {
                console.log(`The certificate of ${ipfsHash} is already registered`);
                return false;
            }
            throw new Error(`${ipfsHash} already has a certificate, and it differs from the extracted one`);
        }
        console.log(`Registering the certificate of ${ipfsHash}`);
        await this.write('setImageCert', ipfsHash, cert);
        return true;
    }
}

(async () => {
    try {
        const [networkName, projectName, version, action] = process.argv.slice(2);
        if (action === "validateAddress") {
            if (PRIVATE_KEY) {
                console.log(isStringPrivateKey(PRIVATE_KEY));
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
        // The certificate of the trustedzone's own record. getLatestImageVersionPublicKey
        // reads the securelock records instead: ECImageRegistryV2 and V3 revert it
        // for a trustedzone, and the bloxberg mainnet and LitVM registries return a
        // different certificate for the same name.
        if (action === 'getTrustedZoneCert') {
            const imageRegistry = new ImageRegistry();
            try {
                const latest = await imageRegistry.imageRegistryContract.getLatestTrustedZoneImageCertPublicKey(projectName, version);
                console.log(latest[1]);
            } catch (e) {
                console.error(`No trustedzone ${projectName} (${version}) in image registry ${IMAGE_REGISTRY_ADDRESS}: ${e.reason || e.message}`);
            }
            return;
        }
        // The CAS session name recorded for the trustedzone template's latest
        // image: what the compose's SCONE_CONFIG_ID for the trustedzone must name.
        if (action === 'getTrustedZoneSession') {
            const imageRegistry = new ImageRegistry();
            const latest = await imageRegistry.imageRegistryContract.getLatestTrustedZoneImageCertPublicKey(projectName, version);
            const session = await imageRegistry.imageRegistryContract.getTrustedZoneImageSession(latest[0]);
            console.log(session);
            return session;
        }

        const imageRegistry = new ImageRegistry();
        // Whether the registry records images before their certificate.
        if (action === 'isV2') {
            try {
                console.log((await imageRegistry.isV2()) ? 'true' : 'false');
            } catch (e) {
                console.error(`Could not read the image registry ${IMAGE_REGISTRY_ADDRESS}: ${e.reason || e.message}`);
                process.exit(1);
            }
            process.exit(0);
        }
        // Record the image before its certificate (V2): IPFS_HASH,
        // IPFS_DOCKER_COMPOSE_HASH, PROJECT_NAME (the name registered),
        // ENCLAVE_NAME_SECURELOCK (the session), DEVELOPER_FEE and IPFS_PEER
        // (the publish's node) come from the environment.
        if (action === 'registerImage') {
            try {
                const rewardAddress = rewardAddressFromEnv();
                await imageRegistry.registerImage(
                    process.env.IPFS_HASH || "", process.env.PROJECT_NAME || "",
                    process.env.IPFS_DOCKER_COMPOSE_HASH || "", process.env.ENCLAVE_NAME_SECURELOCK || "",
                    process.env.DEVELOPER_FEE || "0", process.env.IPFS_PEER || "");
                if (rewardAddress) {
                    await imageRegistry.setRewardAddress(process.env.IPFS_HASH || "", rewardAddress);
                }
            } catch (e) {
                console.error(`Could not register the image: ${e.reason || e.message}`);
                process.exit(1);
            }
            process.exit(0);
        }
        // Write the extracted certificate of a registered image (V2).
        if (action === 'setImageCert') {
            try {
                const cert = fs.readFileSync("./registry/certificate.securelock.crt", 'utf8');
                await imageRegistry.setImageCert(process.env.IPFS_HASH || "", cert);
            } catch (e) {
                console.error(`Could not register the certificate: ${e.reason || e.message}`);
                process.exit(1);
            }
            process.exit(0);
        }
        if (action === 'registerSecureLockImage') {
            const secureLock = fs.readFileSync("./registry/certificate.securelock.crt", 'utf8');
            // console.log("SECURELOCK:", secureLock);
            const ipfsHash = process.env.IPFS_HASH || "";
            console.log(`ipfsHash: ${ipfsHash}`);
            const ipfsDockerComposeHash = process.env.IPFS_DOCKER_COMPOSE_HASH || "";
            console.log(`ipfsDockerComposeHash: ${ipfsDockerComposeHash}`);
            const imageName = process.env.PROJECT_NAME || "";
            console.log(`imageName: ${imageName}`);
            const enclaveVersion = process.env.VERSION || "";
            const enclaveNameSecureLock = process.env.ENCLAVE_NAME_SECURELOCK || "";
            console.log(`enclaveNameSecureLock: ${enclaveNameSecureLock}`);
            const fee = process.env.DEVELOPER_FEE || "0";
            console.log(`fee: ${fee}`);

            // Register the SAME build under two registry version keys:
            //   "v3"           -> the moving "latest" pointer the runner resolves by
            //                     default (getLatestImageVersionPublicKey(name,"v3")).
            //                     This MUST be "v3" (the protocol version), NOT the
            //                     enclave/template VERSION -- registering under the
            //                     VERSION (e.g. "21") wrote the pointer where the
            //                     runner never looks, so it kept using a stale image.
            //   <VERSION>      -> an immutable per-version entry (e.g. "22") so this
            //                     exact build can be pinned/rolled back to later.
            // The contract stores each (name,version) channel append-only.
            const versionKeys = ["v3"];
            if (enclaveVersion && enclaveVersion !== "v3") versionKeys.push(enclaveVersion);
            for (const versionKey of versionKeys) {
                console.log(`Registering securelock under version '${versionKey}'`);
                try {
                    await imageRegistry.addSecureLockImageCert(secureLock, ipfsHash, imageName, versionKey, ipfsDockerComposeHash, enclaveNameSecureLock, fee);
                } catch (e) {
                    // The registry refuses a hash the (name, version) channel already holds.
                    if ((e.message || '').includes('Image hash is already in registry')) {
                        console.log(`The securelock is already registered under version '${versionKey}'`);
                        continue;
                    }
                    console.error(`Could not register the securelock under version '${versionKey}': ${e.reason || e.message}`);
                    process.exit(1);
                }
            }
            // REWARD_ADDRESS: where the image's developer fee is paid, when not
            // the publishing wallet.
            try {
                const rewardAddress = rewardAddressFromEnv();
                if (rewardAddress) {
                    await imageRegistry.setRewardAddress(ipfsHash, rewardAddress);
                }
            } catch (e) {
                console.error(`Could not set the reward address: ${e.reason || e.message}`);
                process.exit(1);
            }
            process.exit(0);
        }
        if (action === 'getImagePublicKey') {
            const ipfsHash = process.env.IPFS_HASH || "";
            await imageRegistry.getImagePublicKeyCert(ipfsHash);
            process.exit(0);
        }
        console.log(`Checking image: '${projectName}' on the ${networkName} blockchain...`);
        // On a registry with name owners the name's owner answers, whether or
        // not an image is certified under the name yet.
        const nameOwner = await imageRegistry.imageNameOwner(projectName);
        if (nameOwner !== null) {
            if (nameOwner === ethers.constants.AddressZero) {
                console.log(`Image: '${projectName}' is available on the ${networkName} blockchain.`);
                process.exit(0);
            }
            if (PRIVATE_KEY && isStringPrivateKey(PRIVATE_KEY) === "OK"
                && walletAddress(PRIVATE_KEY).toLowerCase() !== nameOwner.toLowerCase()) {
                console.log(`!!! Image: '${projectName}' is owned by '${nameOwner}'.\nYou are not the account holder of the image.\nPlease change the project name and try again.\n`);
                process.exit(1);
            }
            console.log(`Image: '${projectName}' is owned by '${nameOwner}'.\nIf you are not the account holder, you will not be able to publish your project with the current name. Please change the project name and try again.\n`);
            process.exit(0);
        }
        const imageHash = (await imageRegistry._getLatestImageVersionPublicKey(projectName, version))[0];
        console.log(`Image hash: ${imageHash}`);
        if (!imageHash) {
            console.log(`Image: '${projectName}' is available on the ${networkName} blockchain.`);
            process.exit(0);
        }
        const imageOwner = (await imageRegistry.getImageDetails(imageHash))[0];

        if (PRIVATE_KEY) {
            if (isStringPrivateKey(PRIVATE_KEY) === "OK") {
                if (imageOwner.toLowerCase() !== walletAddress(PRIVATE_KEY).toLowerCase()) {
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