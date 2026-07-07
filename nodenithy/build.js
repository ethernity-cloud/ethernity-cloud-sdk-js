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
const buildDir = path.join(currentDir, 'node_modules/@ethernity-cloud/sdk-js/nodenithy/build');
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

// templateName is TRUSTED_ZONE_IMAGE (the registry image-name segment); trustedZoneNet
// is the network tag the nodenithy CI pushes the prebuilt trustedzone under
// (registry.ethernity.cloud:443/.../<templateName>/trustedzone:<trustedZoneNet>). Both must
// match v3/networks.yaml image_name + network key in the etny-nodenithy repo, or the pull
// below 404s and the SDK falls back to the vendored tarball.
let templateName = "";
let trustedZoneNet = "";
if (process.env.BLOCKCHAIN_NETWORK === 'Bloxberg_Testnet') {
  templateName = 'etny-nodenithy-testnet'; trustedZoneNet = 'bloxberg_testnet';
} else if (process.env.BLOCKCHAIN_NETWORK === 'Bloxberg_Mainnet') {
  templateName = 'etny-nodenithy'; trustedZoneNet = 'bloxberg';
} else if (process.env.BLOCKCHAIN_NETWORK === 'Polygon_Mainnet') {
  templateName = 'ecld-nodenithy'; trustedZoneNet = 'polygon';
} else if (process.env.BLOCKCHAIN_NETWORK === 'Polygon_Amoy_Testnet') {
  // image_name in etny-nodenithy v3/networks.yaml (amoy) is ecld-nodenithy-amoy,
  // NOT ecld-nodenithy-testnet -- must match or the registry pull 404s.
  templateName = 'ecld-nodenithy-amoy'; trustedZoneNet = 'amoy';
} else {
  templateName = 'etny-nodenithy-testnet'; trustedZoneNet = 'bloxberg_testnet';
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

// Prefer the CI-built trustedzone published to the ethernity registry by the
// etny-nodenithy pipeline (registry.ethernity.cloud:443/.../<templateName>/trustedzone:<net>).
// This mirrors the Python SDK (ec-sdk-py build.py) and keeps the bundled trustedzone
// in sync with what is registered on-chain -- the vendored etny-trustedzone.tar.zip
// only refreshes when someone manually re-vendors it, so it drifts. Fall back to the
// vendored tarball if the pull fails (e.g. tag not yet published for this network).
const trustedZoneImage = `registry.ethernity.cloud:443/debuggingdelight/ethernity-cloud-sdk-registry/${templateName}/trustedzone:${trustedZoneNet}`;
let pulledTrustedZone = false;
console.log(`Pulling prebuilt trustedzone: ${trustedZoneImage}`);
// canPass=true: a failed pull must NOT exit the build -- fall back to the vendored
// tarball instead (runCommand process.exit(1)s on failure otherwise).
if (shell.exec(`docker pull ${trustedZoneImage}`).code === 0) {
  runCommand(`docker tag ${trustedZoneImage} etny-trustedzone:latest`);
  pulledTrustedZone = true;
} else {
  console.log(`WARN: could not pull ${trustedZoneImage}; falling back to vendored etny-trustedzone.tar.zip`);
}
if (!pulledTrustedZone) {
  const zip = new AdmZip('etny-trustedzone.tar.zip');
  zip.extractAllTo('.', true);
  runCommand('docker load -i etny-trustedzone.tar');
}
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
