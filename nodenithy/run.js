const fs = require('fs');
const { execSync } = require('child_process');
require('dotenv').config();
const readline = require('readline');
const forge = require('node-forge');
const axios = require('axios');
const https = require('https');
const casConfig = require('../cas/config.js');
const casResolver = require('../cas/resolver.js');
const sessionRegistry = require('../cas/session_registry.js');
const { LocalKubo, ownEndpoint } = require('../localKubo.js');

if (!fs.existsSync('.env')) {
    console.error("Error: .env file not found");
    process.exit(1);
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const promptOptions = (message, options, defaultOption) => {
    return new Promise((resolve) => {
        const askOption = () => {
            rl.question(message, (answer) => {
                const reply = answer.trim().toLowerCase();
                if (reply === '') {
                    console.log(`No option selected. Defaulting to ${defaultOption}.`);
                    resolve(defaultOption);
                } else if (options.includes(reply)) {
                    resolve(reply);
                } else {
                    console.log(`Invalid option "${reply}". Please enter "yes" or "no".`);
                    askOption();
                }
            });
        };
        askOption();
    });
};

const writeEnv = (key, value) => {
    const envFile = `${currentDir}/.env`;
    let envContent = '';

    if (fs.existsSync(envFile)) {
        envContent = fs.readFileSync(envFile, 'utf8');
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
            envContent += `\n${key}=${value}`;
        }
    } else {
        envContent = `${key}=${value}`;
    }

    fs.writeFileSync(envFile, envContent);
};

let templateName = process.env.TRUSTED_ZONE_IMAGE || 'etny-nodenithy-testnet';

const isMainnet = casConfig.isMainnetNetwork(process.env.BLOCKCHAIN_NETWORK);
// Mainnet enclaves are provisioned by the Scontain CAS. A testnet template
// with a SessionRegistry is CAS-attested by the ethernity-cas validator set:
// the session is registered on-chain, the enclave is provisioned from a
// validator, and the certificate comes out of the CAS session. Every other
// testnet's enclaves self-sign from MR_ENCLAVE and register no session.
const cas = casConfig.casProvisioned(templateName, isMainnet);
const casTestnet = !isMainnet && cas;
const casChain = casConfig.CHAIN[templateName] || {};
// An -unsafe network is a self-signing testnet whose compose carries no LAS;
// its securelock is registered as <project>-unsafe.
const unsafe = casConfig.isUnsafeNetwork(process.env.BLOCKCHAIN_NETWORK);
const securelock = casConfig.nameOnNetwork(process.env.PROJECT_NAME, process.env.BLOCKCHAIN_NETWORK);

const currentDir = process.cwd();
console.log(`currentDir: ${currentDir}`);
const runDir = `${currentDir}/node_modules/@ethernity-cloud/sdk-js/nodenithy/run`;
process.chdir(runDir);
process.env.REGISTRY_PATH = `${currentDir}/registry`;
const registryPath = process.env.REGISTRY_PATH;

const runDockerCommand = (service) => {
    const command = `docker-compose run -e SCONE_LOG=INFO -e SCONE_HASH=1 ${service}`;
    const output = execSync(command).toString().trim();
    console.log(`Output of ${command}: ${output}`);
    return output.split('\n').filter(line => !/Creating|Pulling|latest|Digest/.test(line)).join('');
};

// Extract the runtime enclave measurement (SCONE_HASH) as a bare 64-hex string.
// Mirrors Python extract_scone_hash: the enclave prints its MRENCLAVE somewhere
// in the SCONE_HASH=1 output; pick the first 64-hex token.
const extractSconeHash = (service) => {
    const output = runDockerCommand(service);
    const m = output.match(/\b[a-fA-F0-9]{64}\b/);
    if (!m) throw new Error(`No SHA256 MRENCLAVE found in ${service} SCONE_HASH output.`);
    return m[0];
};

// Read the MRENCLAVE that was signed at build time (baked into the image as
// /signed_mrenclave.txt by the securelock Dockerfile on mainnet). Mirrors Python
// extract_signed_mrenclave. Returns '' if the file is absent (testnet builds).
const extractSignedMrenclave = (service) => {
    try {
        const command = `docker-compose -f docker-compose.yml run --no-deps --entrypoint cat ${service} /signed_mrenclave.txt`;
        const output = execSync(command, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
        const m = output.match(/\b[a-fA-F0-9]{64}\b/);
        return m ? m[0] : '';
    } catch (e) {
        return '';
    }
};

const main = async () => {
    process.env.NODE_NO_WARNINGS = 1
    // Every testnet trustedzone was measured and registered with a 1024M heap
    // (etny-nodenithy v3/run/docker-compose.yml). The mainnet session named
    // below comes from the features/v3 branches, which ran it with 256M.
    const trustedZoneHeap = isMainnet ? '256M' : '1024M';

    // Where the image goes. An IPFS API of the application's own
    // (IPFS_ENDPOINT, when it is not the public one) takes precedence.
    // Otherwise the publish runs its own Kubo: the public write API of
    // ipfs.ethernity.cloud is closing, and the image is held by this Kubo,
    // peered with the bootnode, until its certificate is on chain.
    let localKubo = null;
    let ipfsApi = process.env.IPFS_ENDPOINT || '';
    if (!ownEndpoint(ipfsApi)) {
        localKubo = new LocalKubo(process.env.PROJECT_NAME);
        try {
            await localKubo.start();
        } catch (e) {
            console.error(`Error: ${e.message}`);
            process.exit(1);
        }
        ipfsApi = localKubo.apiUrl;
        console.log(`\t✔  IPFS node for this publish: ${ipfsApi}`);
        process.on('exit', () => localKubo.stop());
    }

    // The CIDs uploadToIpfs gives, from the same add calls with only-hash: the
    // IPFS node stores and announces nothing. Set by hashForIpfs, after which
    // uploadToIpfs refuses an upload that gives other CIDs.
    let expectedCids = null;
    const hashForIpfs = () => {
        const hashOf = (target) => {
            try {
                const out = execSync(`node ../ipfs.mjs --host "${ipfsApi}" --action hash ${target}`, { stdio: ['ignore', 'pipe', 'inherit'] });
                return out.toString().trim().split('\n').pop().trim();
            } catch (e) {
                console.error(`Error: could not hash ${target} for IPFS: ${e.message}`);
                process.exit(1);
            }
        };
        process.env.IPFS_DOCKER_COMPOSE_HASH = hashOf('--filePath docker-compose-final.yml');
        process.env.IPFS_HASH = hashOf(`--folderPath ${registryPath}`);
        console.log("IPFS_DOCKER_COMPOSE_HASH (before upload): ", process.env.IPFS_DOCKER_COMPOSE_HASH);
        console.log("IPFS_HASH (before upload): ", process.env.IPFS_HASH);
        expectedCids = { image: process.env.IPFS_HASH, compose: process.env.IPFS_DOCKER_COMPOSE_HASH };
    };

    // The compose and the image tree, added through ipfsApi; their CIDs land
    // in IPFS_DOCKER_COMPOSE_HASH / IPFS_HASH (files and environment).
    const uploadToIpfs = () => {
        for (const file of ['IPFS_HASH.ipfs', 'IPFS_DOCKER_COMPOSE_HASH.ipfs']) {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        console.log('Upload docker-compose-final.yml to IPFS');
        execSync(`node ../ipfs.mjs --host "${ipfsApi}" --action upload --filePath docker-compose-final.yml`, { stdio: "inherit" });
        if (!fs.existsSync('IPFS_DOCKER_COMPOSE_HASH.ipfs')) {
            console.error("Error: Could not upload docker-compose-final.yml to IPFS, please try again!");
            process.exit(1);
        }
        process.env.IPFS_DOCKER_COMPOSE_HASH = fs.readFileSync('IPFS_DOCKER_COMPOSE_HASH.ipfs', 'utf8').trim();
        console.log("IPFS_DOCKER_COMPOSE_HASH: ", process.env.IPFS_DOCKER_COMPOSE_HASH);
        writeEnv('IPFS_DOCKER_COMPOSE_HASH', process.env.IPFS_DOCKER_COMPOSE_HASH);
        console.log('Upload docker registry to IPFS');
        execSync(`node ../ipfs.mjs --host "${ipfsApi}" --action upload --folderPath ${registryPath}`, { stdio: "inherit" });
        if (!fs.existsSync('IPFS_HASH.ipfs')) {
            console.error("Error: Could not upload registry to IPFS, please try again!");
            process.exit(1);
        }
        process.env.IPFS_HASH = fs.readFileSync('IPFS_HASH.ipfs', 'utf8').trim();
        console.log("IPFS_HASH: ", process.env.IPFS_HASH);
        writeEnv('IPFS_HASH', process.env.IPFS_HASH);
        if (expectedCids && (process.env.IPFS_HASH !== expectedCids.image
            || process.env.IPFS_DOCKER_COMPOSE_HASH !== expectedCids.compose)) {
            console.error(`Error: the upload gave ${process.env.IPFS_HASH} (compose ${process.env.IPFS_DOCKER_COMPOSE_HASH}), not the registered ${expectedCids.image} (compose ${expectedCids.compose}).`);
            process.exit(1);
        }
    };

    ['docker-compose.yml', 'docker-compose-final.yml'].forEach(file => {
        const template = `${file}.tmpl`;
        if (!fs.existsSync(template)) {
            console.error(`Error: ${template} not found!`);
            return;
        }
        const content = casConfig.renderCompose(fs.readFileSync(template, 'utf8'), cas, unsafe)
            .replace(/__TRUSTEDZONE_HEAP__/g, trustedZoneHeap);
        fs.writeFileSync(file, content, 'utf8');
    });


    process.env.MRENCLAVE_SECURELOCK = extractSconeHash('etny-securelock');
    console.log(`MRENCLAVE_SECURELOCK: ${process.env.MRENCLAVE_SECURELOCK}`);
    // process.env.MRENCLAVE_TRUSTEDZONE = runDockerCommand('etny-trustedzone');
    // console.log(`MRENCLAVE_TRUSTEDZONE: ${process.env.MRENCLAVE_TRUSTEDZONE}`);
    // process.env.MRENCLAVE_VALIDATOR = runDockerCommand('etny-validator');
    // console.log(`MRENCLAVE_VALIDATOR: ${process.env.MRENCLAVE_VALIDATOR}`);

    // ----- MRENCLAVE match-gate (mainnet) -----
    // The runtime enclave measured just above (SCONE_HASH, with the same env the
    // harvest uses) MUST match the MRENCLAVE that was signed --production at build
    // time (baked into /signed_mrenclave.txt). A mismatch means SCONE recomputed
    // the measurement at load because the runtime enclave-creation params drifted
    // from the signed binary -- and a runtime recompute yields a DEBUG enclave
    // that CAS rejects ("Debug mode is enabled"). Refuse to publish rather than
    // register an untrusted identity on-chain or fail opaquely later.
    if (cas) {
        const signedMrenclave = extractSignedMrenclave('etny-securelock');
        if (!signedMrenclave || signedMrenclave !== process.env.MRENCLAVE_SECURELOCK) {
            console.error(`Error: securelock runtime MRENCLAVE (${process.env.MRENCLAVE_SECURELOCK}) != signed MRENCLAVE (${signedMrenclave}).`);
            console.error('       The runtime enclave differs from the --production-signed binary (SCONE recomputed -> debug).');
            console.error('       Refusing to publish. Rebuild with the current SDK (ecld-build) and retry.');
            process.exit(1);
        }
        console.log('\t✔  MRENCLAVE match-gate passed: runtime enclave matches the --production-signed MRENCLAVE');
    }

    writeEnv('MRENCLAVE_SECURELOCK', process.env.MRENCLAVE_SECURELOCK);
    // writeEnv('MRENCLAVE_TRUSTEDZONE', process.env.MRENCLAVE_TRUSTEDZONE);
    // writeEnv('MRENCLAVE_VALIDATOR', process.env.MRENCLAVE_VALIDATOR);

    const generateEnclaveName = (name) => {
        return name.toUpperCase().replace(/\//g, '_').replace(/-/g, '_');
    };

    const processYamlTemplate = (templateFile, outputFile, replacements) => {
        if (!fs.existsSync(templateFile)) {
            console.error(`Error: Template file ${templateFile} not found!`);
            process.exit(1);
        }

        let content = fs.readFileSync(templateFile, 'utf8');
        for (const [key, value] of Object.entries(replacements)) {
            const regex = new RegExp(`__${key}__`, 'g');
            content = content.replace(regex, value);
        }
        // Mainnet attests production enclaves only; a testnet tolerates a
        // debug-signed one. Both lines were edited by text replacement, which
        // had to repeat the advisory list verbatim to delete it and broke the
        // moment either string moved. Written out per network instead.
        content = content
            .replace(/__TOLERATE__/g, isMainnet
                ? '[hyperthreading, outdated-tcb, software-hardening-needed]'
                : '[hyperthreading, outdated-tcb, software-hardening-needed, debug-mode]')
            .replace(/__IGNORE_ADVISORIES__/g, isMainnet ? '["INTEL-SA-00615"]' : '["*"]');

        fs.writeFileSync(outputFile, content);
        // console.log(`Contents of ${outputFile}:`);
        // console.log(content);

        console.log("Checking for remaining placeholders:");
        const remainingPlaceholders = content.match(/__.*__/g);
        if (remainingPlaceholders) {
            console.log(remainingPlaceholders.join('\n'));
        } else {
            console.log("No placeholders found.");
        }
    };

    // const ENCLAVE_NAME_SECURELOCK = generateEnclaveName(process.env.ENCLAVE_NAME_SECURELOCK);
    const ENCLAVE_NAME_SECURELOCK = process.env.ENCLAVE_NAME_SECURELOCK;
    // const PREDECESSOR_NAME_SECURELOCK = generateEnclaveName(`PREDECESSOR_SECURELOCK_${process.env.VERSION}_${process.env.PROJECT_NAME}`);

    console.log(`\nENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);
    // console.log(`PREDECESSOR_NAME_SECURELOCK: ${PREDECESSOR_NAME_SECURELOCK}`);
    // writeEnv('PREDECESSOR_NAME_SECURELOCK', PREDECESSOR_NAME_SECURELOCK);

    process.env.ENCLAVE_NAME_SECURELOCK = ENCLAVE_NAME_SECURELOCK;
    const envPredecessor = process.env.PREDECESSOR_HASH_SECURELOCK || 'EMPTY';
    let PREDECESSOR_HASH_SECURELOCK = 'EMPTY';
    let PREDECESSOR_PROJECT_NAME = 'EMPTY';
    let PREDECESSOR_VERSION = 'EMPTY';
    if (envPredecessor !== 'EMPTY') {
        PREDECESSOR_HASH_SECURELOCK = envPredecessor.split("$$$%$")[0];
        PREDECESSOR_PROJECT_NAME = process.env.PREDECESSOR_HASH_SECURELOCK.split("$$$%$")[1];
        PREDECESSOR_VERSION = process.env.PREDECESSOR_HASH_SECURELOCK.split("$$$%$")[2];
    }

    console.log(`PREDECESSOR_HASH_SECURELOCK: ${PREDECESSOR_HASH_SECURELOCK}`);
    console.log(`PREDECESSOR_PROJECT_NAME: ${PREDECESSOR_PROJECT_NAME}`);
    console.log(`PREDECESSOR_VERSION: ${PREDECESSOR_VERSION}`);
    console.log(`MRENCLAVE_SECURELOCK: ${process.env.MRENCLAVE_SECURELOCK}`);
    console.log(`ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);

    if (PREDECESSOR_HASH_SECURELOCK !== 'EMPTY' && PREDECESSOR_PROJECT_NAME !== process.env.PROJECT_NAME && PREDECESSOR_VERSION !== process.env.VERSION) {
        PREDECESSOR_HASH_SECURELOCK = 'EMPTY';
    }

    const replacementsSecurelock = {
        PREDECESSOR: PREDECESSOR_HASH_SECURELOCK === 'EMPTY' ? `# predecessor: ${PREDECESSOR_HASH_SECURELOCK}` : `predecessor: ${PREDECESSOR_HASH_SECURELOCK}`,
        MRENCLAVE: process.env.MRENCLAVE_SECURELOCK,
        ENCLAVE_NAME: ENCLAVE_NAME_SECURELOCK
    };
    if (cas) {
        processYamlTemplate('etny-securelock-test.yaml.tpl', 'etny-securelock-test.yaml', replacementsSecurelock);
    }

    // Where the session goes depends on who provisions the securelock. On a
    // CAS-attested testnet it is registered ON-CHAIN in the ethernity-cas
    // SessionRegistry, which the validator set reads and which accepts no
    // POST. That happens once the image is registered, below: the
    // SessionRegistry takes a securelock session only from the wallet that
    // owns the image name. The publish then waits until the validators serve
    // it, because the public-key harvest provisions the enclave from them. On
    // mainnet it is registered with the Scontain CAS. A self-signing testnet
    // has none: a CAS-issued certificate would not match the key the enclave
    // derives.
    const registerSessionOnChain = async () => {
        const registered = await sessionRegistry.register(
            casChain.rpcUrl, casChain.chainId, casConfig.SESSION_REGISTRY[templateName],
            process.env.PRIVATE_KEY, fs.readFileSync('etny-securelock-test.yaml'),
            ipfsApi, '');
        if (localKubo) await localKubo.provide(registered.cid);
        if (registered.registered) {
            console.log(`\t✔  Session ${registered.name} registered on-chain (body ${registered.cid})`);
            await sessionRegistry.waitVisible(
                casChain.rpcUrl, casConfig.SESSION_REGISTRY[templateName], registered.name, registered.hash);
        } else {
            console.log(`\t✔  Session ${registered.name} already registered on-chain with this body (${registered.hash})`);
        }
    };
    if (!cas) {
        console.log(`\t✔  ${process.env.BLOCKCHAIN_NETWORK}: no CAS session; the securelock self-signs from MR_ENCLAVE`);
    } else if (!casTestnet) {
    // don't generate new keys if PREDECESSOR_HASH_SECURELOCK is not empty and the key.pem and cert.pem files exist
    if (PREDECESSOR_HASH_SECURELOCK !== 'EMPTY' && fs.existsSync('key.pem') && fs.existsSync('cert.pem')) {
        console.log("Skipping keypair generation and certificate creation.");
        console.log("Using existing key.pem and cert.pem files.");
    } else {
        // Generate a keypair and create an X.509v3 certificate
        const pki = forge.pki;
        const keys = pki.rsa.generateKeyPair(4096);
        const cert = pki.createCertificate();

        cert.publicKey = keys.publicKey;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notBefore.setFullYear(cert.validity.notBefore.getFullYear() - 1);
        cert.validity.notAfter = new Date();
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

        const attrs = [
            {
                name: 'countryName',
                value: 'AU'
            },
            {
                shortName: 'ST',
                value: 'Some-State'
            },
            {
                name: 'organizationName',
                value: process.env.ENCLAVE_NAME_SECURELOCK || 'Internet Widgits Pty Ltd'
            }
        ];
        cert.setSubject(attrs);
        cert.setIssuer(attrs);

        cert.setExtensions([
            {
                name: 'subjectKeyIdentifier'
            },
            {
                name: 'authorityKeyIdentifier',
                keyIdentifier: true
            },
            {
                name: 'basicConstraints',
                cA: true,
                critical: true
            }
        ]);


        // TOdo: use same certificate for future entryes
        // Self-sign certificate
        cert.sign(keys.privateKey, forge.md.sha256.create());

        // PEM-format keys and cert
        const privateKeyPem = pki.privateKeyToPem(keys.privateKey, 72, { type: 'pkcs8' });
        const certPem = pki.certificateToPem(cert);

        // Write to files
        fs.writeFileSync('key.pem', privateKeyPem);
        fs.writeFileSync('cert.pem', certPem);

        console.log("# Generated cert.pem and key.pem files");


    }
    // Read the certificate and key files
    const certFile = fs.readFileSync('cert.pem');
    const keyFile = fs.readFileSync('key.pem');
    const data = fs.readFileSync('etny-securelock-test.yaml');

    // Create an HTTPS agent with the certificate and key
    const agent = new https.Agent({
        cert: certFile,
        key: keyFile,
        rejectUnauthorized: false, // This is equivalent to the `-k` option in curl
        secureProtocol: 'TLSv1_2_method' // Ensure using TLSv1.2
    });
    // Perform the POST request
    await axios.post('https://scone-cas.cf:8081/session', data, {
        httpsAgent: agent,
        headers: {
            'Content-Type': 'application/octet-stream'
        }
    })
        .then(response => {
            fs.writeFileSync('predecessor.json', JSON.stringify(response.data, null, 2));
            console.log("# Updated session file for securelock and saved to predecessor.json");
            // console.log("predecessor.json:"+JSON.stringify(response.data, null, 2));
            const pred = response.data.hash || 'EMPTY';
            if (pred !== 'EMPTY') {
                process.env.PREDECESSOR_HASH_SECURELOCK = `${pred}$$$%$${process.env.PROJECT_NAME}$$$%$${process.env.VERSION}` || 'EMPTY';
                writeEnv('PREDECESSOR_HASH_SECURELOCK', process.env.PREDECESSOR_HASH_SECURELOCK);
            } else {
                process.env.PREDECESSOR_HASH_SECURELOCK = 'EMPTY';
                writeEnv('PREDECESSOR_HASH_SECURELOCK', process.env.PREDECESSOR_HASH_SECURELOCK);
            }

            if (process.env.PREDECESSOR_HASH_SECURELOCK === 'EMPTY') {
                console.log("Error: Could not update session file for securelock");
                console.log("Please change the name/version of your project (using ecld-init or by editing .env file) and run the scripts again. Exiting.");
                process.exit(1);
            }
            console.log()
            console.log("Scone CAS registration successful.");
            console.log()
        })
        .catch(error => {
            console.log("Scone CAS error: ", error);
            console.log("Error: Could not update session file for securelock");
            console.log("Please change the name/version of your project (using ecld-init or by editing .env file) and run the scripts again. Exiting.");
            process.exit(1);
        });
    }


    // const ENCLAVE_NAME_TRUSTEDZONE = generateEnclaveName(process.env.ENCLAVE_NAME_TRUSTEDZONE);
    // const PREDECESSOR_NAME_TRUSTEDZONE = generateEnclaveName(`PREDECESSOR_TRUSTEDZONE_${process.env.VERSION}_${process.env.PROJECT_NAME}`);



    // console.log(`\ENCLAVE_NAME_TRUSTEDZONE: ${ENCLAVE_NAME_TRUSTEDZONE}`);
    // console.log(`PREDECESSOR_NAME_TRUSTEDZONE: ${PREDECESSOR_NAME_TRUSTEDZONE}`);
    // writeEnv('PREDECESSOR_NAME_TRUSTEDZONE', PREDECESSOR_NAME_TRUSTEDZONE);

    // process.env.ENCLAVE_NAME_TRUSTEDZONE = ENCLAVE_NAME_TRUSTEDZONE;

    // const PREDECESSOR_HASH_TRUSTEDZONE = process.env[PREDECESSOR_NAME_TRUSTEDZONE] || 'EMPTY';

    // console.log(`PREDECESSOR_HASH_TRUSTEDZONE: ${PREDECESSOR_HASH_TRUSTEDZONE}`);
    // console.log(`MRENCLAVE_TRUSTEDZONE: ${process.env.MRENCLAVE_TRUSTEDZONE}`);
    // console.log(`ENCLAVE_NAME_TRUSTEDZONE: ${ENCLAVE_NAME_TRUSTEDZONE}`);

    // const replacementsTrustedzone = {
    //     PREDECESSOR: PREDECESSOR_HASH_TRUSTEDZONE === 'EMPTY' ? `# predecessor: ${PREDECESSOR_HASH_TRUSTEDZONE}` : `predecessor: ${PREDECESSOR_HASH_TRUSTEDZONE}`,
    //     MRENCLAVE: process.env.MRENCLAVE_TRUSTEDZONE,
    //     ENCLAVE_NAME: ENCLAVE_NAME_TRUSTEDZONE,
    //     MRENCLAVE_VALIDATOR: process.env.MRENCLAVE_VALIDATOR
    // };

    // processYamlTemplate('etny-trustedzone-test.yaml.tpl', 'etny-trustedzone-test.yaml', replacementsTrustedzone);

    // revert 'docker-compose.yml', 'docker-compose-final.yml' to the backed up ones from 'docker-compose.yml.tmpl', 'docker-compose-final.yml.tmpl'



    console.log("# Update docker-compose files");

    // On a CAS-attested testnet the compose names the CAS both enclaves are
    // provisioned from and the trustedzone session the ImageRegistry records
    // for this template. docker-compose.yml, which harvests the certificate
    // here, names a validator that answered (or ECLD_CAS_ADDR); the published
    // docker-compose-final.yml names the first validator in registry order,
    // so that a rerun of this publish renders the same compose. The node and
    // the extraction service resolve a CAS again before they run it.
    let casAddr = null;
    let publishedCasAddr = null;
    let trustedZoneSession = null;
    if (casTestnet) {
        casAddr = await casResolver.casAddressFor(casChain.rpcUrl, casConfig.VALIDATOR_REGISTRY[templateName]);
        publishedCasAddr = await casResolver.publishedCasAddress(casChain.rpcUrl, casConfig.VALIDATOR_REGISTRY[templateName]);
        console.log(`\t✔  CAS for this network: ${casAddr} (the published compose names ${publishedCasAddr})`);
        trustedZoneSession = execSync(`node ./image_registry.js "${process.env.BLOCKCHAIN_NETWORK}" ${templateName} "v3" "getTrustedZoneSession"`).toString().trim();
        if (!trustedZoneSession) {
            console.error(`ERROR! The ImageRegistry records no trustedzone session for ${templateName}.`);
            process.exit(1);
        }
        console.log(`\t✔  Trustedzone session: ${trustedZoneSession}`);
    }

    const files = ['docker-compose.yml', 'docker-compose-final.yml'];

    files.forEach(file => {
        if (!fs.existsSync(file)) {
            console.error(`Error: ${file} not found!`);
            return;
        }

        console.log(`Processing ${file}`);
        console.log(`ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);
        // console.log(`ENCLAVE_NAME_TRUSTEDZONE: ${ENCLAVE_NAME_TRUSTEDZONE}`);

        console.log("Checking for placeholders before replacement:");
        const fileContentBefore = fs.readFileSync(file, 'utf8');
        if (fileContentBefore.includes('__ENCLAVE_NAME_SECURELOCK__')) {
            console.log(`__ENCLAVE_NAME_SECURELOCK__ found in ${file}`);
        } else {
            console.log(`Ok, No __ENCLAVE_NAME_SECURELOCK__ found in ${file}`);
        }
        if (fileContentBefore.includes('__ENCLAVE_NAME_TRUSTEDZONE__')) {
            console.log(`__ENCLAVE_NAME_TRUSTEDZONE__ found in ${file}`);
        } else {
            console.log(`No __ENCLAVE_NAME_TRUSTEDZONE__ found in ${file}`);
        }

        // Named only in a CAS-provisioned compose; a self-signing one has no
        // __CAS_ONLY__ lines left.
        const ENCLAVE_NAME_TRUSTEDZONE = casTestnet ? trustedZoneSession : 'ecld-nodenithy-trustedzone-v3-3.0.0';
        let updatedContent = fileContentBefore
            .replace(/__ENCLAVE_NAME_SECURELOCK__/g, ENCLAVE_NAME_SECURELOCK)
            .replace(/__ENCLAVE_NAME_TRUSTEDZONE__/g, ENCLAVE_NAME_TRUSTEDZONE);
        if (casTestnet) {
            const fileCasAddr = file === 'docker-compose-final.yml' ? publishedCasAddr : casAddr;
            updatedContent = updatedContent.replace(/SCONE_CAS_ADDR=scone-cas\.cf/g, `SCONE_CAS_ADDR=${fileCasAddr}`);
        }

        fs.writeFileSync(file, updatedContent, 'utf8');

        console.log("Checking for placeholders after replacement:");
        const fileContentAfter = fs.readFileSync(file, 'utf8');
        if (fileContentAfter.includes('__ENCLAVE_NAME_SECURELOCK__')) {
            console.log(`__ENCLAVE_NAME_SECURELOCK__ still found in ${file}`);
        } else {
            console.log(`Ok, No __ENCLAVE_NAME_SECURELOCK__ found in ${file}`);
        }
        if (fileContentAfter.includes('__ENCLAVE_NAME_TRUSTEDZONE__')) {
            console.log(`__ENCLAVE_NAME_TRUSTEDZONE__ still found in ${file}`);
        } else {
            console.log(`No __ENCLAVE_NAME_TRUSTEDZONE__ found in ${file}`);
        }

        console.log();
    });

    // let PUBLIC_KEY_SECURELOCK_RES = execSync(`docker-compose run etny-securelock 2>/dev/null | grep -v Creating | grep -v Pulling | grep -v latest | grep -v Digest | sed 's/.*PUBLIC_KEY:\\s*//' | tr -d '\\r'`).toString().trim();


    // The image and its compose go out before the certificate is extracted,
    // whichever way it is: the extraction service fetches them by these CIDs.
    // On a two-step registry (ECImageRegistryV2 and later) the wallet records
    // the image first (registerImage, with the publish's node), under the
    // CIDs the upload gives, hashed before anything is stored. On
    // ECImageRegistryV3 that binds the image name to this wallet before the
    // upload, the session registration or anything else discloses it. The
    // bootnode's mirror then pins the image and the extraction service queues
    // it from the chain; the certificate is written below by the same wallet
    // (setImageCert). A V1 registry takes both in one addImage call.
    const registryV2 = execSync(`node ${runDir}/image_registry.js "${process.env.BLOCKCHAIN_NETWORK}" "${securelock}" "v3" "isV2"`, { env: { ...process.env, PROJECT_NAME: securelock } }).toString().trim() === 'true';
    let ipfsPeer = '';
    if (registryV2) {
        hashForIpfs();
        if (localKubo) ipfsPeer = await localKubo.peerMultiaddr();
        execSync(`node ${runDir}/image_registry.js "${process.env.BLOCKCHAIN_NETWORK}" "${securelock}" "v3" "registerImage"`, { stdio: "inherit", env: { ...process.env, PROJECT_NAME: securelock, IPFS_PEER: ipfsPeer } });
    }
    uploadToIpfs();
    const registryEnv = { ...process.env, PROJECT_NAME: securelock, IPFS_PEER: ipfsPeer };
    if (registryV2 && localKubo) {
        await localKubo.provide(process.env.IPFS_HASH);
        await localKubo.provide(process.env.IPFS_DOCKER_COMPOSE_HASH);
    }
    if (casTestnet) await registerSessionOnChain();

    if (fs.existsSync('certificate.securelock.crt')) {
        // delete it
        fs.unlinkSync('certificate.securelock.crt');
    }

    let PUBLIC_KEY_SECURELOCK_RES = '';
    try {
        const output = execSync(`docker-compose run etny-securelock`, { cwd: runDir }).toString();
        console.log("Output of docker-compose run etny-securelock:");
        // Extract the WHOLE multi-line PEM certificate block from the enclave
        // output. A previous version grabbed only the single line containing
        // "PUBLIC_KEY:" -- but the certificate is multi-line, so that captured just
        // the "-----BEGIN CERTIFICATE-----" line (or a fragment), and any log noise
        // interleaved with it (e.g. an IPFS "Saving file(s) to Qm..." line) could be
        // stored as the key. Match the full BEGIN..END block instead, tolerating a
        // "PUBLIC_KEY:"/"PUBLIC_CERT:" marker prefix on the BEGIN line.
        const certMatch = output.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
        PUBLIC_KEY_SECURELOCK_RES = certMatch ? certMatch[0].trim() : '';
    } catch (error) {
        console.log("Error: Could not fetch PUBLIC_KEY_SECURELOCK" + error);
        // console.error("Error: Could not fetch PUBLIC_KEY_SECURELOCK");
        PUBLIC_KEY_SECURELOCK_RES = '';
        console.log("");
    }
    console.log(`PUBLIC_KEY_SECURELOCK_RES: ${PUBLIC_KEY_SECURELOCK_RES}`);

    // v3:QmPwv3JfYdfkBMDJK8mTFMMdQgrbSCgqRbPQi5qfRUqKgy:etny-nodenithy-testnet:QmNk58xU3f74NFcGmEpUz6KM8eMKiySdwyXgb33QwCaxCc:QmPFVaY5M2esayqCkLEFC5ivF2GWxRp8BZXTFjasPP5cVH:bad1ba9aae6bc1ad314435d5a4843abe1449f261feaf32ccaaac7aad68c95702

    if (!PUBLIC_KEY_SECURELOCK_RES) {
        console.log("\n\nIt seems that your machine is not SGX compatible.\n");
        console.log("");

        const opt = ["yes", "no"];
        const choice = await promptOptions("Do you want to continue by generating the necessary certificates using the Ethernity Cloud public certificate extraction services? (yes/no) (default: no): ", opt, "no");

        if (choice.toLowerCase() !== 'yes') {
            console.log("Exiting.");
            process.exit(0);
        } else {
            console.log("\nGenerating certificates using the Ethernity Cloud signing service...\n");
            console.log(`ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);
            execSync(`node ./public_key_service.js --enclave_name "${securelock}" --protocol_version "v3" --network "${process.env.BLOCKCHAIN_NETWORK}" --template_version "${process.env.VERSION}"`, { stdio: 'inherit' });
            PUBLIC_KEY_SECURELOCK_RES = fs.readFileSync('PUBLIC_KEY.txt', 'utf8').trim();
            console.log(`PUBLIC_KEY_SECURELOCK_RES: ${PUBLIC_KEY_SECURELOCK_RES}`);
            if (!PUBLIC_KEY_SECURELOCK_RES || PUBLIC_KEY_SECURELOCK_RES === '-1') {
                console.error("Error: Could not fetch PUBLIC_KEY_SECURELOCK");
                process.exit(1);
            }
            // ESR (RFC §5.2): if the extraction relayed the enclave's ESR wallet
            // address (public_key_service writes ESR_WALLET_ADDRESS.txt when the
            // service provides it), persist it to .env so a dApp can read/fund the
            // enclave wallet. Absent file => not an ESR project, or the (mainnet)
            // address must be learned from a local SGX extraction — either way,
            // silently skip. Parity with the Python SDK's esr.wallet_address.
            try {
                if (fs.existsSync('ESR_WALLET_ADDRESS.txt')) {
                    const esrAddr = fs.readFileSync('ESR_WALLET_ADDRESS.txt', 'utf8').trim();
                    if (/^0x[0-9a-fA-F]{40}$/.test(esrAddr)) {
                        writeEnv('ESR_WALLET_ADDRESS', esrAddr);
                        console.log(`ESR_WALLET_ADDRESS: ${esrAddr}`);
                        // Manual funding by the data owner is the default path;
                        // publishing never transfers value on its own. Say so, or
                        // the first task needing gas fails with no clue why.
                        console.log('   This wallet starts EMPTY. Fund it from your own wallet with');
                        console.log('   whatever your payload needs; publishing never transfers value.');
                    }
                }
            } catch (e) {
                console.warn(`Could not persist ESR_WALLET_ADDRESS: ${e && e.message ? e.message : e}`);
            }
        };
    }

    // Validate we actually have a certificate before registering it on-chain.
    // (Guard the match so a missing/garbage value fails loudly instead of throwing
    // "Cannot read properties of null".) On-chain registrations are effectively
    // permanent per version, so refuse to register anything that isn't a PEM cert.
    const certContentMatch = PUBLIC_KEY_SECURELOCK_RES.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
    const CERTIFICATE_CONTENT_SECURELOCK = certContentMatch ? certContentMatch[1].trim() : '';
    if (!CERTIFICATE_CONTENT_SECURELOCK) {
        console.error("ERROR! PUBLIC_KEY_SECURELOCK not a valid certificate; refusing to register.");
        console.error(`  got: ${JSON.stringify((PUBLIC_KEY_SECURELOCK_RES || '').slice(0, 120))}`);
        process.exit(1);
    } else {
        console.log("FOUND PUBLIC_KEY_SECURELOCK");
    }
    fs.writeFileSync('certificate.securelock.crt', PUBLIC_KEY_SECURELOCK_RES);
    console.log("Listing certificate PUBLIC_KEY_SECURELOCK:");
    console.log(fs.readFileSync('certificate.securelock.crt', 'utf8'));

    if (fs.existsSync('certificate.trustedzone.crt')) {
        // delete it
        fs.unlinkSync('certificate.trustedzone.crt');
    }

    // const scriptPath = path.resolve(__dirname, '/image_registry.js');
    const trustedZoneCert = execSync(`node ./image_registry.js "${process.env.BLOCKCHAIN_NETWORK}" ${templateName} "v3" "getTrustedZoneCert"`).toString().trim();

    console.log("trustedZoneCert: ", trustedZoneCert);


    const tzMatch = trustedZoneCert.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
    if (!tzMatch) {
        console.error("ERROR! Could not read a valid trustedzone certificate from the image registry.");
        console.error(`  got: ${JSON.stringify((trustedZoneCert || '').slice(0, 120))}`);
        process.exit(1);
    }
    const CERTIFICATE_CONTENT_TRUSTEDZONE = tzMatch[1].trim();
    const PUBLIC_KEY_TRUSTEDZONE = `-----BEGIN CERTIFICATE-----\n${CERTIFICATE_CONTENT_TRUSTEDZONE}\n-----END CERTIFICATE-----`;
    fs.writeFileSync('certificate.trustedzone.crt', PUBLIC_KEY_TRUSTEDZONE);
    console.log("Listing certificate PUBLIC_KEY_TRUSTEDZONE:");
    console.log(fs.readFileSync('certificate.trustedzone.crt', 'utf8'));

    // image_registry.js reads the securelock certificate from registry/.
    fs.copyFileSync('certificate.securelock.crt', `${registryPath}/certificate.securelock.crt`);
    fs.copyFileSync('certificate.trustedzone.crt', `${registryPath}/certificate.trustedzone.crt`);

    if (registryV2) {
        // The registered hash is the tree uploaded before the extraction.
        process.chdir(currentDir);
        console.log(`Registering the certificate of SECURELOCK ${securelock} in the IMAGE REGISTRY smart contract...`);
        execSync(`node ${runDir}/image_registry.js "${process.env.BLOCKCHAIN_NETWORK}" "${securelock}" "v3" "setImageCert"`, { stdio: "inherit", env: registryEnv });
    } else {
        // A V1 registry gets the tree that carries the certificate files,
        // uploaded again, with the certificate, in one addImage call.
        if (fs.existsSync('IPFS_HASH.ipfs')) {
            fs.unlinkSync('IPFS_HASH.ipfs');
        }
        console.log('Upload docker registry to IPFS');
        execSync(`node ../ipfs.mjs --host "${ipfsApi}" --action upload --folderPath ${registryPath}`, { stdio: "inherit" });
        if (!fs.existsSync(`./IPFS_HASH.ipfs`)) {
            console.error("Error: Could not upload registry to IPFS, please try again!");
            process.exit(1);
        }
        process.env.IPFS_HASH = fs.readFileSync(`./IPFS_HASH.ipfs`, 'utf8').trim();
        console.log("IPFS_HASH: ", process.env.IPFS_HASH);
        writeEnv('IPFS_HASH', process.env.IPFS_HASH);
        if (localKubo) await localKubo.provide(process.env.IPFS_HASH);
        process.chdir(currentDir);
        console.log(`Adding certificates for SECURELOCK ${securelock} into IMAGE REGISTRY smart contract...`);
        // image_registry.js registers the image under PROJECT_NAME and prints
        // why when it cannot.
        registryEnv.IPFS_HASH = process.env.IPFS_HASH;
        try {
            execSync(`node ${runDir}/image_registry.js "${process.env.BLOCKCHAIN_NETWORK}" "${securelock}" "${process.env.VERSION}" "registerSecureLockImage"`, { stdio: "inherit", env: registryEnv });
        } catch (error) {
            console.error("Error: Could not add the certificates of the SECURELOCK to the IMAGE REGISTRY smart contract");
            process.exit(1);
        }
    }
    // The on-chain session points at the image it admits, so a validator can
    // pin the image beside the body it serves.
    if (casTestnet) {
        await sessionRegistry.linkImage(
            casChain.rpcUrl, casChain.chainId, casConfig.SESSION_REGISTRY[templateName],
            process.env.PRIVATE_KEY, ENCLAVE_NAME_SECURELOCK, process.env.IPFS_HASH);
        console.log(`\t✔  Session ${ENCLAVE_NAME_SECURELOCK} linked to image ${process.env.IPFS_HASH}`);
    }
    console.log("Script completed successfully. You can start testing the application now. (eg. npm run start)");
    process.exit(0);
};

main();