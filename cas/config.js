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

module.exports = { VALIDATOR_REGISTRY, SESSION_REGISTRY, CHAIN, casProvisioned };
