import shell from 'shelljs';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const VERSION = process.env.VERSION;
console.log(`Building ${VERSION}`);

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

  fs.writeFileSync(envFile, envContent, 'utf8');
};
// runner name: [smart contract address, image registry address, rpc url, chainid]
export const ECRunner = {
  'etny-pynithy-testnet': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c', '0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31', 'https://core.bloxberg.org', 8995],
  'etny-nodenithy-testnet': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c', '0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31', 'https://core.bloxberg.org', 8995],
  'etny-pynithy': ['0x549A6E06BB2084100148D50F51CF77a3436C3Ae7', '0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31', 'https://core.bloxberg.org', 8995],
  'etny-nodenithy': ['0x549A6E06BB2084100148D50F51CF77a3436C3Ae7', '0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31', 'https://core.bloxberg.org', 8995],
  'ecld-nodenithy-testnet': ['0x4274b1188ABCfa0d864aFdeD86bF9545B020dCDf', '0xF7F4eEb3d9a64387F4AcEb6d521b948E6E2fB049', 'https://rpc-mumbai.matic.today', 80001],
  'ecld-pynithy': ['0x439945BE73fD86fcC172179021991E96Beff3Cc4', '0x689f3806874d3c8A973f419a4eB24e6fBA7E830F', 'https://polygon-rpc.com', 137],
  'ecld-nodenithy': ['0x439945BE73fD86fcC172179021991E96Beff3Cc4', '0x689f3806874d3c8A973f419a4eB24e6fBA7E830F', 'https://polygon-rpc.com', 137]
};

const runCommand = (command, canPass = false) => {
  if (shell.exec(command).code !== 0 && !canPass) {
    console.error(`Error executing command: ${command}`);
    process.exit(1);
  }
};

// Downloading dependencies
shell.rm('-rf', './registry');
const currentDir = process.cwd();
// console.log(`current_dir: ${currentDir}`);
const buildDir = path.join(currentDir, 'node_modules/ethernity-cloud-sdk-js/nodenithy/build');
// console.log(`build_dir: ${buildDir}`);

const dockerPS = shell.exec('docker ps --filter name=registry -q', { silent: true }).stdout.trim();
if (dockerPS) {
  runCommand(`docker stop ${dockerPS.split('\n').join(' ')}`);
}
const dockeri = shell.exec('docker ps --filter name=las -q', { silent: true }).stdout.trim();
if (dockeri) {
  runCommand(`docker stop ${dockeri.split('\n').join(' ')}`);
}
const dockerRm = shell.exec('docker ps --filter name=registry -q', { silent: true }).stdout.trim();
if (dockerRm) {
  runCommand(`docker rm ${dockerRm.split('\n').join(' ')} -f`);
}
const dockerImg = shell.exec('docker images --filter reference="*etny*" -q', { silent: true }).stdout.trim();
if (dockerImg) {
  runCommand(`docker rmi ${dockerImg.split('\n').join(' ')} -f`);
}
const dockerImgReg = shell.exec('docker images --filter reference="*registry*" -q', { silent: true }).stdout.trim();
if (dockerImgReg) {
  runCommand(`docker rmi ${dockerImgReg.split('\n').join(' ')} -f`);
}
runCommand(`docker rm registry -f`);



const srcDir = './src/serverless';
const destDir = path.join(buildDir, 'securelock/src/serverless');
console.log(`Creating destination directory: ${destDir}`);
fs.mkdirSync(destDir, { recursive: true });

console.log(`Copying files from ${srcDir} to ${destDir}`);
fs.readdirSync(srcDir).forEach(file => {
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
});

process.chdir(buildDir);

let templateName = process.env.TRUSTED_ZONE_IMAGE || 'etny-nodenithy-testnet';

const isMainnet = !templateName.includes('testnet');

const ENCLAVE_NAME_TRUSTEDZONE = templateName;

runCommand('docker pull registry:2');
runCommand('docker run -d --restart=always -p 5000:5000 --name registry registry:2');
// runCommand(`docker login ${process.env.DOCKER_REPO_URL} -u ${process.env.DOCKER_LOGIN} -p ${process.env.DOCKER_PASSWORD}`);

// const CI_COMMIT_BRANCH = process.env.PROJECT_NAME;
// aleXPRoj-securelock-v3-testnet-0.1.0...
const ENCLAVE_NAME_SECURELOCK = `${process.env.PROJECT_NAME}-SECURELOCK-V3-${process.env.BLOCKCHAIN_NETWORK.split('_')[1].toLowerCase()}-${VERSION}`.replace(/\//g, '_').replace(/-/g, '_');
console.log(`ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);
writeEnv('ENCLAVE_NAME_SECURELOCK', ENCLAVE_NAME_SECURELOCK);

console.log('Building etny-securelock');
process.chdir('securelock');
// runCommand(`cat Dockerfile.tmpl | sed s/"__ENCLAVE_NAME_SECURELOCK__"/"${ENCLAVE_NAME_SECURELOCK}"/g > Dockerfile`);
const dockerfileSecureTemplate = fs.readFileSync('Dockerfile.tmpl', 'utf8');
const dockerfileSecureContent = dockerfileSecureTemplate.replace(/__ENCLAVE_NAME_SECURELOCK__/g, ENCLAVE_NAME_SECURELOCK).replace(/__BUCKET_NAME__/g, templateName + "-v3").replace(/__SMART_CONTRACT_ADDRESS__/g, ECRunner[templateName][0]).replace(/__IMAGE_REGISTRY_ADDRESS__/g, ECRunner[templateName][1]).replace(/__RPC_URL__/g, ECRunner[templateName][2]).replace(/__CHAIN_ID__/g, ECRunner[templateName][3]);
let imagesTag = process.env.BLOCKCHAIN_NETWORK.toLowerCase();
if (isMainnet) {
  fs.writeFileSync('Dockerfile', dockerfileSecureContent.replace('# RUN scone-signer sign --key=/enclave-key.pem --env --production /usr/bin/node', 'RUN scone-signer sign --key=/enclave-key.pem --env --production /usr/bin/node'));
  imagesTag = process.env.BLOCKCHAIN_NETWORK.split("_")[0].toLowerCase()
}

fs.writeFileSync('Dockerfile', dockerfileSecureContent);


runCommand(`docker build --build-arg ENCLAVE_NAME_SECURELOCK=${ENCLAVE_NAME_SECURELOCK} -t etny-securelock:latest .`);
runCommand('docker tag etny-securelock localhost:5000/etny-securelock');
runCommand('docker push localhost:5000/etny-securelock');
// runCommand('docker save etny-securelock:latest -o etny-securelock.tar');
process.chdir('..');
// const ENCLAVE_NAME_TRUSTEDZONE = `ENCLAVE_NAME_TRUSTEDZONE_${VERSION}_${CI_COMMIT_BRANCH}`.toUpperCase().replace(/\//g, '_').replace(/-/g, '_');


console.log(`ENCLAVE_NAME_TRUSTEDZONE: ${ENCLAVE_NAME_TRUSTEDZONE}`);
writeEnv('ENCLAVE_NAME_TRUSTEDZONE', ENCLAVE_NAME_TRUSTEDZONE);

console.log('Building etny-trustedzone');
process.chdir('trustedzone');

// // runCommand(`cat Dockerfile.tmpl | sed s/"__ENCLAVE_NAME_TRUSTEDZONE__"/"${ENCLAVE_NAME_TRUSTEDZONE}"/g > Dockerfile`);
// const dockerfileTrustedTemplate = fs.readFileSync('Dockerfile.tmpl', 'utf8');
// const dockerfileTrustedContent = dockerfileTrustedTemplate.replace(/__ENCLAVE_NAME_SECURELOCK__/g, ENCLAVE_NAME_SECURELOCK);
// fs.writeFileSync('Dockerfile', dockerfileTrustedContent);

// runCommand(`docker build --build-arg ENCLAVE_NAME_TRUSTEDZONE=${ENCLAVE_NAME_TRUSTEDZONE} -t etny-trustedzone:latest .`);
// runCommand('docker tag etny-trustedzone localhost:5000/etny-trustedzone');
// runCommand('docker push localhost:5000/etny-trustedzone');
// runCommand('docker save etny-trustedzone:latest -o etny-trustedzone.tar');
// const zip = new AdmZip('etny-trustedzone.tar.zip');
// zip.extractAllTo('.', true);

runCommand(`docker pull registry.ethernity.cloud:443/debuggingdelight/ethernity-cloud-sdk-registry/ethernity/etny-trustedzone:${imagesTag}`);
runCommand(`docker tag registry.ethernity.cloud:443/debuggingdelight/ethernity-cloud-sdk-registry/ethernity/etny-trustedzone:${imagesTag} localhost:5000/etny-trustedzone`);
runCommand('docker push localhost:5000/etny-trustedzone');

if (isMainnet) {
  console.log('Building validator');
  process.chdir('../validator');
  // runCommand('docker build -t etny-validator:latest .');
  // runCommand('docker tag etny-validator localhost:5000/etny-validator');
  // runCommand('docker push localhost:5000/etny-validator');
  runCommand(`docker pull registry.ethernity.cloud:443/debuggingdelight/ethernity-cloud-sdk-registry/ethernity/etny-validator:${imagesTag}`);
  runCommand(`docker tag registry.ethernity.cloud:443/debuggingdelight/ethernity-cloud-sdk-registry/ethernity/etny-validator:${imagesTag} localhost:5000/etny-validator`);
  runCommand('docker push localhost:5000/etny-validator');
}


console.log('Building etny-las');
process.chdir('../las');
// runCommand('docker build -t etny-las .');
// runCommand('docker tag etny-las localhost:5000/etny-las');
// runCommand('docker push localhost:5000/etny-las');
runCommand(`docker pull registry.ethernity.cloud:443/debuggingdelight/ethernity-cloud-sdk-registry/ethernity/etny-las:${imagesTag}`);
runCommand(`docker tag registry.ethernity.cloud:443/debuggingdelight/ethernity-cloud-sdk-registry/ethernity/etny-las:${imagesTag} localhost:5000/etny-las`);
runCommand('docker push localhost:5000/etny-las');


process.chdir(currentDir);
runCommand('docker cp registry:/var/lib/registry registry');

console.log('Cleaning up');
fs.rmSync(destDir, { recursive: true, force: true });
