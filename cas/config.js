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
// securelock self-signs from MR_ENCLAVE. Mainnet templates, and those of the
// PoX 1.0 testnet networks (POX10_TESTNETS), are provisioned by the Scontain
// CAS and are not listed.
//
// Kept in sync with etny-{pynithy,nodenithy}/v3/networks.yaml
// (cas_session_registry_address, validator_registry_address).
const VALIDATOR_REGISTRY = {
  // Bloxberg testnet's ValidatorRegistry R3 of 2026-11-14 (ethernity-cas
  // CAS-SETUP.md "The cut of 2026-11-14 on bloxberg testnet"), seeded from the
  // Phase 2 registry 0x8CC8B1dc... of 2026-10-21; its set judges the PoX 2.0.
  'etny-pynithy-testnet': '0xc346BfFC83f318FbbC34987cEF85716a3f7dCcB0',
  'etny-nodenithy-testnet': '0xc346BfFC83f318FbbC34987cEF85716a3f7dCcB0',
  'ecld-pynithy-litvm-testnet': '0xbE3759f327e8643fC5A1717fb2072A0dAcBAD29E',
  'ecld-nodenithy-litvm-testnet': '0xbE3759f327e8643fC5A1717fb2072A0dAcBAD29E',
  'ecld-pynithy-ethereum-sepolia': '0x8ad24b3F406A41a0F8D3440021792EB203957F43',
  'ecld-nodenithy-ethereum-sepolia': '0x8ad24b3F406A41a0F8D3440021792EB203957F43',
  // Amoy's ValidatorRegistry R2 of 2026-11-12 (ethernity-cas CAS-SETUP.md "The
  // cut of 2026-11-12"); R1 0x70bfdf41... holds no serving member.
  'ecld-pynithy-amoy': '0x48079D66B39cD3213587d3b5300BCEc401df6676',
  'ecld-nodenithy-amoy': '0x48079D66B39cD3213587d3b5300BCEc401df6676',
};

const SESSION_REGISTRY = {
  // The SessionRegistry with image binding of 2026-10-22; it links an image
  // only once the Image Registry records it under the session's name.
  'etny-pynithy-testnet': '0x78f0c5E92E7A9Ec2f2A36A4509ED4a75D0f9463B',
  'etny-nodenithy-testnet': '0x78f0c5E92E7A9Ec2f2A36A4509ED4a75D0f9463B',
  'ecld-pynithy-litvm-testnet': '0xfA70B5Df7C773A21164cAc5413704117e4dEaB76',
  'ecld-nodenithy-litvm-testnet': '0xfA70B5Df7C773A21164cAc5413704117e4dEaB76',
  // Bound to Sepolia's ECImageRegistryV3 of 2026-10-14.
  'ecld-pynithy-ethereum-sepolia': '0xDbB249E108d19fC1691483Bf897bA8BA0dA99c06',
  'ecld-nodenithy-ethereum-sepolia': '0xDbB249E108d19fC1691483Bf897bA8BA0dA99c06',
  // Bound to Amoy's ECImageRegistryV3 of 2026-10-28.
  'ecld-pynithy-amoy': '0x059662030fEeB4Ea8Fc7b05951A578d527a827e5',
  'ecld-nodenithy-amoy': '0x059662030fEeB4Ea8Fc7b05951A578d527a827e5',
};

// The chain the registries above live on. Sepolia's RPC is Tenderly's gateway:
// publicnode caps eth_getLogs at 50,000 blocks and prunes older ranges. LitVM
// LiteForge's RPC is Zeeve's (docs.litvm.com), which caps eth_getLogs at 3,000
// blocks.
const CHAIN = {
  'etny-pynithy-testnet': { rpcUrl: 'https://bloxberg.ethernity.cloud', chainId: 8995 },
  'etny-nodenithy-testnet': { rpcUrl: 'https://bloxberg.ethernity.cloud', chainId: 8995 },
  'ecld-pynithy-litvm-testnet': { rpcUrl: 'https://rpc.testnet.liteforge.zeeve.net/', chainId: 4441 },
  'ecld-nodenithy-litvm-testnet': { rpcUrl: 'https://rpc.testnet.liteforge.zeeve.net/', chainId: 4441 },
  'ecld-pynithy-ethereum-sepolia': { rpcUrl: 'https://sepolia.gateway.tenderly.co', chainId: 11155111 },
  'ecld-nodenithy-ethereum-sepolia': { rpcUrl: 'https://sepolia.gateway.tenderly.co', chainId: 11155111 },
  'ecld-pynithy-amoy': { rpcUrl: 'https://polygon-amoy-bor-rpc.publicnode.com', chainId: 80002 },
  'ecld-nodenithy-amoy': { rpcUrl: 'https://polygon-amoy-bor-rpc.publicnode.com', chainId: 80002 },
};

// Whether the securelock takes its certificate from a CAS session: a network
// the Scontain CAS provisions (`scontainCas`, isScontainCasNetwork), or a
// testnet template with a SessionRegistry (ethernity-cas).
const casProvisioned = (templateName, scontainCas) => scontainCas || Boolean(SESSION_REGISTRY[templateName]);

// The mainnets, by BLOCKCHAIN_NETWORK. A template name does not tell: the Amoy
// templates (ecld-*-amoy) do not contain "testnet".
const MAINNETS = ['Bloxberg_Mainnet', 'Polygon_Mainnet'];
const isMainnetNetwork = (network) =>
  MAINNETS.some((name) => name.toUpperCase() === String(network || '').toUpperCase());

// The PoX 1.0 testnet networks, by BLOCKCHAIN_NETWORK, each with its network
// word: copies of the mainnets' PoX 1.0 contracts on the bloxberg testnet and
// on Polygon Amoy, beside those chains' PoX 2.0 networks (Bloxberg_Testnet,
// Polygon_Amoy_Testnet). Their trustedzones are built as the mainnet PoX 1.0
// trustedzones are (etny-{pynithy,nodenithy} branch pox-1.0, network_type
// "mainnet"): signed --production, their sessions at the Scontain CAS under
// the production attestation rules. A dApp is built and published for one as
// for the mainnet it copies. The word is the network's key in
// etny-{pynithy,nodenithy}/v3/networks.yaml, so the SDK registry tag of its
// trustedzone, and is the network's name in the securelock session
// (sessionTag) and at the certificate extraction service (extractionNetwork).
const POX10_TESTNETS = {
  Bloxberg_Testnet_Pox10: 'bloxberg_testnet_pox10',
  Polygon_Amoy_Pox10: 'polygon_amoy_pox10',
};

// The network word of a PoX 1.0 testnet network, or undefined for any other
// network. Case-insensitive, as isUnsafeNetwork is.
const pox10Word = (network) => {
  const name = Object.keys(POX10_TESTNETS)
    .find((known) => known.toUpperCase() === String(network || '').toUpperCase());
  return name && POX10_TESTNETS[name];
};
const isPox10TestnetNetwork = (network) => Boolean(pox10Word(network));

// Whether the Scontain CAS provisions the network's enclaves: the mainnets
// and the PoX 1.0 testnet networks. The securelock of such a network is built
// with the enclave network type "mainnet" and signed --production, and its
// session is POSTed to the Scontain CAS.
const isScontainCasNetwork = (network) => isMainnetNetwork(network) || isPox10TestnetNetwork(network);

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
  Polygon_Amoy_Testnet_Unsafe: 'Polygon_Amoy_Testnet',
};

// Case-insensitive: ecld-init writes Bloxberg_Testnet_Unsafe, a --network
// flag may say BLOXBERG_TESTNET_UNSAFE.
const isUnsafeNetwork = (network) =>
  Object.keys(UNSAFE_NETWORKS).some((name) => name.toUpperCase() === String(network || '').toUpperCase());

// The testnets whose sessions relax attestation (sessionAttestation), by
// BLOCKCHAIN_NETWORK: every network ecld-init offers but the two mainnets and
// the PoX 1.0 testnet networks, the -unsafe ones included.
const TESTNETS = [
  'Bloxberg_Testnet', 'Polygon_Amoy_Testnet', 'IoTeX_Testnet', 'Ethereum_Sepolia', 'LitVM_LiteForge',
  ...Object.keys(UNSAFE_NETWORKS),
];
const isTestnetNetwork = (network) =>
  TESTNETS.some((name) => name.toUpperCase() === String(network || '').toUpperCase());

// The attestation rules a securelock session declares on `network`, as the
// YAML flow sequences its template takes for __TOLERATE__ and
// __IGNORE_ADVISORIES__. A testnet tolerates a debug-signed enclave and ignores
// every Intel advisory. Any other network, a mainnet, a PoX 1.0 testnet
// network or a name not in TESTNETS, gets the production rules: no
// debug-mode, and INTEL-SA-00615 the one advisory ignored.
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
// never share a session name; the network word on a PoX 1.0 testnet network,
// whose sessions are at the Scontain CAS beside the mainnets'.
const sessionTag = (network) =>
  pox10Word(network) || `${network.split('_')[1].toLowerCase()}${isUnsafeNetwork(network) ? '_unsafe' : ''}`;

// The name the certificate extraction service (publickey.ethernity.cloud)
// takes for `network`: the second word of BLOCKCHAIN_NETWORK in lower case;
// the network word on a PoX 1.0 testnet network.
const extractionNetwork = (network) => pox10Word(network) || network.toLowerCase().split('_')[1];

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

// The securelock session's ESR environment entry. A CAS-provisioned enclave
// takes its environment from the session, not from the image's ENV, so the
// registry address the build baked must also be set here; without ESR (or
// without an address) the entry is a YAML comment.
const esrSessionEnvironment = (env) => {
  const enabled = /^(1|true|yes)$/i.test(String(env.ESR_ENABLED || '').trim());
  const address = String(env.ESR_CONTRACT_ADDRESS || '').trim();
  if (!enabled || !/^0x[0-9a-fA-F]{40}$/.test(address)) return '# ESR not enabled';
  return `ESR_CONTRACT_ADDRESS: "${address}"`;
};

module.exports = {
  VALIDATOR_REGISTRY, SESSION_REGISTRY, CHAIN, casProvisioned, isMainnetNetwork,
  POX10_TESTNETS, isPox10TestnetNetwork, isScontainCasNetwork,
  UNSAFE_NETWORKS, isUnsafeNetwork, TESTNETS, isTestnetNetwork, sessionAttestation,
  nameOnNetwork, sessionTag, extractionNetwork, renderCompose, esrSessionEnvironment,
};
