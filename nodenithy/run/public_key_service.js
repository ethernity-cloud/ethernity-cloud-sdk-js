const axios = require('axios');
const fs = require('fs');
const { Command } = require('commander');
const program = new Command();

const BASE_URL = "https://publickey.ethernity.cloud";

async function submitIpfsHash(hash, enclaveName, protocolVersion, network, templateVersion, dockerComposerHash) {
    const url = `${BASE_URL}/api/addHash`;
    const payload = {
        hash: hash,
        enclave_name: enclaveName,
        protocol_version: protocolVersion,
        network: network,
        template_version: templateVersion,
        docker_composer_hash: dockerComposerHash,
    };
    try {
        const response = await axios.post(url, payload);
        // console.log(`response: ${response}`);
        return response.data;
    } catch (error) {
        console.error("Error:", error.response ? error.response.data : error.message);
        process.exit(1);
    }
}

async function checkIpfsHashStatus(hash) {
    const url = `${BASE_URL}/api/checkHash/${hash}`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error("Error:", error.response ? error.response.data : error.message);
        process.exit(1);
    }
}

program
    .requiredOption('--enclave_name <enclaveName>', 'Enclave name')
    .requiredOption('--protocol_version <protocolVersion>', 'Protocol version')
    .requiredOption('--network <network>', 'Network')
    .requiredOption('--template_version <templateVersion>', 'Template version');

program.parse(process.argv);

const options = program.opts();
const enclaveName = options.enclave_name;
const protocolVersion = options.protocol_version;
const network = options.network.toLowerCase().split("_")[1];
const templateVersion = options.template_version;

const hhash = fs.readFileSync('IPFS_HASH.ipfs', 'utf8').trim();
const dockerComposerHash = fs.readFileSync('IPFS_DOCKER_COMPOSE_HASH.ipfs', 'utf8').trim();

console.log("IPFS Hash:", hhash);
console.log("Enclave Name:", enclaveName);
console.log("Protocol Version:", protocolVersion);
console.log("Network:", network);
console.log("Template Version:", templateVersion);
console.log("Docker Composer Hash:", dockerComposerHash);

(async () => {
    // Submit IPFS Hash
    const submitResponse = await submitIpfsHash(hhash, enclaveName, protocolVersion, network, templateVersion, dockerComposerHash);
    console.log("Submit IPFS Hash Response:", submitResponse);

    // Check IPFS Hash Status
    while (true) {
        const checkResponse = await checkIpfsHashStatus(hhash);
        if ("publicKey" in checkResponse) {
            if (checkResponse.publicKey === 0) {
                console.log(`Public key not available yet. Queue position: ${checkResponse.queuePosition || 'Unknown'}`);
            } else if (checkResponse.publicKey === -1) {
                console.log("Hash is not derived from Eternity Cloud SDK.");
                process.exit(1);
            } else {
                console.log("Public Key:", checkResponse.publicKey);
                // Save public key to file
                fs.writeFileSync('PUBLIC_KEY.txt', checkResponse.publicKey);
                // ESR (RFC §5.2): the enclave also prints ESR_WALLET_ADDRESS on the
                // cert channel. The service currently returns only "publicKey"; when
                // it starts relaying the enclave's output (or adds an
                // "esrWalletAddress" field) it is picked up here and written to a
                // sibling file the caller reads -- no other changes needed. Until
                // then, ESR projects extract locally on an SGX host once to learn
                // the address (publish then persists it).
                if (checkResponse.esrWalletAddress) {
                    console.log("ESR Wallet Address:", checkResponse.esrWalletAddress);
                    fs.writeFileSync('ESR_WALLET_ADDRESS.txt', checkResponse.esrWalletAddress);
                }
                break;
            }
        } else {
            console.log("Unexpected response:", checkResponse);
            process.exit(1);
        }

        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds before checking again
    }
})();