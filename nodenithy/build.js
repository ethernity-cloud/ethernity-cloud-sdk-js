const AdmZip = require('adm-zip');
const shell = require('shelljs');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

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

let templateName = "";
if (process.env.BLOCKCHAIN_NETWORK === 'Bloxberg_Testnet') {
  templateName = 'etny-nodenithy-testnet';
} else if (process.env.BLOCKCHAIN_NETWORK === 'Bloxberg_Mainnet') {
  templateName = 'etny-nodenithy';
} else if (process.env.BLOCKCHAIN_NETWORK === 'Polygon_Mainnet') {
  templateName = 'ecld-nodenithy';
} else if (process.env.BLOCKCHAIN_NETWORK === 'Polygon_Amoy_Testnet') {
  templateName = 'ecld-nodenithy-testnet';
} else {
  templateName = 'etny-nodenithy-testnet';
}

const ENCLAVE_NAME_TRUSTEDZONE = templateName;

runCommand('docker pull registry:2');
runCommand('docker run -d --restart=always -p 5000:5000 --name registry registry:2');
runCommand(`docker login ${process.env.DOCKER_REPO_URL} -u ${process.env.DOCKER_LOGIN} -p ${process.env.DOCKER_PASSWORD}`);

// const CI_COMMIT_BRANCH = process.env.PROJECT_NAME;
// aleXPRoj-securelock-v3-testnet-0.1.0...
const ENCLAVE_NAME_SECURELOCK = `${process.env.PROJECT_NAME}-SECURELOCK-V3-${process.env.BLOCKCHAIN_NETWORK.split('_')[1].toLowerCase()}-${VERSION}`.replace(/\//g, '_').replace(/-/g, '_');
console.log(`ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);
writeEnv('ENCLAVE_NAME_SECURELOCK', ENCLAVE_NAME_SECURELOCK);

console.log('Building etny-securelock');
process.chdir('securelock');
// runCommand(`cat Dockerfile.tmpl | sed s/"__ENCLAVE_NAME_SECURELOCK__"/"${ENCLAVE_NAME_SECURELOCK}"/g > Dockerfile`);
const dockerfileSecureTemplate = fs.readFileSync('Dockerfile.tmpl', 'utf8');
const dockerfileSecureContent = dockerfileSecureTemplate.replace(/__ENCLAVE_NAME_SECURELOCK__/g, ENCLAVE_NAME_SECURELOCK).replace(/__BUCKET_NAME__/g, templateName+"-v3");
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
const zip = new AdmZip('etny-trustedzone.tar.zip');
zip.extractAllTo('.', true);

runCommand('docker load -i etny-trustedzone.tar');
runCommand('docker tag etny-trustedzone:latest localhost:5000/etny-trustedzone');
runCommand('docker push localhost:5000/etny-trustedzone');

console.log('Building validator');
process.chdir('../validator');
runCommand('docker build -t etny-validator:latest .');
runCommand('docker tag etny-validator localhost:5000/etny-validator');
runCommand('docker push localhost:5000/etny-validator');
// runCommand('docker save etny-validator:latest -o etny-validator.tar');

console.log('Building etny-las');
process.chdir('../las');
runCommand('docker build -t etny-las .');
runCommand('docker tag etny-las localhost:5000/etny-las');
runCommand('docker push localhost:5000/etny-las');
// runCommand('docker save etny-las:latest -o etny-las.tar');


process.chdir(currentDir);
runCommand('docker cp registry:/var/lib/registry registry');

console.log('Cleaning up');
fs.rmSync(destDir, { recursive: true, force: true });
