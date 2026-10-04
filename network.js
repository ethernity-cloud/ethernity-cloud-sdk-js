/* The runner's view of a project's network.
 *
 * BLOCKCHAIN_NETWORK, as ecld-init writes it (spaces -> underscores), names a
 * network; the runner is constructed with that network's token ADDRESS, the
 * chain id of a testnet whose token address other testnets share, and for an
 * -unsafe network is set to the (network, type) that runs only -unsafe
 * trustedzones. The table is built from the runner's own enums so the two
 * cannot drift; the enums are an argument because the runner is ESM and this
 * module is loaded from CJS (ecld-run) and ESM (a dApp's preStart) alike.
 * Shared by ecld-run and the Hello World template's src/preStart.mjs. */

'use strict';

const casConfig = require('./cas/config.js');

/* Accepts a few spellings per network. Returns the normalised key, the
 * network ({ address, chainId?, unsafe? }) or null, and the known keys. */
function networkFor({ ECAddress, ECNetworkByChainId }, raw) {
  const key = String(raw || '').trim().toUpperCase().replace(/\s+/g, '_');
  const bloxbergTestnet = { address: ECAddress.BLOXBERG.TESTNET_ADDRESS };
  const amoy = { address: ECAddress.POLYGON.TESTNET_ADDRESS };
  const sepolia = { address: ECAddress.SEPOLIA.TESTNET_ADDRESS, chainId: ECNetworkByChainId.SEPOLIA.TESTNET };
  const litvm = { address: ECAddress.LITVM.TESTNET_ADDRESS, chainId: ECNetworkByChainId.LITVM.TESTNET };
  const table = {
    BLOXBERG_TESTNET: bloxbergTestnet,
    BLOXBERG_TESTNET_UNSAFE: { ...bloxbergTestnet, unsafe: ['BLOXBERG', 'TESTNET_UNSAFE'] },
    BLOXBERG_MAINNET: { address: ECAddress.BLOXBERG.MAINNET_ADDRESS },
    POLYGON_MAINNET: { address: ECAddress.POLYGON.MAINNET_ADDRESS },
    POLYGON_AMOY: amoy,
    POLYGON_AMOY_TESTNET: amoy,
    IOTEX_TESTNET: { address: ECAddress.IOTEX.TESTNET_ADDRESS, chainId: ECNetworkByChainId.IOTEX.TESTNET },
    ETHEREUM_SEPOLIA: sepolia,
    SEPOLIA: sepolia,
    LITVM_LITEFORGE: litvm,
    LITVM: litvm,
    LITVM_LITEFORGE_UNSAFE: { ...litvm, unsafe: ['LITVM', 'TESTNET_UNSAFE'] },
  };
  return { key, network: table[key] || null, known: Object.keys(table) };
}

/* The -unsafe network a network token names, or whose sibling it names; null
 * when the network has no -unsafe variant. */
function unsafeVariant(raw) {
  const key = String(raw || '').trim().replace(/\s+/g, '_');
  if (casConfig.isUnsafeNetwork(key)) return key;
  const variant = Object.keys(casConfig.UNSAFE_NETWORKS)
    .find((name) => casConfig.UNSAFE_NETWORKS[name].toUpperCase() === key.toUpperCase());
  return variant || null;
}

module.exports = { networkFor, unsafeVariant };
