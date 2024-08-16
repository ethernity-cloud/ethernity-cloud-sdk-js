const fs = require('fs');
const readline = require('readline');
const { execSync, spawn } = require('child_process');
const path = require('path');
require('dotenv').config();

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
    const { PROJECT_NAME, BLOCKCHAIN_NETWORK, PRIVATE_KEY, DEVELOPER_FEE, SERVICE_TYPE } = process.env;
    const scriptPath = path.resolve(__dirname, 'nodenithy/run/image_registry.js');
    process.env.NODE_NO_WARNINGS = 1
    let result = '';
    if (!PROJECT_NAME || !BLOCKCHAIN_NETWORK || !PRIVATE_KEY || !DEVELOPER_FEE) {
        const hasWallet = await prompt('Do you have an existing wallet? (yes/no) ');
        console.log()
        if (hasWallet.toLowerCase() !== 'yes') {
            console.log('Without a wallet, you will not be able to publish.');
            console.log('Please refer to Blockchain Wallets Documentation (https://docs.ethernity.cloud/ethernity-node/prerequisites-ethernity-node/blockchain-wallets).');
            process.exit(1);
        }

        let privateKey = await prompt('Enter your private key: ');
        result = execSync(`node ${scriptPath} "" "" "" "${privateKey}" "validateAddress"`).toString().trim();

        while (result !== 'OK') {
            console.log(result);
            privateKey = await prompt('Invalid private key. Please enter a valid private key: ');
            result = execSync(`node ${scriptPath} "" "" "" "${privateKey}" "validateAddress"`).toString().trim();
        }

        console.log('Inputted Private key is valid.');
        writeEnv('PRIVATE_KEY', privateKey);
        console.log()
        console.log('Checking blockchain for required funds...');

        result = execSync(`node ${scriptPath} "" "" "" "" "checkBalance"`).toString().trim();

        console.log(`Available funds: ${result}`);
        console.log()
        console.log(`Checking if project name is available on ${BLOCKCHAIN_NETWORK} network and ownership...`);
        result = execSync(`node ${scriptPath} ${BLOCKCHAIN_NETWORK} ${PROJECT_NAME} "v3" ${PRIVATE_KEY}`,).toString().trim();
        console.log(result);
        console.log()

        const taskPercentage = await prompt('Please specify the % of a task which will be transferred to your wallet upon successful execution (default 10%): ') || '10';
        writeEnv('DEVELOPER_FEE', taskPercentage);
    } else {
        console.log('Using PROJECT_NAME, BLOCKCHAIN_NETWORK, PRIVATE_KEY, DEVELOPER_FEE from .env');
        console.log('Checking blockchain for required funds...');
        result = result = execSync(`node ${scriptPath} "" "" "" "" "checkBalance"`).toString().trim();

        console.log(`Available funds: ${result}`);
        console.log()
        let privateKey = PRIVATE_KEY;
        result = execSync(`node ${scriptPath} "" "" "" "${privateKey}" "validateAddress"`).toString().trim();

        while (result !== 'OK') {
            console.log(result);
            privateKey = await prompt('Invalid private key. Please enter a valid private key: ');
            result = execSync(`node ${scriptPath} "" "" "" "${privateKey}" "validateAddress"`).toString().trim();
        }
        writeEnv('PRIVATE_KEY', privateKey);
    }

    if (SERVICE_TYPE === 'Nodenithy') {
        console.log('Adding prerequisites for Nodenithy...');
        // const runScript = spawn('node', ['./node_modules/ethernity-cloud-sdk-js/nodenithy/run.js'], { stdio: ['inherit', 'inherit', 'inherit'] });

        // runScript.on('close', (code) => {
        //     console.log(`Child process exited with code ${code}`);
        // });
    } else if (SERVICE_TYPE === 'Pynithy') {
        console.log('Adding prerequisites for Pynithy...');
    } else {
        console.log('Something went wrong');
        process.exit(1);
    }
})();