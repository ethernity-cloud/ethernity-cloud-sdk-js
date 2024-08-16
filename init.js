const fs = require('fs');
const readline = require('readline');
const { spawn, execSync } = require('child_process');
const path = require('path');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const writeEnv = (key, value) => {
    const envFile = '.env';
    let content = '';

    if (fs.existsSync(envFile)) {
        content = fs.readFileSync(envFile, 'utf8');
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(content)) {
            content = content.replace(regex, `${key}=${value}`);
        } else {
            content += `\n${key}=${value}`;
        }
    } else {
        content = `${key}=${value}`;
    }

    fs.writeFileSync(envFile, content, 'utf8');
};

const getProjectName = () => {
    return new Promise((resolve) => {
        const askProjectName = () => {
            rl.question('Choose a name for your project: ', (projectName) => {
                if (projectName.trim() === '') {
                    console.log('Project name cannot be blank. Please enter a valid name.');
                    askProjectName();
                } else {
                    console.log(`You have chosen the project name: ${projectName}`);
                    resolve(projectName);
                }
            });
        };
        askProjectName();
    });
};

const displayOptions = (options) => {
    options.forEach((option, index) => {
        console.log(`${index + 1}) ${option}`);
    });
};

const promptOptions = (message, options, defaultOption) => {
    return new Promise((resolve) => {
        const askOption = () => {
            displayOptions(options);
            rl.question(message, (reply) => {
                if (reply.trim() === '') {
                    console.log(`No option selected. Defaulting to ${defaultOption}.`);
                    resolve(defaultOption);
                } else if (!isNaN(reply) && reply >= 1 && reply <= options.length) {
                    resolve(options[reply - 1]);
                } else {
                    console.log(`Invalid option ${reply}. Please select a valid number.`);
                    askOption();
                }
            });
        };
        askOption();
    });
};

const printIntro = () => {
    const intro = `
    ╔───────────────────────────────────────────────────────────────────────────────────────────────────────────────╗
    │                                                                                                               │
    │        .... -+++++++. ....                                                                                    │
    │     -++++++++-     .++++++++.      _____ _   _                     _ _             ____ _                 _   │
    │   .++-     ..    .++-     .++-    | ____| |_| |__   ___ _ __ _ __ (_) |_ _   _    / ___| | ___  _   _  __| |  │
    │  --++----      .++-         ...   |  _| | __| '_ \\ / _ \\ '__| '_ \\| | __| | | |  | |   | |/ _ \\| | | |/ _\` |  │
    │  --++----    .++-.          ...   | |___| |_| | | |  __/ |  | | | | | |_| |_| |  | |___| | (_) | |_| | (_| |  │
    │   .++-     .+++.    .     .--.    |_____|\\__|_| |_|\\___|_|  |_| |_|_|\\__|\\__, |   \\____|_|\\___/ \\__,_|\\__,_|  │
    │     -++++++++.    .---------.                                            |___/                                │
    │        .... .-------. ....                                                                                    │
    │                                                                                                               │
    ╚───────────────────────────────────────────────────────────────────────────────────────────────────────────────╝
                                          Welcome to the Ethernity Cloud SDK

       The Ethernity Cloud SDK is a comprehensive toolkit designed to facilitate the development and management of
      decentralized applications (dApps) and serverless binaries on the Ethernity Cloud ecosystem. Geared towards
      developers proficient in Python or Node.js, this toolkit aims to help you effectively harness the key features
      of the ecosystem, such as data security, decentralized processing, and blockchain-driven transparency and
      trustless model for real-time data processing.
      `;
    console.log(intro);
};

const main = async () => {
    printIntro();
    const projectName = await getProjectName();
    console.log()
    const serviceTypeOptions = ["Nodenithy", "Pynithy", "Custom"];
    const serviceType = await promptOptions("Select the type of code to be ran during the compute layer (default is Nodenithy): ", serviceTypeOptions, "Nodenithy");

    let dockerRepoUrl, dockerLogin, dockerPassword, baseImageTag;
    if (serviceType === "Custom") {
        dockerRepoUrl = await new Promise((resolve) => rl.question('Enter Docker repository URL: ', resolve));
        dockerLogin = await new Promise((resolve) => rl.question('Enter Docker Login (username): ', resolve));
        dockerPassword = await new Promise((resolve) => rl.question('Enter Password: ', resolve));
        baseImageTag = await new Promise((resolve) => rl.question('Enter the image tag: ', resolve));
    }
    console.log()
    const blockchainNetworkOptions = ["Bloxberg Mainnet", "Bloxberg Testnet", "Polygon Mainnet", "Polygon Amoy Testnet"];
    const blockchainNetwork = await promptOptions("On which Blockchain network do you want to have the app set up, as a starting point? (default is Bloxberg Testnet): ", blockchainNetworkOptions, "Bloxberg Testnet");
    console.log()

    console.log(`Checking if the project name (image name) is available on the ${blockchainNetwork.replace(/ /g, "_")} network and ownership...`);
    // const { execSync } = require('child_process');
    // execSync(`python $(pwd)/node_modules/ethernity-cloud-sdk-js/nodenithy/run/image_registry.py "${blockchainNetwork.replace(/ /g, "_")}" "${projectName.replace(/ /g, "-")}" v3`);
    const scriptPath = path.resolve(__dirname, 'nodenithy/run/image_registry.js');
    // Spawn a new process to run the image_registry.js script
    const runChildProcess = () => new Promise((resolve, reject) => {
        const child = spawn('node', [scriptPath, blockchainNetwork.replace(/ /g, "_"), projectName.replace(/ /g, "-"), 'v3']);
        // Handle stdout data
        child.stdout.on('data', (data) => {
            console.log(`${data}`.replace('duplicate definition - constructor',''));
        });
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject();
            }
        });
    });
    await runChildProcess();


    // // Handle stderr data
    // child.stderr.on('data', (data) => {
    //     console.error(`stderr: ${data}`);
    // });

    // Handle process exit
    // child.on('close', (code) => {
    //     console.log(`child process exited with code ${code}`);
    // });


    console.log()
    const ipfsServiceOptions = ["Ethernity (best effort)", "Custom IPFS"];
    const ipfsService = await promptOptions("Select the IPFS pinning service you want to use (default is Ethernity): ", ipfsServiceOptions, "Ethernity (best effort)");

    let customUrl, ipfsToken;
    if (ipfsService === "Custom IPFS") {
        customUrl = await new Promise((resolve) => rl.question('Enter the endpoint URL for the IPFS pinning service you want to use: ', resolve));
        ipfsToken = await new Promise((resolve) => rl.question('Enter the access token to be used when calling the IPFS pinning service: ', resolve));
    } else {
        customUrl = "http://ipfs.ethernity.cloud:5001";
    }

    fs.mkdirSync('src/serverless', { recursive: true });

    console.log()
    const appTemplateOptions = ["yes", "no"];
    const useAppTemplate = await promptOptions("Do you want a 'Hello World' app template as a starting point? (default is yes): ", appTemplateOptions, "yes");

    if (useAppTemplate === "yes") {
        console.log("Bringing Frontend/Backend templates...");
        console.log("  src/serverless/backend.js (Hello World function)");
        console.log("  src/ec_helloworld_example.js (Hello World function call - Frontend)");
        // Simulate copying files
        fs.cpSync('node_modules/ethernity-cloud-sdk-js/nodenithy/src/', 'src/', { recursive: true });
        fs.cpSync('node_modules/ethernity-cloud-sdk-js/nodenithy/public/', 'public/', { recursive: true });
        console.log("Installing required packages...");
        // Simulate npm install
        execSync('npm install @ethernity-cloud/runner@0.0.26 @testing-library/jest-dom@5.17.0 @testing-library/react@13.4.0 @testing-library/user-event@13.5.0 react@18.3.1 react-dom@18.3.1 react-scripts@5.0.1 web-vitals@2.1.4 web3@4.9.0 dotenv@16.4.5', { stdio: 'inherit' });
    } else {
        console.log("Define backend functions in src/ectasks to be available for Frontend interaction.");
    }

    writeEnv("PROJECT_NAME", projectName.replace(/ /g, "_"));
    writeEnv("SERVICE_TYPE", serviceType);
    if (serviceType === "Custom") {
        writeEnv("BASE_IMAGE_TAG", baseImageTag || "");
        writeEnv("DOCKER_REPO_URL", dockerRepoUrl);
        writeEnv("DOCKER_LOGIN", dockerLogin);
        writeEnv("DOCKER_PASSWORD", dockerPassword);
    } else if (serviceType === "Nodenithy") {
        writeEnv("BASE_IMAGE_TAG", "");
        writeEnv("DOCKER_REPO_URL", "registry.scontain.com:5050");
        writeEnv("DOCKER_LOGIN", "ab@ethernity.cloud");
        writeEnv("DOCKER_PASSWORD", "BHtqnWPDmW5Qa!M");
    } else if (serviceType === "Pynithy") {
        writeEnv("BASE_IMAGE_TAG", "");
        writeEnv("DOCKER_REPO_URL", "registry.scontain.com:5050");
        writeEnv("DOCKER_LOGIN", "ab@ethernity.cloud");
        writeEnv("DOCKER_PASSWORD", "BHtqnWPDmW5Qa!M");
    }
    writeEnv("BLOCKCHAIN_NETWORK", blockchainNetwork.replace(/ /g, "_"));
    writeEnv("IPFS_ENDPOINT", customUrl);
    writeEnv("IPFS_TOKEN", ipfsToken || "");
    writeEnv("VERSION", "v1");
    console.log()
    console.log("To start the application, run the appropriate start command based on your setup.");
    rl.close();
};

main();