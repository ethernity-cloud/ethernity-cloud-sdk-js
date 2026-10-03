import shell from 'shelljs';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
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
// [templateName]: [smart_contract_address, image_registry_address, rpc_url, chain_id]
// Kept in sync with etny-{pynithy,nodenithy}/v3/networks.yaml (the authoritative
// on-chain constants). Covers all supported networks for both dApp types.
export const ECRunner = {
  // --- bloxberg (the testnet reads ECImageRegistryV2, mainnet the original) ---
  'etny-pynithy-testnet': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c', '0x99A84C624C028bdf0a855A1E9E3f2fcf7275B3D8', 'https://bloxberg.ethernity.cloud', 8995],
  'etny-nodenithy-testnet': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c', '0x99A84C624C028bdf0a855A1E9E3f2fcf7275B3D8', 'https://bloxberg.ethernity.cloud', 8995],
  'etny-pynithy': ['0x549A6E06BB2084100148D50F51CF77a3436C3Ae7', '0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31', 'https://bloxberg.ethernity.cloud', 8995],
  'etny-nodenithy': ['0x549A6E06BB2084100148D50F51CF77a3436C3Ae7', '0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31', 'https://bloxberg.ethernity.cloud', 8995],
  // --- polygon mainnet ---
  'ecld-pynithy': ['0x439945BE73fD86fcC172179021991E96Beff3Cc4', '0x689f3806874d3c8A973f419a4eB24e6fBA7E830F', 'https://polygon-bor-rpc.publicnode.com', 137],
  'ecld-nodenithy': ['0x439945BE73fD86fcC172179021991E96Beff3Cc4', '0x689f3806874d3c8A973f419a4eB24e6fBA7E830F', 'https://polygon-bor-rpc.publicnode.com', 137],
  // --- polygon amoy testnet (replaces deprecated mumbai) ---
  'ecld-pynithy-amoy': ['0x1579b37C5a69ae02dDd23263A2b1318DE66a27C3', '0xeFA33c3976f31961285Ae4f5D10188616C912728', 'https://rpc-amoy.polygon.technology', 80002],
  'ecld-nodenithy-amoy': ['0x1579b37C5a69ae02dDd23263A2b1318DE66a27C3', '0xeFA33c3976f31961285Ae4f5D10188616C912728', 'https://rpc-amoy.polygon.technology', 80002],
  // --- iotex testnet ---
  'ecld-pynithy-iotex-testnet': ['0xD56385A97413Ed80E28B1b54A193b98F2C49c975', '0xa7467A6391816be9367a1cC52E0ef0c15FfE3cCC', 'https://babel-api.testnet.iotex.io', 4690],
  'ecld-nodenithy-iotex-testnet': ['0xD56385A97413Ed80E28B1b54A193b98F2C49c975', '0xa7467A6391816be9367a1cC52E0ef0c15FfE3cCC', 'https://babel-api.testnet.iotex.io', 4690],
  // --- ethereum sepolia ---
  'ecld-pynithy-ethereum-sepolia': ['0x29D3eC870565B6A1510232bd950A8Bc8336f0EB2', '0x55e0ad455Be85162b71a790f00Fc305680E3CE53', 'https://ethereum-sepolia-rpc.publicnode.com', 11155111],
  'ecld-nodenithy-ethereum-sepolia': ['0x29D3eC870565B6A1510232bd950A8Bc8336f0EB2', '0x55e0ad455Be85162b71a790f00Fc305680E3CE53', 'https://ethereum-sepolia-rpc.publicnode.com', 11155111],
  // --- litvm liteforge testnet (shares sepolia contracts; distinct chain/RPC) ---
  'ecld-pynithy-litvm-testnet': ['0x29D3eC870565B6A1510232bd950A8Bc8336f0EB2', '0x55e0ad455Be85162b71a790f00Fc305680E3CE53', 'https://liteforge.rpc.caldera.xyz/infra-partner-http', 4441],
  'ecld-nodenithy-litvm-testnet': ['0x29D3eC870565B6A1510232bd950A8Bc8336f0EB2', '0x55e0ad455Be85162b71a790f00Fc305680E3CE53', 'https://liteforge.rpc.caldera.xyz/infra-partner-http', 4441],
  // --- the -unsafe networks: the contracts of the network each is named after ---
  'etny-pynithy-testnet-unsafe': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c', '0x99A84C624C028bdf0a855A1E9E3f2fcf7275B3D8', 'https://bloxberg.ethernity.cloud', 8995],
  'etny-nodenithy-testnet-unsafe': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c', '0x99A84C624C028bdf0a855A1E9E3f2fcf7275B3D8', 'https://bloxberg.ethernity.cloud', 8995],
  'ecld-pynithy-litvm-testnet-unsafe': ['0x29D3eC870565B6A1510232bd950A8Bc8336f0EB2', '0x55e0ad455Be85162b71a790f00Fc305680E3CE53', 'https://liteforge.rpc.caldera.xyz/infra-partner-http', 4441],
  'ecld-nodenithy-litvm-testnet-unsafe': ['0x29D3eC870565B6A1510232bd950A8Bc8336f0EB2', '0x55e0ad455Be85162b71a790f00Fc305680E3CE53', 'https://liteforge.rpc.caldera.xyz/infra-partner-http', 4441]
};

// ethernity-cas ValidatorRegistry per template, baked into the enclave so it
// can verify the CAS that provisions it (ECAS_CAS_QUOTE self-attestation).
// Build-side on purpose: a rogue CAS must not choose the registry that judges
// it. Missing key = no registry on that network; the enclave skips the check.
// Shared with publish (cas/config.js), which registers the session in the
// matching SessionRegistry.
const require = createRequire(import.meta.url);
const casConfig = require('../cas/config.js');
export const VALIDATOR_REGISTRY = casConfig.VALIDATOR_REGISTRY;

// An -unsafe network runs an -unsafe trustedzone and nothing else, and an
// -unsafe trustedzone runs on no other network: the runner and the node refuse
// either mismatch, so the build does too.
const unsafe = casConfig.isUnsafeNetwork(process.env.BLOCKCHAIN_NETWORK);
if (unsafe !== String(process.env.TRUSTED_ZONE_IMAGE || '').endsWith('-unsafe')) {
  console.error(`ERROR: TRUSTED_ZONE_IMAGE=${process.env.TRUSTED_ZONE_IMAGE} does not run on BLOCKCHAIN_NETWORK=${process.env.BLOCKCHAIN_NETWORK}.`);
  console.error(unsafe
    ? '       An -unsafe network runs only a trustedzone whose name ends in -unsafe.'
    : '       A trustedzone whose name ends in -unsafe runs only on an -unsafe network.');
  console.error('       Run ecld-init to choose the network again.');
  process.exit(1);
}

// The securelock pipeline (build/securelock: Dockerfile.base.tpl, Dockerfile.tpl,
// scripts/, src/) is ethernity-cloud-sdk-py's, kept identical to it, and so are
// the images it builds on: a static SCONE python 3.14 the code is frozen for,
// and the SCONE 6.0.7 LAS that runs beside it.
const SDK_REGISTRY = 'registry.ethernity.cloud:443/debuggingdelight/ethernity-cloud-sdk-registry';
const BASE_IMAGE_REPO = `${SDK_REGISTRY}/sconecuratedimages/apps`;
const BASE_IMAGE_TAG = 'python-3.14.6-alpine3.24-scone6.0.7';
const LAS_IMAGE = `${SDK_REGISTRY}/sconecuratedimages/las:scone6.0.7`;

const runCommand = (command, canPass = false) => {
  if (shell.exec(command).code !== 0 && !canPass) {
    console.error(`Error executing command: ${command}`);
    process.exit(1);
  }
};

// Removes the containers this build and publish create, matched by exact name:
// `--filter name=` matches a substring, so name=las would also match the LAS of
// a CAS validator set on the same host.
const removeContainer = (name) => {
  const ids = shell.exec(`docker ps -a -q --filter "name=^/${name}$"`, { silent: true }).stdout.trim();
  if (ids) {
    runCommand(`docker rm -f ${ids.split('\n').join(' ')}`);
  }
};

const currentDir = process.cwd();
const buildDir = path.join(currentDir, 'node_modules/@ethernity-cloud/sdk-js/pynithy/build');
const srcDir = './src/serverless';
const destDir = path.join(buildDir, 'securelock/src/serverless');

// Fail the build NOW if the backend is missing: an enclave built without one
// runs every task into "name 'X' is not defined" on-chain.
if (!fs.existsSync(path.join(srcDir, 'backend.py'))) {
  console.error(`ERROR: ${path.join(srcDir, 'backend.py')} not found.`);
  console.error('       The securelock enclave loads your functions from src/serverless/backend.py.');
  console.error('       Run ecld-init to scaffold it, or create the file before building.');
  process.exit(1);
}

shell.rm('-rf', './registry');
['registry', 'las', 'etny-securelock', 'etny-trustedzone', 'etny-swift-stream'].forEach(removeContainer);
const dockerImg = shell.exec('docker images --filter reference="*etny*" -q', { silent: true }).stdout.trim();
if (dockerImg) {
  runCommand(`docker rmi ${dockerImg.split('\n').join(' ')} -f`);
}
const dockerImgReg = shell.exec('docker images --filter reference="*registry*" -q', { silent: true }).stdout.trim();
if (dockerImgReg) {
  runCommand(`docker rmi ${dockerImgReg.split('\n').join(' ')} -f`);
}

console.log(`Copying ${srcDir} to ${destDir}`);
fs.rmSync(destDir, { recursive: true, force: true });
fs.cpSync(srcDir, destDir, { recursive: true });
// The securelock Dockerfile pip-installs src/serverless/requirements.txt; a
// project without one installs nothing extra.
if (!fs.existsSync(path.join(destDir, 'requirements.txt'))) {
  fs.writeFileSync(path.join(destDir, 'requirements.txt'), '');
}

process.chdir(buildDir);

let templateName = process.env.TRUSTED_ZONE_IMAGE || 'etny-pynithy-testnet';

const isMainnet = casConfig.isMainnetNetwork(process.env.BLOCKCHAIN_NETWORK);
// Mainnet, or a testnet with a SessionRegistry: the securelock takes its
// certificate from a CAS session. Any other testnet's securelock self-signs
// from MR_ENCLAVE.
const casProvisioned = casConfig.casProvisioned(templateName, isMainnet);

// Enclave heap (SCONE_HEAP). Part of the measurement: publish runs the
// securelock with the value recorded here.
const MEMORY_TO_ALLOCATE = (process.env.ECLD_MEMORY_TO_ALLOCATE || process.env.MEMORY_TO_ALLOCATE || '1024M').trim();
writeEnv('MEMORY_TO_ALLOCATE', MEMORY_TO_ALLOCATE);

runCommand('docker pull registry:2');
runCommand('docker run -d --restart=always -p 5000:5000 --name registry registry:2');

const ENCLAVE_NAME_SECURELOCK = `${process.env.PROJECT_NAME}-SECURELOCK-V3-${casConfig.sessionTag(process.env.BLOCKCHAIN_NETWORK)}-${VERSION}`.replace(/\//g, '_').replace(/-/g, '_');
console.log(`ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);
writeEnv('ENCLAVE_NAME_SECURELOCK', ENCLAVE_NAME_SECURELOCK);

process.chdir('securelock');

console.log('Building etny-securelock-base');
fs.writeFileSync('Dockerfile.base', fs.readFileSync('Dockerfile.base.tpl', 'utf8')
  .replace(/__DOCKER_REPO_URL__/g, BASE_IMAGE_REPO)
  .replace(/__BASE_IMAGE_TAG__/g, BASE_IMAGE_TAG));
runCommand('docker build -f Dockerfile.base -t etny-securelock-base:latest .');

// src/serverless/Dockerfile.serverless builds on etny-securelock-base and adds
// what the dApp needs at the system level.
if (fs.existsSync('src/serverless/Dockerfile.serverless')) {
  console.log('Adding customizations from Dockerfile.serverless');
  runCommand('docker build -f src/serverless/Dockerfile.serverless -t etny-securelock-serverless:latest .');
} else {
  runCommand('docker tag etny-securelock-base:latest etny-securelock-serverless:latest');
}

// ESR fail-fast gate (RFC §5.4): never build an ESR-enabled enclave with an
// unresolved registry address. The enclave is SEALED -- a missing value bakes
// in as empty, and every task then fails at runtime after gas is spent.
const ESR_ENABLED = /^(1|true|yes)$/i.test(String(process.env.ESR_ENABLED || '').trim());
const ESR_CONTRACT_ADDRESS = String(process.env.ESR_CONTRACT_ADDRESS || '').trim();
const ESR_WALLET_ADDRESS = String(process.env.ESR_WALLET_ADDRESS || '').trim();
if (ESR_ENABLED && !/^0x[0-9a-fA-F]{40}$/.test(ESR_CONTRACT_ADDRESS)) {
  console.error('ERROR: ESR is enabled but ESR_CONTRACT_ADDRESS is not a valid address'
    + ` (got ${JSON.stringify(ESR_CONTRACT_ADDRESS)}).`);
  console.error('       Set it with ecld-init (ESR step) or ESR_CONTRACT_ADDRESS in .env.');
  process.exit(1);
}
// Rendered only when enabled, so non-ESR images keep byte-identical layers.
let esrEnvBlock = '';
if (ESR_ENABLED) {
  esrEnvBlock = `ENV ESR_CONTRACT_ADDRESS=${ESR_CONTRACT_ADDRESS}\n`;
  if (/^0x[0-9a-fA-F]{40}$/.test(ESR_WALLET_ADDRESS)) {
    esrEnvBlock += `ENV ESR_WALLET_ADDRESS=${ESR_WALLET_ADDRESS}\n`;
  }
}

// Signs the EXECUTED binary (/usr/local/bin/python, the ENTRYPOINT and the
// compose command) with the enclave-creation params the runtime env repeats;
// scone-signer embeds SCONE defaults for anything not passed, and any drift
// makes SCONE recompute the measurement at load. A CAS-provisioned securelock
// is signed --production: the CAS session admits production enclaves only. A
// self-signing testnet securelock is signed debug.
const signFlags =
  `--key=/enclave-key.pem --env --heap=${MEMORY_TO_ALLOCATE} ` +
  `--stack=4M --dlopen=1 --extensions=/lib/libbinary-fs.so`;

console.log('Building etny-securelock');
fs.writeFileSync('Dockerfile', fs.readFileSync('Dockerfile.tpl', 'utf8')
  .replace(/__SECURELOCK_SESSION__/g, ENCLAVE_NAME_SECURELOCK)
  .replace(/__BUCKET_NAME__/g, `${templateName}-v3`)
  .replace(/__SMART_CONTRACT_ADDRESS__/g, ECRunner[templateName][0])
  .replace(/__IMAGE_REGISTRY_ADDRESS__/g, ECRunner[templateName][1])
  .replace(/__RPC_URL__/g, ECRunner[templateName][2])
  .replace(/__CHAIN_ID__/g, ECRunner[templateName][3])
  .replace(/__TRUSTED_ZONE_IMAGE__/g, templateName)
  .replace(/__NETWORK_TYPE__/g, isMainnet ? 'mainnet' : 'testnet')
  .replace(/__VALIDATOR_REGISTRY_ADDRESS__/g, VALIDATOR_REGISTRY[templateName] || '')
  .replace(/__MEMORY_TO_ALLOCATE__/g, MEMORY_TO_ALLOCATE)
  .replace(/__ESR_ENV__\n/, esrEnvBlock)
  .replace('__SCONE_ALLOW_DLOPEN__', 'ENV SCONE_ALLOW_DLOPEN=1')
  .replace('__SCONE_SIGN__',
    `RUN scone-signer sign ${signFlags}${casProvisioned ? ' --production' : ''} /usr/local/bin/python`));

runCommand(`docker build --build-arg SECURELOCK_SESSION=${ENCLAVE_NAME_SECURELOCK} -t etny-securelock:latest .`);
runCommand('docker tag etny-securelock localhost:5000/etny-securelock');
runCommand('docker push localhost:5000/etny-securelock');
process.chdir('..');

writeEnv('ENCLAVE_NAME_TRUSTEDZONE', templateName);

// The trustedzone is not built here: the etny-pynithy CI builds, measures and
// registers it on-chain, and publishes that exact image to the ethernity registry
// under <image_name>/trustedzone:<network>, with image_name and network the keys
// of etny-pynithy/v3/networks.yaml (image_name is TRUSTED_ZONE_IMAGE). Bundling
// anything else would pair the securelock with a trustedzone whose key does not
// match the on-chain cert, so a failed pull fails the build.
const trustedZoneNetByBlockchain = {
  Bloxberg_Mainnet: 'bloxberg',
  Bloxberg_Testnet: 'bloxberg_testnet',
  Polygon_Mainnet: 'polygon',
  Polygon_Amoy_Testnet: 'amoy',
  IoTeX_Testnet: 'iotex_testnet',
  Ethereum_Sepolia: 'ethereum_sepolia',
  LitVM_LiteForge: 'litvm_liteforge',
  Bloxberg_Testnet_Unsafe: 'bloxberg_testnet_unsafe',
  LitVM_LiteForge_Unsafe: 'litvm_liteforge_unsafe',
};
const trustedZoneNet = trustedZoneNetByBlockchain[process.env.BLOCKCHAIN_NETWORK];
if (!trustedZoneNet) {
  console.error(`ERROR: no published trustedzone for BLOCKCHAIN_NETWORK=${process.env.BLOCKCHAIN_NETWORK}`);
  console.error(`       known networks: ${Object.keys(trustedZoneNetByBlockchain).join(', ')}`);
  process.exit(1);
}
const trustedZoneImage = `${SDK_REGISTRY}/${templateName}/trustedzone:${trustedZoneNet}`;
console.log(`Pulling the published trustedzone: ${trustedZoneImage}`);
runCommand(`docker pull ${trustedZoneImage}`);
runCommand(`docker tag ${trustedZoneImage} localhost:5000/etny-trustedzone`);
runCommand('docker push localhost:5000/etny-trustedzone');

// Every network but an -unsafe one runs a LAS beside the enclaves; an -unsafe
// network's compose carries none, and its bundle none either.
if (!unsafe) {
  console.log('Pulling etny-las');
  runCommand(`docker pull ${LAS_IMAGE}`);
  runCommand(`docker tag ${LAS_IMAGE} localhost:5000/etny-las`);
  runCommand('docker push localhost:5000/etny-las');
}

process.chdir(currentDir);
runCommand('docker cp registry:/var/lib/registry registry');

console.log('Cleaning up');
fs.rmSync(destDir, { recursive: true, force: true });
