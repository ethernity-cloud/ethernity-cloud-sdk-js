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
  'etny-pynithy-testnet': '0xa821b36F378F76c793c436F5f9c9CC36c684eBE5',
  'etny-nodenithy-testnet': '0xa821b36F378F76c793c436F5f9c9CC36c684eBE5',
  'ecld-pynithy-litvm-testnet': '0x2E27677fb67531eb09134fE331C27899f87ADe10',
  'ecld-nodenithy-litvm-testnet': '0x2E27677fb67531eb09134fE331C27899f87ADe10',
};

const SESSION_REGISTRY = {
  'etny-pynithy-testnet': '0xcb1F389bF4524d1D61EDcbC24eC1F1F9C3FF4Fa6',
  'etny-nodenithy-testnet': '0xcb1F389bF4524d1D61EDcbC24eC1F1F9C3FF4Fa6',
  'ecld-pynithy-litvm-testnet': '0x8ad24b3F406A41a0F8D3440021792EB203957F43',
  'ecld-nodenithy-litvm-testnet': '0x8ad24b3F406A41a0F8D3440021792EB203957F43',
};

// The chain the registries above live on.
const CHAIN = {
  'etny-pynithy-testnet': { rpcUrl: 'https://bloxberg.ethernity.cloud', chainId: 8995 },
  'etny-nodenithy-testnet': { rpcUrl: 'https://bloxberg.ethernity.cloud', chainId: 8995 },
  'ecld-pynithy-litvm-testnet': { rpcUrl: 'https://liteforge.rpc.caldera.xyz/infra-partner-http', chainId: 4441 },
  'ecld-nodenithy-litvm-testnet': { rpcUrl: 'https://liteforge.rpc.caldera.xyz/infra-partner-http', chainId: 4441 },
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
};

// Case-insensitive: ecld-init writes Bloxberg_Testnet_Unsafe, a --network
// flag may say BLOXBERG_TESTNET_UNSAFE.
const isUnsafeNetwork = (network) =>
  Object.keys(UNSAFE_NETWORKS).some((name) => name.toUpperCase() === String(network || '').toUpperCase());

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
  UNSAFE_NETWORKS, isUnsafeNetwork, nameOnNetwork, sessionTag, renderCompose,
};
