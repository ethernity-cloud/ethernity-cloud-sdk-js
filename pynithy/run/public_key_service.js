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

    // The service answers publicKey 0 while the image is queued or running
    // (with status, percent and queuePosition), -1 when the extraction failed
    // (with reason) and the certificate when done.
    while (true) {
        const checkResponse = await checkIpfsHashStatus(hhash);
        if ("publicKey" in checkResponse) {
            if (checkResponse.publicKey === 0) {
                if (checkResponse.status === "running") {
                    console.log(`Public key extraction running, ${checkResponse.percent || 0}% done`);
                } else {
                    console.log(`Public key not available yet. Queue position: ${checkResponse.queuePosition ?? 'Unknown'}`);
                }
            } else if (checkResponse.publicKey === -1) {
                console.log(`Public key extraction failed: ${checkResponse.reason || "reason not reported by the service"}`);
                console.log("Fix the cause (keep the image pinned, build with the current SDK) and publish again: a new submission of the same hash runs the extraction again.");
                process.exit(1);
            } else {
                console.log("Public Key:", checkResponse.publicKey);
                // Save public key to file
                fs.writeFileSync('PUBLIC_KEY.txt', checkResponse.publicKey);
                break;
            }
        } else {
            console.log("Unexpected response:", checkResponse);
            process.exit(1);
        }

        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds before checking again
    }
})();