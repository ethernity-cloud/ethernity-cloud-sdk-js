// The securelock's Dockerfile, rendered from build/securelock/Dockerfile.tmpl.
// build.mjs writes the Dockerfile it builds with renderSecurelockDockerfile.
//
// The enclave-creation parameters (--heap/--stack/--dlopen/--extensions) are
// passed to scone-signer explicitly and match the runtime environment
// (scone-signer embeds SCONE's defaults for anything not passed as a flag, and
// a drift makes SCONE recompute MRENCLAVE and re-sign the enclave as debug at
// load). The signed binary is /usr/local/bin/node, the one the ENTRYPOINT
// runs.

const signFlags = (heap) =>
  `--key=/enclave-key.pem --env --heap=${heap} ` +
  '--stack=4M --tcs=64 --dlopen=1 --extensions=/lib/libbinary-fs.so';

// scone-signer prints two tab-indented "MRENCLAVE:" lines (without EDMM first,
// the value SCONE_HASH prints with EDMM disabled). The output goes to a file
// first: piping it into head or grep kills scone-signer with SIGPIPE (exit
// 141) under buildkit's pipefail shell.
const SIGNED_MRENCLAVE_STEP =
  'RUN scone-signer info /usr/local/bin/node > /tmp/siginfo.txt 2>&1; \\\n' +
  '    grep -iE "MRENCLAVE:" /tmp/siginfo.txt | sed -n \'1p\' \\\n' +
  '      | sed -E \'s/.*MRENCLAVE:[[:space:]]*//I\' | tr -d \'[:space:]\' > /signed_mrenclave.txt && \\\n' +
  '    echo "SIGNED_MRENCLAVE=$(cat /signed_mrenclave.txt)"';

// FIXED_START_JITLESS of build/securelock/fixed-start/securelock.h: 1 when the
// securelock runs node --jitless, so that the fixed start's vector is the
// ENTRYPOINT's.
const fixedStartJitless = (nodeFlags) => (nodeFlags.includes('--jitless') ? '1' : '0');

// The enclave's name is the securelock's CAS session name. The link line
// gives it to the launcher as a C string literal inside a shell word
// (FIXED_START_SESSION), and it names the directories the session places its
// files in: letters, digits, dots, dashes and underscores alone.
const ENCLAVE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * @param {string} template the text of build/securelock/Dockerfile.tmpl
 * @param {object} v the build's values: enclaveName, networkType ("mainnet" or
 *   "testnet"), bucket, smartContractAddress, imageRegistryAddress, rpcUrl,
 *   chainId, validatorRegistryAddress ("" for none), esrEnvBlock (the ENV line
 *   of the ESR registry, "" without ESR), memory (SCONE_HEAP), nodeFlags (the
 *   node flags, nodeFlags.js) and production (sign --production)
 * @returns {string} the Dockerfile
 * @throws when enclaveName holds a character other than letters, digits,
 *   dots, dashes and underscores
 */
function renderSecurelockDockerfile(template, v) {
  if (!ENCLAVE_NAME.test(String(v.enclaveName))) {
    throw new Error(`the enclave name ${JSON.stringify(v.enclaveName)} is not letters, digits, dots, dashes and underscores alone`);
  }
  return template
    .replace(/__ENCLAVE_NAME_SECURELOCK__/g, v.enclaveName)
    .replace(/__NETWORK_TYPE__/g, v.networkType)
    .replace(/__BUCKET_NAME__/g, v.bucket)
    .replace(/__SMART_CONTRACT_ADDRESS__/g, v.smartContractAddress)
    .replace(/__IMAGE_REGISTRY_ADDRESS__/g, v.imageRegistryAddress)
    .replace(/__RPC_URL__/g, v.rpcUrl)
    .replace(/__CHAIN_ID__/g, String(v.chainId))
    .replace(/__ETNY_VALIDATOR_REGISTRY_ADDRESS__/g, v.validatorRegistryAddress || '')
    .replace(/^__ESR_ENV__\r?\n/m, v.esrEnvBlock ? `${v.esrEnvBlock}\n` : '')
    .replace(/__MEMORY_TO_ALLOCATE__/g, v.memory)
    .replace(/__NODE_FLAGS__/g, v.nodeFlags.map((flag) => `, "${flag}"`).join(''))
    .replace(/__FIXED_START_JITLESS__/g, fixedStartJitless(v.nodeFlags))
    .replace('__SCONE_SIGN__', `RUN scone-signer sign ${signFlags(v.memory)}${v.production ? ' --production' : ''} /usr/local/bin/node`)
    .replace('__SIGNED_MRENCLAVE__', SIGNED_MRENCLAVE_STEP);
}

module.exports = { renderSecurelockDockerfile, fixedStartJitless, signFlags };
