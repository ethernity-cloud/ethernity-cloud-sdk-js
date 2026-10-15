// The publish's client of publickey.ethernity.cloud, the certificate
// extraction service: queues the image and polls for its certificate.
//
// An image registered on chain first (--chain-registered, the two-step
// registries) is queued by the service's registry watcher from the
// ImageRegistered event, with this publish's IPFS peer; the hash is posted to
// /api/addHash only when that row has not appeared within
// CHAIN_ROW_GRACE_SECONDS. Other images are posted at once.
const axios = require('axios');
const fs = require('fs');
const { Command } = require('commander');

const BASE_URL = "https://publickey.ethernity.cloud";
// The watcher polls the registries every 30 s.
const CHAIN_ROW_GRACE_SECONDS = 180;
const POLL_SECONDS = 10;

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
        return response.data;
    } catch (error) {
        console.error("Error:", error.response ? error.response.data : error.message);
        process.exit(1);
    }
}

// The service's answer for the hash, or null while the service does not
// know the hash yet (404).
async function checkIpfsHashStatus(hash) {
    const url = `${BASE_URL}/api/checkHash/${hash}`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 404) return null;
        console.error("Error:", error.response ? error.response.data : error.message);
        process.exit(1);
    }
}

// Queues the image as described above and returns the service's first
// answer for it. `submit`, `check`, `sleep` and `now` are the functions
// above and the clock, replaceable for tests.
async function queueImage({ hash, chainRegistered, submitArgs, submit = submitIpfsHash, check = checkIpfsHashStatus,
    sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000)), now = () => Date.now() / 1000,
    log = console.log, graceSeconds = CHAIN_ROW_GRACE_SECONDS, pollSeconds = POLL_SECONDS }) {
    if (chainRegistered) {
        const deadline = now() + graceSeconds;
        while (true) {
            const answer = await check(hash);
            if (answer !== null) return answer;
            if (now() >= deadline) {
                log(`The certificate service has not picked the registration up from the chain in ${graceSeconds} s; submitting the hash`);
                break;
            }
            log("Waiting for the certificate service to pick the registration up from the chain...");
            await sleep(pollSeconds);
        }
    }
    const submitResponse = await submit(hash, ...submitArgs);
    log("Submit IPFS Hash Response:", submitResponse);
    return null;
}

async function main() {
    const program = new Command();
    program
        .requiredOption('--enclave_name <enclaveName>', 'Enclave name')
        .requiredOption('--protocol_version <protocolVersion>', 'Protocol version')
        .requiredOption('--network <network>', 'Network')
        .requiredOption('--template_version <templateVersion>', 'Template version')
        .option('--chain-registered', 'the image is registered on chain; wait for the service to queue it from the event before posting the hash');
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

    let checkResponse = await queueImage({
        hash: hhash, chainRegistered: Boolean(options.chainRegistered),
        submitArgs: [enclaveName, protocolVersion, network, templateVersion, dockerComposerHash],
    });

    // The service answers publicKey 0 while the image is queued or running
    // (with status, percent and queuePosition), -1 when the extraction failed
    // (with reason) and the certificate when done.
    while (true) {
        if (checkResponse === null) {
            await new Promise(resolve => setTimeout(resolve, POLL_SECONDS * 1000));
            checkResponse = await checkIpfsHashStatus(hhash);
            continue;
        }
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

        await new Promise(resolve => setTimeout(resolve, POLL_SECONDS * 1000));
        checkResponse = await checkIpfsHashStatus(hhash);
    }
}

if (require.main === module) main();

module.exports = { queueImage, CHAIN_ROW_GRACE_SECONDS, POLL_SECONDS };
