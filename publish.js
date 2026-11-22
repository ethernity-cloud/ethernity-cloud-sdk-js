const fs = require('fs');
const readline = require('readline');
const { execSync, spawn } = require('child_process');
const path = require('path');
// The environment publish.js was started with, before dotenv adds the
// variables of .env to process.env.
const startEnv = { ...process.env };
require('dotenv').config();
const casConfig = require('./cas/config.js');
const { resolvePrivateKey, promptHidden, readEnvFile, KeyError } = require('./privateKey.js');

// Function to write to .env file
const writeEnv = (key, value) => {
    try {
        const envFile = '.env';
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

        fs.writeFileSync(envFile, envContent, 'utf8');
    } catch (error) {
        console.log(error);
    }
  };

// Function to prompt user input
async function prompt(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(answer);
    }));
}

(async () => {
    const { PROJECT_NAME, BLOCKCHAIN_NETWORK, DEVELOPER_FEE, SERVICE_TYPE } = process.env;
    const scriptPath = path.resolve(__dirname, 'nodenithy/run/image_registry.js');
    process.env.NODE_NO_WARNINGS = 1
    // image_registry.js reads the wallet's key from PRIVATE_KEY in its
    // environment, never from its command line.
    const registry = (args, privateKey) => execSync(`node ${scriptPath} ${args}`,
        { env: { ...process.env, PRIVATE_KEY: privateKey } }).toString().trim();
    let result = '';
    const isTTY = Boolean(process.stdin.isTTY);
    // ECLD_PRIVATE_KEY, PRIVATE_KEY, the ENC_PRIVATE_KEY of .env decrypted,
    // or a key entered here and stored encrypted (privateKey.js).
    let privateKey;
    try {
        privateKey = await resolvePrivateKey('publish', {
            env: startEnv, file: readEnvFile('.env'), isTTY,
            prompt, promptHidden, writeEnv, log: (line) => console.log(line),
        });
    } catch (e) {
        if (!(e instanceof KeyError)) throw e;
        if (e.message) console.log(e.message);
        process.exit(e.exitCode);
    }
    // The key when image_registry.js accepts it, else one entered on the
    // terminal until it does.
    const validated = async (key) => {
        result = registry('"" "" "" "validateAddress"', key);
        while (result !== 'OK') {
            console.log(result);
            if (!isTTY) {
                console.log('The private key is not valid and there is no terminal to enter another.');
                process.exit(2);
            }
            key = await prompt('Invalid private key. Please enter a valid private key: ');
            result = registry('"" "" "" "validateAddress"', key);
        }
        return key;
    };
    if (!PROJECT_NAME || !BLOCKCHAIN_NETWORK || !DEVELOPER_FEE) {
        privateKey = await validated(privateKey);
        console.log()
        console.log('Checking blockchain for required funds...');

        result = registry('"" "" "" "checkBalance"', privateKey);

        console.log(`Available funds: ${result}`);
        console.log()
        const imageName = casConfig.nameOnNetwork(PROJECT_NAME, BLOCKCHAIN_NETWORK);
        console.log(`Checking if project name ${imageName} is available on ${BLOCKCHAIN_NETWORK} network and ownership...`);
        // Exits 1, with the owner, when another wallet owns the name.
        try {
            result = registry(`${BLOCKCHAIN_NETWORK} ${imageName} ${process.env.VERSION}`, privateKey);
        } catch (e) {
            console.log((e.stdout || '').toString().trim());
            process.exit(1);
        }
        console.log(result);
        console.log()

        // The publisher's fee, in percent of each task's base price: PoX adds it
        // to what the dApp user pays and pays it to the image's reward address.
        const taskPercentage = await prompt('Your fee as the publisher of this image, in % of each task\'s base price, 0 to 15 (default 0): ') || '0';
        writeEnv('DEVELOPER_FEE', taskPercentage);
    } else {
        console.log('Using PROJECT_NAME, BLOCKCHAIN_NETWORK, DEVELOPER_FEE from .env');
        console.log('Checking blockchain for required funds...');
        result = registry('"" "" "" "checkBalance"', privateKey);

        console.log(`Available funds: ${result}`);
        console.log()
        privateKey = await validated(privateKey);
    }

    // run.js, and the image_registry.js it runs, read the key from PRIVATE_KEY
    // in their environment: dotenv sets no variable the environment holds.
    if (SERVICE_TYPE === 'Nodenithy') {
        console.log('Adding prerequisites for Nodenithy...');
        // the current process can be exited 'cross-env node ./node_modules/@ethernity-cloud/sdk-js/nodenithy/run.js'
        const run = spawn('node', ['./node_modules/@ethernity-cloud/sdk-js/nodenithy/run.js'], {
            env: { ...process.env, PRIVATE_KEY: privateKey },
            stdio: 'inherit'
        });

        run.on('exit', code => {
            console.log('Exit code:', code);
            process.exit(code);
        });
    } else if (SERVICE_TYPE === 'Pynithy') {
        console.log('Adding prerequisites for Pynithy...');
        const run = spawn('node', ['./node_modules/@ethernity-cloud/sdk-js/pynithy/run.js'], {
            env: { ...process.env, PRIVATE_KEY: privateKey },
            stdio: 'inherit'
        });

        run.on('exit', code => {
            console.log('Exit code:', code);
            process.exit(code);
        });
    } else {
        console.log('Something went wrong');
        process.exit(1);
    }
})();