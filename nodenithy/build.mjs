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
  // --- bloxberg (the testnet reads ECImageRegistryV3, mainnet the original) ---
  'etny-pynithy-testnet': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c', '0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1', 'https://bloxberg.ethernity.cloud', 8995],
  'etny-nodenithy-testnet': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c', '0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1', 'https://bloxberg.ethernity.cloud', 8995],
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
  'etny-pynithy-testnet-unsafe': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c', '0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1', 'https://bloxberg.ethernity.cloud', 8995],
  'etny-nodenithy-testnet-unsafe': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c', '0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1', 'https://bloxberg.ethernity.cloud', 8995],
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

const runCommand = (command, canPass = false) => {
  if (shell.exec(command).code !== 0 && !canPass) {
    console.error(`Error executing command: ${command}`);
    process.exit(1);
  }
};

// Removes the containers this build and publish create, matched by exact name:
// `--filter name=` matches a substring, so name=las would also match the LAS of
// a CAS validator set on the same host. `-v` removes their anonymous volumes
// too: registry:2 keeps its pushed images in one, about 1.3 GB per build.
const removeContainer = (name) => {
  const ids = shell.exec(`docker ps -a -q --filter "name=^/${name}$"`, { silent: true }).stdout.trim();
  if (ids) {
    runCommand(`docker rm -f -v ${ids.split('\n').join(' ')}`);
  }
};

// Downloading dependencies
shell.rm('-rf', './registry');
const currentDir = process.cwd();
const buildDir = path.join(currentDir, 'node_modules/@ethernity-cloud/sdk-js/nodenithy/build');

['registry', 'las', 'etny-securelock', 'etny-trustedzone', 'etny-swift-stream'].forEach(removeContainer);
const dockerImg = shell.exec('docker images --filter reference="*etny*" -q', { silent: true }).stdout.trim();
if (dockerImg) {
  runCommand(`docker rmi ${dockerImg.split('\n').join(' ')} -f`);
}
const dockerImgReg = shell.exec('docker images --filter reference="*registry*" -q', { silent: true }).stdout.trim();
if (dockerImgReg) {
  runCommand(`docker rmi ${dockerImgReg.split('\n').join(' ')} -f`);
}



const srcDir = './src/serverless';
const destDir = path.join(buildDir, 'securelock/src/serverless');

// Fail the build NOW if the backend is missing or unloadable. An enclave
// built without a valid backend runs every task into "X is not defined" /
// IMPORT_ERROR on-chain — expensive to discover after building, publishing
// and paying for a task.
const backendFile = path.join(srcDir, 'backend.js');
if (!fs.existsSync(backendFile)) {
  console.error(`ERROR: ${backendFile} not found.`);
  console.error('       The securelock enclave loads your functions from src/serverless/backend.js;');
  console.error('       without it no backend function will exist inside the enclave.');
  console.error('       Run ecld-init to scaffold it, or create the file before building.');
  process.exit(1);
}
try {
  const { createRequire } = await import('module');
  createRequire(import.meta.url)(path.resolve(backendFile));
} catch (e) {
  console.error('ERROR: src/serverless/backend.js failed to load and would fail inside the enclave:');
  console.error(`       ${e.name || 'Error'}: ${e.message}`);
  console.error('       Fix the module (missing dependency? bad require?) before building.');
  process.exit(1);
}

// Safety lint: flag dynamic code execution -- especially of task input --
// before the image is sealed. A hard error only for the case that actually
// opens the enclave to a submitter (eval / Function of ___etny_data_set___);
// everything else is a warning. See payloadLint.mjs for scope + opt-out.
try {
  const { analyze } = await import('../payloadLint.mjs');
  const src = fs.readFileSync(backendFile, 'utf8');
  const { findings, optedOut } = analyze(src, 'src/serverless/backend.js');
  if (!optedOut) {
    const warnings = findings.filter((f) => f.severity === 'warning');
    const errors = findings.filter((f) => f.severity === 'error');
    for (const f of warnings) {
      console.warn(`WARNING: src/serverless/backend.js:${f.line}: ${f.message}`);
    }
    if (errors.length) {
      console.error('');
      console.error('ERROR: unsafe dynamic execution of task input in src/serverless/backend.js:');
      for (const f of errors) console.error(`       line ${f.line}: ${f.message}`);
      console.error('');
      console.error('       This would let a task submitter run arbitrary code inside your enclave');
      console.error('       and reach other users\' state. Fix it, or if the input is genuinely');
      console.error('       trusted, add `// ecld: allow-eval` on that line to acknowledge the risk.');
      process.exit(1);
    }
  }
} catch (e) {
  // The lint is best-effort; never block a build on the linter itself failing.
  console.warn(`WARNING: payload safety lint skipped (${e && e.message ? e.message : e})`);
}

console.log(`Creating destination directory: ${destDir}`);
fs.mkdirSync(destDir, { recursive: true });

console.log(`Copying files from ${srcDir} to ${destDir}`);
fs.readdirSync(srcDir).forEach(file => {
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
});

process.chdir(buildDir);

let templateName = process.env.TRUSTED_ZONE_IMAGE || 'etny-nodenithy-testnet';

const isMainnet = casConfig.isMainnetNetwork(process.env.BLOCKCHAIN_NETWORK);

const ENCLAVE_NAME_TRUSTEDZONE = templateName;

runCommand('docker pull registry:2');
runCommand('docker run -d --restart=always -p 5000:5000 --name registry registry:2');
// runCommand(`docker login ${process.env.DOCKER_REPO_URL} -u ${process.env.DOCKER_LOGIN} -p ${process.env.DOCKER_PASSWORD}`);

// const CI_COMMIT_BRANCH = process.env.PROJECT_NAME;
// aleXPRoj-securelock-v3-testnet-0.1.0...
const ENCLAVE_NAME_SECURELOCK = `${process.env.PROJECT_NAME}-SECURELOCK-V3-${casConfig.sessionTag(process.env.BLOCKCHAIN_NETWORK)}-${VERSION}`.replace(/\//g, '_').replace(/-/g, '_');
console.log(`ENCLAVE_NAME_SECURELOCK: ${ENCLAVE_NAME_SECURELOCK}`);
writeEnv('ENCLAVE_NAME_SECURELOCK', ENCLAVE_NAME_SECURELOCK);

// The trustedzone is not built here: the etny-nodenithy CI builds, measures and
// registers it on-chain, and publishes that exact image to the ethernity registry
// under <image_name>/trustedzone:<network>, with image_name and network the keys
// of etny-nodenithy/v3/networks.yaml (image_name is TRUSTED_ZONE_IMAGE). Bundling
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
const trustedZoneImage = `registry.ethernity.cloud:443/debuggingdelight/ethernity-cloud-sdk-registry/${templateName}/trustedzone:${trustedZoneNet}`;
console.log(`Pulling the published trustedzone: ${trustedZoneImage}`);
runCommand(`docker pull ${trustedZoneImage}`);

console.log('Building etny-securelock');
process.chdir('securelock');

// The SGX key-gen module ships as a PREBUILT sgx_report.node (never the .c
// source). It is a build artifact of the etny-nodenithy pipeline; the
// securelock Dockerfile bakes it into binary-fs but does not compile it. Fail
// fast with a clear message if it is missing, rather than producing an enclave
// that crashes on the missing addon at runtime.
if (!fs.existsSync('src/sgx_report.node')) {
  console.error('ERROR: securelock/src/sgx_report.node not found.');
  console.error('       The SDK ships the SGX key-gen module as a prebuilt .node, not source.');
  console.error('       It is a build artifact of the etny-nodenithy pipeline; copy it into');
  console.error('       securelock/src/ (see src/README-keygen.md) before building.');
  process.exit(1);
}
// ESR fail-fast gate (RFC §5.4), mirroring the Python SDK's validate_esr_config:
// never build an ESR-enabled enclave with an unresolved registry address. The
// enclave is SEALED -- a missing value bakes in as empty, and every task then
// fails at runtime after gas is already spent. ESR is opt-in: absent/false
// ESR_ENABLED means the build behaves exactly as it did before ESR existed.
const ESR_ENABLED = /^(1|true|yes)$/i.test(String(process.env.ESR_ENABLED || '').trim());
const ESR_CONTRACT_ADDRESS = String(process.env.ESR_CONTRACT_ADDRESS || '').trim();
if (ESR_ENABLED && !/^0x[0-9a-fA-F]{40}$/.test(ESR_CONTRACT_ADDRESS)) {
  console.error('ERROR: ESR is enabled but ESR_CONTRACT_ADDRESS is not a valid address'
    + ` (got ${JSON.stringify(ESR_CONTRACT_ADDRESS)}).`);
  console.error('       The enclave is sealed: a missing value bakes in as EMPTY and every');
  console.error('       task fails at runtime after gas is spent. Set it with:');
  console.error('         ecld-init (ESR step) or ESR_CONTRACT_ADDRESS in .env');
  process.exit(1);
}
// Rendered only when enabled, so non-ESR images keep byte-identical layers.
const esrEnvBlock = ESR_ENABLED ? `ENV ESR_CONTRACT_ADDRESS=${ESR_CONTRACT_ADDRESS}` : '';

// runCommand(`cat Dockerfile.tmpl | sed s/"__ENCLAVE_NAME_SECURELOCK__"/"${ENCLAVE_NAME_SECURELOCK}"/g > Dockerfile`);
const dockerfileSecureTemplate = fs.readFileSync('Dockerfile.tmpl', 'utf8');
let dockerfileSecureContent = dockerfileSecureTemplate.replace(/__ENCLAVE_NAME_SECURELOCK__/g, ENCLAVE_NAME_SECURELOCK).replace(/__NETWORK_TYPE__/g, isMainnet ? 'mainnet' : 'testnet').replace(/__BUCKET_NAME__/g, templateName + "-v3").replace(/__SMART_CONTRACT_ADDRESS__/g, ECRunner[templateName][0]).replace(/__IMAGE_REGISTRY_ADDRESS__/g, ECRunner[templateName][1]).replace(/__RPC_URL__/g, ECRunner[templateName][2]).replace(/__CHAIN_ID__/g, ECRunner[templateName][3]).replace(/__ETNY_VALIDATOR_REGISTRY_ADDRESS__/g, VALIDATOR_REGISTRY[templateName] || '').replace(/^__ESR_ENV__\n/m, esrEnvBlock ? `${esrEnvBlock}\n` : '');

// Amount of enclave heap to allocate (SCONE_HEAP). Kept in sync with the
// run/docker-compose securelock service; overridable via ECLD_MEMORY_TO_ALLOCATE.
const MEMORY_TO_ALLOCATE = (process.env.ECLD_MEMORY_TO_ALLOCATE || '1024M').trim();

// CRITICAL (mainnet DCAP): sign /usr/local/bin/node -- the binary the enclave
// actually EXECUTES (ENTRYPOINT + the run/publish compose command both run
// /usr/local/bin/node). Signing anything else leaves the executed binary as the
// base image's DEBUG-signed one, so at load SCONE recomputes MRENCLAVE and
// re-signs it as debug -> CAS rejects the DCAP quote ("Debug mode enabled").
//
// The enclave-creation params (--heap/--stack/--dlopen/--extensions) MUST be
// passed explicitly and match the runtime env exactly (scone-signer embeds SCONE
// defaults for anything not passed as a flag) -- any drift triggers the same
// debug re-sign. Values mirror the run/docker-compose securelock service.
const signFlags =
  `--key=/enclave-key.pem --env --heap=${MEMORY_TO_ALLOCATE} ` +
  `--stack=4M --dlopen=1 --extensions=/lib/libbinary-fs.so`;

// scone-signer prints two tab-indented "MRENCLAVE:" lines (non-EDMM first;
// runtime has EDMM disabled, so the first is what SCONE_HASH produces). Capture
// to a file first -- piping into head/grep kills scone-signer with SIGPIPE
// (exit 141) under buildkit's pipefail shell.
const signedMrenclaveStep =
  'RUN scone-signer info /usr/local/bin/node > /tmp/siginfo.txt 2>&1; \\\n' +
  '    grep -iE "MRENCLAVE:" /tmp/siginfo.txt | sed -n \'1p\' \\\n' +
  '      | sed -E \'s/.*MRENCLAVE:[[:space:]]*//I\' | tr -d \'[:space:]\' > /signed_mrenclave.txt && \\\n' +
  '    echo "SIGNED_MRENCLAVE=$(cat /signed_mrenclave.txt)"';

// A CAS-provisioned securelock (mainnet, or a testnet with a SessionRegistry)
// is signed --production: the CAS session admits production enclaves only,
// and a debug-signed one is refused at attestation. A self-signing testnet
// securelock is signed debug with the same explicit params.
const cas = casConfig.casProvisioned(templateName, isMainnet);
dockerfileSecureContent = dockerfileSecureContent
  .replace('__SCONE_SIGN__', `RUN scone-signer sign ${signFlags}${cas ? ' --production' : ''} /usr/local/bin/node`)
  .replace('__SIGNED_MRENCLAVE__', signedMrenclaveStep);

fs.writeFileSync('Dockerfile', dockerfileSecureContent);




// The trustedzone image is also the securelock's SCONE node (Dockerfile.tmpl,
// SCONE_NODE).
runCommand(`docker build --build-arg SCONE_NODE=${trustedZoneImage} --build-arg ENCLAVE_NAME_SECURELOCK=${ENCLAVE_NAME_SECURELOCK} -t etny-securelock:latest .`);
runCommand('docker tag etny-securelock localhost:5000/etny-securelock');
runCommand('docker push localhost:5000/etny-securelock');
process.chdir('..');

console.log(`ENCLAVE_NAME_TRUSTEDZONE: ${ENCLAVE_NAME_TRUSTEDZONE}`);
writeEnv('ENCLAVE_NAME_TRUSTEDZONE', ENCLAVE_NAME_TRUSTEDZONE);

runCommand(`docker tag ${trustedZoneImage} localhost:5000/etny-trustedzone`);
runCommand('docker push localhost:5000/etny-trustedzone');


// Every network but an -unsafe one runs a LAS beside the enclaves: the SCONE
// 6.0.7 LAS the trustedzones are built and attested with (etny-nodenithy
// v3/build/las). An -unsafe network's compose carries none, and its bundle
// none either.
if (!unsafe) {
  const lasImage = 'registry.ethernity.cloud:443/debuggingdelight/ethernity-cloud-sdk-registry/sconecuratedimages/las:scone6.0.7';
  console.log('Pulling etny-las');
  runCommand(`docker pull ${lasImage}`);
  runCommand(`docker tag ${lasImage} localhost:5000/etny-las`);
  runCommand('docker push localhost:5000/etny-las');
}


process.chdir(currentDir);
runCommand('docker cp registry:/var/lib/registry registry');

console.log('Cleaning up');
fs.rmSync(destDir, { recursive: true, force: true });
