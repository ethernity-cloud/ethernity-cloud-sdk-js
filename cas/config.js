// ethernity-cas deployments, keyed by trustedzone template name (the value of
// TRUSTED_ZONE_IMAGE), for the networks whose enclaves are attested by the
// ethernity-cas validator set.
//
// A testnet template listed in SESSION_REGISTRY is CAS-attested: ecld-publish
// registers the securelock session there (body pinned to IPFS as
// CIDv1/raw/sha2-256) instead of posting it to a CAS, provisions the enclave
// from a validator resolved out of VALIDATOR_REGISTRY, and the securelock
// takes its certificate from the CAS session and verifies the CAS against the
// registry baked into it. A testnet template NOT listed here has no CAS: its
// securelock self-signs from MR_ENCLAVE. Mainnet templates are provisioned by
// the Scontain CAS and are not listed.
//
// Kept in sync with etny-{pynithy,nodenithy}/v3/networks.yaml
// (cas_session_registry_address, validator_registry_address).
const VALIDATOR_REGISTRY = {
  'etny-pynithy-testnet': '0x0014aB102FEa6b02e3D793FF4b9a0Af309fB4E14',
  'etny-nodenithy-testnet': '0x0014aB102FEa6b02e3D793FF4b9a0Af309fB4E14',
  'ecld-pynithy-litvm-testnet': '0xbE3759f327e8643fC5A1717fb2072A0dAcBAD29E',
  'ecld-nodenithy-litvm-testnet': '0xbE3759f327e8643fC5A1717fb2072A0dAcBAD29E',
  'ecld-pynithy-ethereum-sepolia': '0x8ad24b3F406A41a0F8D3440021792EB203957F43',
  'ecld-nodenithy-ethereum-sepolia': '0x8ad24b3F406A41a0F8D3440021792EB203957F43',
};

const SESSION_REGISTRY = {
  'etny-pynithy-testnet': '0x444429681fCb26470Cb12B5436E48402cF7478A3',
  'etny-nodenithy-testnet': '0x444429681fCb26470Cb12B5436E48402cF7478A3',
  'ecld-pynithy-litvm-testnet': '0xfA70B5Df7C773A21164cAc5413704117e4dEaB76',
  'ecld-nodenithy-litvm-testnet': '0xfA70B5Df7C773A21164cAc5413704117e4dEaB76',
  // Bound to Sepolia's ECImageRegistryV3 of 2026-10-14.
  'ecld-pynithy-ethereum-sepolia': '0xDbB249E108d19fC1691483Bf897bA8BA0dA99c06',
  'ecld-nodenithy-ethereum-sepolia': '0xDbB249E108d19fC1691483Bf897bA8BA0dA99c06',
};

// The chain the registries above live on. Sepolia's RPC is Tenderly's gateway:
// publicnode caps eth_getLogs at 50,000 blocks and prunes older ranges.
const CHAIN = {
  'etny-pynithy-testnet': { rpcUrl: 'https://bloxberg.ethernity.cloud', chainId: 8995 },
  'etny-nodenithy-testnet': { rpcUrl: 'https://bloxberg.ethernity.cloud', chainId: 8995 },
  'ecld-pynithy-litvm-testnet': { rpcUrl: 'https://liteforge.rpc.caldera.xyz/infra-partner-http', chainId: 4441 },
  'ecld-nodenithy-litvm-testnet': { rpcUrl: 'https://liteforge.rpc.caldera.xyz/infra-partner-http', chainId: 4441 },
  'ecld-pynithy-ethereum-sepolia': { rpcUrl: 'https://sepolia.gateway.tenderly.co', chainId: 11155111 },
  'ecld-nodenithy-ethereum-sepolia': { rpcUrl: 'https://sepolia.gateway.tenderly.co', chainId: 11155111 },
};

// Whether the securelock takes its certificate from a CAS session: mainnet
// (Scontain CAS), or a testnet template with a SessionRegistry (ethernity-cas).
const casProvisioned = (templateName, isMainnet) => isMainnet || Boolean(SESSION_REGISTRY[templateName]);

// The mainnets, by BLOCKCHAIN_NETWORK. A template name does not tell: the Amoy
// templates (ecld-*-amoy) do not contain "testnet".
const MAINNETS = ['Bloxberg_Mainnet', 'Polygon_Mainnet'];
const isMainnetNetwork = (network) =>
  MAINNETS.some((name) => name.toUpperCase() === String(network || '').toUpperCase());

// The -unsafe networks, by BLOCKCHAIN_NETWORK, each with the network it is the
// unsafe variant of: the same chain and contracts, for SGX platforms the CAS
// cannot attest (EPID-only, SGX1). No CAS and no LAS: the securelock is
// debug-signed and self-signs from MR_ENCLAVE, is registered as
// <project>-unsafe, and runs only against an -unsafe trustedzone. Mainnet has
// none. Kept in sync with the *_unsafe entries of
// etny-{pynithy,nodenithy}/v3/networks.yaml.
const UNSAFE_NETWORKS = {
  Bloxberg_Testnet_Unsafe: 'Bloxberg_Testnet',
  LitVM_LiteForge_Unsafe: 'LitVM_LiteForge',
  Ethereum_Sepolia_Unsafe: 'Ethereum_Sepolia',
};

// Case-insensitive: ecld-init writes Bloxberg_Testnet_Unsafe, a --network
// flag may say BLOXBERG_TESTNET_UNSAFE.
const isUnsafeNetwork = (network) =>
  Object.keys(UNSAFE_NETWORKS).some((name) => name.toUpperCase() === String(network || '').toUpperCase());

// The testnets, by BLOCKCHAIN_NETWORK: every network ecld-init offers but the
// two mainnets, the -unsafe ones included. A session relaxes attestation on
// these alone (sessionAttestation).
const TESTNETS = [
  'Bloxberg_Testnet', 'Polygon_Amoy_Testnet', 'IoTeX_Testnet', 'Ethereum_Sepolia', 'LitVM_LiteForge',
  ...Object.keys(UNSAFE_NETWORKS),
];
const isTestnetNetwork = (network) =>
  TESTNETS.some((name) => name.toUpperCase() === String(network || '').toUpperCase());

// The attestation rules a securelock session declares on `network`, as the
// YAML flow sequences its template takes for __TOLERATE__ and
// __IGNORE_ADVISORIES__. A testnet tolerates a debug-signed enclave and ignores
// every Intel advisory. Any other network, a mainnet or a name not in TESTNETS,
// gets the production rules: no debug-mode, and INTEL-SA-00615 the one
// advisory ignored.
const sessionAttestation = (network) => (isTestnetNetwork(network)
  ? { tolerate: '[hyperthreading, outdated-tcb, software-hardening-needed, debug-mode]', ignoreAdvisories: '["*"]' }
  : { tolerate: '[hyperthreading, outdated-tcb, software-hardening-needed]', ignoreAdvisories: '["INTEL-SA-00615"]' });

// The name an image is registered and run under on `network`: <name>-unsafe
// on an -unsafe network. A dApp's securelock is <project>-unsafe there, so its
// two variants never share an image name, and an -unsafe network's
// trustedzone is the -unsafe variant of its sibling's.
const nameOnNetwork = (name, network) =>
  !name || !isUnsafeNetwork(network) || name.endsWith('-unsafe') ? name : `${name}-unsafe`;

// The network part of ENCLAVE_NAME_SECURELOCK: the second word of
// BLOCKCHAIN_NETWORK, with _unsafe on an -unsafe network so the two variants
// never share a session name.
const sessionTag = (network) =>
  `${network.split('_')[1].toLowerCase()}${isUnsafeNetwork(network) ? '_unsafe' : ''}`;

// A compose template rendered for its network. A line tagged `# __CAS_ONLY__`
// serves CAS attestation and is kept where a CAS provisions the enclaves, one
// tagged `# __NO_CAS_ONLY__` where they self-sign, and one tagged
// `# __SAFE_ONLY__` (the LAS) on every network but an -unsafe one. Kept lines
// lose their tag.
const renderCompose = (content, cas, unsafe) => content
  .split('\n')
  .filter((line) => !(/# __CAS_ONLY__$/.test(line) && !cas))
  .filter((line) => !(/# __NO_CAS_ONLY__$/.test(line) && cas))
  .filter((line) => !(/# __SAFE_ONLY__$/.test(line) && unsafe))
  .map((line) => line.replace(/\s*# __(?:CAS|NO_CAS|SAFE)_ONLY__$/, ''))
  .join('\n');

module.exports = {
  VALIDATOR_REGISTRY, SESSION_REGISTRY, CHAIN, casProvisioned, isMainnetNetwork,
  UNSAFE_NETWORKS, isUnsafeNetwork, TESTNETS, isTestnetNetwork, sessionAttestation,
  nameOnNetwork, sessionTag, renderCompose,
};
