const fs = require('fs');
const { execSync } = require('child_process');
require('dotenv').config();
const readline = require('readline');
const forge = require('node-forge');
const axios = require('axios');
const https = require('https');

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
const currentDir = process.cwd();
console.log(`currentDir: ${currentDir}`);
const runDir = `${currentDir}/node_modules/ethernity-cloud-sdk-js/pynithy/run`;
process.chdir(runDir);
process.env.REGISTRY_PATH = `${currentDir}/registry`;
const registryPath = process.env.REGISTRY_PATH;

const runDockerCommand = (service) => {
    const command = `docker-compose run -e SCONE_LOG=INFO -e SCONE_HASH=1 ${service}`;
    const output = execSync(command).toString().trim();
    console.log(`Output of ${command}: ${output}`);
    return output.split('\n').filter(line => !/Creating|Pulling|latest|Digest/.test(line)).join('');
};

const main = async () => {
    process.env.NODE_NO_WARNINGS = 1
    const backupFiles = ['docker-compose.yml.tmpl', 'docker-compose-final.yml.tmpl'];
    backupFiles.forEach(file => {
        if (!fs.existsSync(file)) {
            console.error(`Error: ${file} not found!`);
            return;
        }
        const backupContent = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file.replace('.tmpl', ''), backupContent, 'utf8');
    });


    process.env.MRENCLAVE_SECURELOCK = runDockerCommand('etny-securelock');
    console.log(`MRENCLAVE_SECURELOCK: ${process.env.MRENCLAVE_SECURELOCK}`);
    process.env.MRENCLAVE_VALIDATOR = runDockerCommand('etny-validator');
    console.log(`MRENCLAVE_VALIDATOR: ${process.env.MRENCLAVE_VALIDATOR}`);

    writeEnv('MRENCLAVE_SECURELOCK', process.env.MRENCLAVE_SECURELOCK);
    writeEnv('MRENCLAVE_VALIDATOR', process.env.MRENCLAVE_VALIDATOR);

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

        fs.writeFileSync(outputFile, content);

        console.log("Checking for remaining placeholders:");
        const remainingPlaceholders = content.match(/__.*__/g);
        if (remainingPlaceholders) {
            console.log(remainingPlaceholders.join('\n'));
        } else {
            console.log("No placeholders found.");
        }
    };

    const ENCLAVE_NAME_SECURELOCK = process.env.ENCLAVE_NAME_SECURELOCK;

    console.log(`\nENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);

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
    processYamlTemplate('etny-securelock-test.yaml.tpl', 'etny-securelock-test.yaml', replacementsSecurelock);

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

    console.log("# Update docker-compose files");

    const files = ['docker-compose.yml', 'docker-compose-final.yml'];

    files.forEach(file => {
        if (!fs.existsSync(file)) {
            console.error(`Error: ${file} not found!`);
            return;
        }

        console.log(`Processing ${file}`);
        console.log(`ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);

        console.log("Checking for placeholders before replacement:");
        const fileContentBefore = fs.readFileSync(file, 'utf8');
        if (fileContentBefore.includes('__ENCLAVE_NAME_SECURELOCK__')) {
            console.log(`__ENCLAVE_NAME_SECURELOCK__ found in ${file}`);
        } else {
            console.log(`Ok, No __ENCLAVE_NAME_SECURELOCK__ found in ${file}`);
        }

        const updatedContent = fileContentBefore
            .replace(/__ENCLAVE_NAME_SECURELOCK__/g, ENCLAVE_NAME_SECURELOCK)

        fs.writeFileSync(file, updatedContent, 'utf8');

        console.log("Checking for placeholders after replacement:");
        const fileContentAfter = fs.readFileSync(file, 'utf8');
        if (fileContentAfter.includes('__ENCLAVE_NAME_SECURELOCK__')) {
            console.log(`__ENCLAVE_NAME_SECURELOCK__ still found in ${file}`);
        } else {
            console.log(`Ok, No __ENCLAVE_NAME_SECURELOCK__ found in ${file}`);
        }

        console.log();
    });

    // TODO: calculate hash of the files localy, and query the public key service, if the hash is already there it means we dont have to do the below.

    if (fs.existsSync('certificate.securelock.crt')) {
        // delete it
        fs.unlinkSync('certificate.securelock.crt');
    }

    try {
        let output = execSync(`docker-compose run etny-securelock`, { cwd: runDir }).toString().trim();
        console.log("Output of docker-compose run etny-securelock:");
        let lines = output.split('\n');
        let publicKeyLine = lines.find(line => line.includes('PUBLIC_KEY:'));
        let PUBLIC_KEY_SECURELOCK_RES = publicKeyLine ? publicKeyLine.replace(/.*PUBLIC_KEY:\s*/, '').trim() : '';
    } catch (error) {
        console.log("Error: Could not fetch PUBLIC_KEY_SECURELOCK" + error);
        // console.error("Error: Could not fetch PUBLIC_KEY_SECURELOCK");
        PUBLIC_KEY_SECURELOCK_RES = '';
        console.log("");
    }
    console.log(`PUBLIC_KEY_SECURELOCK_RES: ${PUBLIC_KEY_SECURELOCK_RES}`);


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
            console.log("**** Started ipfs initial pining ****");
            if (fs.existsSync('IPFS_HASH.ipfs')) {
                fs.unlinkSync('IPFS_HASH.ipfs');
            }
            if (fs.existsSync('IPFS_DOCKER_COMPOSE_HASH.ipfs')) {
                fs.unlinkSync('IPFS_DOCKER_COMPOSE_HASH.ipfs');
            }


            console.log('Upload docker-compose-final.yml to IPFS');
            const dockerHash = execSync(`node ../ipfs.mjs --host "${process.env.IPFS_ENDPOINT}" --action upload --filePath docker-compose-final.yml`, { stdio: "inherit" });
            if (!fs.existsSync('IPFS_DOCKER_COMPOSE_HASH.ipfs')) {
                console.error("Error: Could not upload docker-compose-final.yml to IPFS, please try again!");
                process.exit(1);
            }
            process.env.IPFS_DOCKER_COMPOSE_HASH = fs.readFileSync('IPFS_DOCKER_COMPOSE_HASH.ipfs', 'utf8').trim();
            console.log("IPFS_DOCKER_COMPOSE_HASH: ", process.env.IPFS_DOCKER_COMPOSE_HASH);
            writeEnv('IPFS_DOCKER_COMPOSE_HASH', process.env.IPFS_DOCKER_COMPOSE_HASH);
            console.log()
            await new Promise(resolve => setTimeout(resolve, 3000));

            console.log('Upload docker registry to IPFS');
            const repositoryHash = execSync(`node ../ipfs.mjs --host "${process.env.IPFS_ENDPOINT}" --action upload --folderPath ${registryPath}`, { stdio: "inherit" });
            if (!fs.existsSync(`./IPFS_HASH.ipfs`)) {
                console.error("Error: Could not upload registry to IPFS, please try again!");
                process.exit(1);
            }
            process.env.IPFS_HASH = fs.readFileSync(`./IPFS_HASH.ipfs`, 'utf8').trim();
            console.log("IPFS_HASH: ", process.env.IPFS_HASH);
            writeEnv('IPFS_HASH', process.env.IPFS_HASH);

            console.log()

            console.log("**** Finished ipfs initial pining ****");
            console.log()
            console.log()

            console.log(`ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);
            execSync(`node ./public_key_service.js --enclave_name "${process.env.PROJECT_NAME}" --protocol_version "v3" --network "${process.env.BLOCKCHAIN_NETWORK}" --template_version "${process.env.VERSION}"`, { stdio: 'inherit' });
            PUBLIC_KEY_SECURELOCK_RES = fs.readFileSync('PUBLIC_KEY.txt', 'utf8').trim();
            console.log(`PUBLIC_KEY_SECURELOCK_RES: ${PUBLIC_KEY_SECURELOCK_RES}`);
            if (!PUBLIC_KEY_SECURELOCK_RES || PUBLIC_KEY_SECURELOCK_RES === '-1') {
                console.error("Error: Could not fetch PUBLIC_KEY_SECURELOCK");
                process.exit(1);
            }
        };
    }

    const CERTIFICATE_CONTENT_SECURELOCK = PUBLIC_KEY_SECURELOCK_RES.match(/-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----/s)[1].trim();
    if (!CERTIFICATE_CONTENT_SECURELOCK) {
        console.error("ERROR! PUBLIC_KEY_SECURELOCK not found");
        process.exit(1);
    } else {
        console.log("FOUND PUBLIC_KEY_SECURELOCK");
    }
    fs.writeFileSync('certificate.securelock.crt', PUBLIC_KEY_SECURELOCK_RES);
    console.log("Listing certificate PUBLIC_KEY_SECURELOCK:");
    console.log(fs.readFileSync('certificate.securelock.crt', 'utf8'));

    if (fs.existsSync('certificate.trustedzone.crt')) {
        fs.unlinkSync('certificate.trustedzone.crt');
    }

    const trustedZoneCert = execSync(`node ./image_registry.js "${process.env.BLOCKCHAIN_NETWORK}" "etny-pynithy" "v3" "" "getTrustedZoneCert"`).toString().trim();

    console.log("trustedZoneCert: ", trustedZoneCert);


    const CERTIFICATE_CONTENT_TRUSTEDZONE = trustedZoneCert.match(/-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----/s)[1].trim();
    const PUBLIC_KEY_TRUSTEDZONE = `-----BEGIN CERTIFICATE-----\n${CERTIFICATE_CONTENT_TRUSTEDZONE}\n-----END CERTIFICATE-----`;
    fs.writeFileSync('certificate.trustedzone.crt', PUBLIC_KEY_TRUSTEDZONE);
    console.log("Listing certificate PUBLIC_KEY_TRUSTEDZONE:");
    console.log(fs.readFileSync('certificate.trustedzone.crt', 'utf8'));

    fs.copyFileSync('certificate.securelock.crt', `${registryPath}/certificate.securelock.crt`);
    fs.copyFileSync('certificate.trustedzone.crt', `${registryPath}/certificate.trustedzone.crt`);

    if (fs.existsSync('IPFS_HASH.ipfs')) {
        fs.unlinkSync('IPFS_HASH.ipfs');
    }

    console.log('Upload docker registry to IPFS');
    execSync(`node ../ipfs.mjs --host "${process.env.IPFS_ENDPOINT}" --action upload --folderPath ${registryPath}`, { stdio: "inherit" });
    if (!fs.existsSync(`./IPFS_HASH.ipfs`)) {
        console.error("Error: Could not upload registry to IPFS, please try again!");
        process.exit(1);
    }
    process.env.IPFS_HASH = fs.readFileSync(`./IPFS_HASH.ipfs`, 'utf8').trim();
    console.log("IPFS_HASH: ", process.env.IPFS_HASH);
    writeEnv('IPFS_HASH', process.env.IPFS_HASH);
    process.chdir(currentDir);
    console.log("Adding certificates for SECURELOCK into IMAGE REGISTRY smart contract...");
    let existing = false;
    try {
        const existingImages = execSync(`node ${runDir}/image_registry.js "${process.env.BLOCKCHAIN_NETWORK}" "${process.env.PROJECT_NAME}" "${process.env.VERSION}" "${process.env.PRIVATE_KEY}" "registerSecureLockImage"`, { stdio: "inherit" });
        if (existingImages.toString().trim().replace('Image hash: ', '') === process.env.IPFS_HASH) {
            console.log("Certificates for SECURELOCK already added to IMAGE REGISTRY smart contract");
        }
        existing = true;
    } catch (error) {
    }

    if (!existing) {
        const res = execSync(`node ${runDir}/image_registry.js "${process.env.BLOCKCHAIN_NETWORK}" "" "" "" "registerSecureLockImage"`, { stdio: "inherit" });
    }
    console.log("Script completed successfully. You can start testing the application now. (eg. npm run start)");
    process.exit(0);
};

main();