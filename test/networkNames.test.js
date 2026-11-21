// The network identifiers of the SDK and the values behind them, as literals:
// what release 1.8.6 carries (PUBLISHED_*) and what release 1.8.7 adds beside
// it (ADDED_*: the PoX 1.0 testnet networks of the bloxberg testnet and
// Polygon Amoy). A published BLOCKCHAIN_NETWORK value keeps its trustedzone
// images, its SDK registry tag, its session tag, its name at the certificate
// extraction service, its kind, its contracts in the build tables, in
// ecld-info and in image_registry.js, and the runner network ecld-run and the
// Hello World template construct for it. The build scripts and
// image_registry.js run when imported, so their tables are read from their
// text; image_registry.js's setVars is evaluated from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as runnerEnums from '@ethernity-cloud/runner/enums.js';
import casConfig from '../cas/config.js';
import network from '../network.js';
import init from '../init.js';
import info from '../info.js';

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

// The networks ecld-init offers, in its order, as release 1.8.6 offers them,
// each with the BLOCKCHAIN_NETWORK it writes, its kind, the trustedzone image
// per service type, the SDK registry tag of that trustedzone in each build
// (null where the build has none), the session tag, the name at the
// extraction service and what image_registry.js binds (its RPC, image
// registry, chain id, gas and gas price).
const BLOXBERG_REGISTRY_VARS = (registry) => ({
  NETWORK_RPC: 'https://bloxberg.ethernity.cloud', IMAGE_REGISTRY_ADDRESS: registry, CHAIN_ID: 8995, GAS: 9000000, GAS_PRICE: 1
});
const AMOY_REGISTRY_VARS = (registry) => ({
  NETWORK_RPC: 'https://polygon-amoy-bor-rpc.publicnode.com', IMAGE_REGISTRY_ADDRESS: registry, CHAIN_ID: 80002, GAS: 20000000, GAS_PRICE: 40000000010
});
const SEPOLIA_REGISTRY_VARS = {
  NETWORK_RPC: 'https://sepolia.gateway.tenderly.co', IMAGE_REGISTRY_ADDRESS: '0xa7E43a269E3307cf9d246b07df2B89CAA1b4C42F', CHAIN_ID: 11155111, GAS: 20000000, GAS_PRICE: 100000000
};
const LITVM_REGISTRY_VARS = {
  NETWORK_RPC: 'https://rpc.testnet.liteforge.zeeve.net/', IMAGE_REGISTRY_ADDRESS: '0xAf8Ce29103E1f59feDD49688ff070Ffc2346AF1D', CHAIN_ID: 4441, GAS: 9000000, GAS_PRICE: 1
};
const PUBLISHED_NETWORKS = [
  {
    option: 'Bloxberg Mainnet', name: 'Bloxberg_Mainnet', kind: 'mainnet',
    images: { Nodenithy: 'etny-nodenithy', Pynithy: 'etny-pynithy' },
    tags: { nodenithy: 'bloxberg', pynithy: 'bloxberg' },
    sessionTag: 'mainnet', extraction: 'mainnet',
    registry: BLOXBERG_REGISTRY_VARS('0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31')
  },
  {
    option: 'Bloxberg Testnet', name: 'Bloxberg_Testnet', kind: 'testnet',
    images: { Nodenithy: 'etny-nodenithy-testnet', Pynithy: 'etny-pynithy-testnet' },
    tags: { nodenithy: 'bloxberg_testnet', pynithy: 'bloxberg_testnet' },
    sessionTag: 'testnet', extraction: 'testnet',
    registry: BLOXBERG_REGISTRY_VARS('0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1')
  },
  {
    option: 'Polygon Mainnet', name: 'Polygon_Mainnet', kind: 'mainnet',
    images: { Nodenithy: 'ecld-nodenithy', Pynithy: 'ecld-pynithy' },
    tags: { nodenithy: 'polygon', pynithy: 'polygon' },
    sessionTag: 'mainnet', extraction: 'mainnet',
    registry: {
      NETWORK_RPC: 'https://polygon-bor-rpc.publicnode.com', IMAGE_REGISTRY_ADDRESS: '0x689f3806874d3c8A973f419a4eB24e6fBA7E830F', CHAIN_ID: 137, GAS: 20000000, GAS_PRICE: 40500500010
    }
  },
  {
    option: 'Polygon Amoy Testnet', name: 'Polygon_Amoy_Testnet', kind: 'testnet',
    images: { Nodenithy: 'ecld-nodenithy-amoy', Pynithy: 'ecld-pynithy-amoy' },
    tags: { nodenithy: 'amoy', pynithy: 'amoy' },
    sessionTag: 'amoy', extraction: 'amoy',
    registry: AMOY_REGISTRY_VARS('0x0C0f52ebd72cd2d2cBe94F385c9e23cec528b706')
  },
  {
    // image_registry.js has no IoTeX branch: it binds what it starts with.
    option: 'IoTeX Testnet', name: 'IoTeX_Testnet', kind: 'testnet',
    images: { Nodenithy: 'ecld-nodenithy-iotex-testnet', Pynithy: 'ecld-pynithy-iotex-testnet' },
    tags: { nodenithy: 'iotex_testnet', pynithy: 'iotex_testnet' },
    sessionTag: 'testnet', extraction: 'testnet',
    registry: BLOXBERG_REGISTRY_VARS('0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1')
  },
  {
    option: 'Ethereum Sepolia', name: 'Ethereum_Sepolia', kind: 'testnet',
    images: { Nodenithy: 'ecld-nodenithy-ethereum-sepolia', Pynithy: 'ecld-pynithy-ethereum-sepolia' },
    tags: { nodenithy: 'ethereum_sepolia', pynithy: 'ethereum_sepolia' },
    sessionTag: 'sepolia', extraction: 'sepolia',
    registry: SEPOLIA_REGISTRY_VARS
  },
  {
    option: 'LitVM LiteForge', name: 'LitVM_LiteForge', kind: 'testnet',
    images: { Nodenithy: 'ecld-nodenithy-litvm-testnet', Pynithy: 'ecld-pynithy-litvm-testnet' },
    tags: { nodenithy: 'litvm_liteforge', pynithy: 'litvm_liteforge' },
    sessionTag: 'liteforge', extraction: 'liteforge',
    registry: LITVM_REGISTRY_VARS
  },
  {
    option: 'Bloxberg Testnet Unsafe', name: 'Bloxberg_Testnet_Unsafe', kind: 'unsafe',
    images: { Nodenithy: 'etny-nodenithy-testnet-unsafe', Pynithy: 'etny-pynithy-testnet-unsafe' },
    tags: { nodenithy: 'bloxberg_testnet_unsafe', pynithy: 'bloxberg_testnet_unsafe' },
    sessionTag: 'testnet_unsafe', extraction: 'testnet',
    registry: BLOXBERG_REGISTRY_VARS('0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1')
  },
  {
    option: 'LitVM LiteForge Unsafe', name: 'LitVM_LiteForge_Unsafe', kind: 'unsafe',
    images: { Nodenithy: 'ecld-nodenithy-litvm-testnet-unsafe', Pynithy: 'ecld-pynithy-litvm-testnet-unsafe' },
    tags: { nodenithy: 'litvm_liteforge_unsafe', pynithy: 'litvm_liteforge_unsafe' },
    sessionTag: 'liteforge_unsafe', extraction: 'liteforge',
    registry: LITVM_REGISTRY_VARS
  },
  {
    option: 'Ethereum Sepolia Unsafe', name: 'Ethereum_Sepolia_Unsafe', kind: 'unsafe',
    images: { Nodenithy: 'ecld-nodenithy-ethereum-sepolia-unsafe', Pynithy: 'ecld-pynithy-ethereum-sepolia-unsafe' },
    tags: { nodenithy: 'ethereum_sepolia_unsafe', pynithy: null },
    sessionTag: 'sepolia_unsafe', extraction: 'sepolia',
    registry: SEPOLIA_REGISTRY_VARS
  },
  {
    option: 'Polygon Amoy Testnet Unsafe', name: 'Polygon_Amoy_Testnet_Unsafe', kind: 'unsafe',
    images: { Nodenithy: 'ecld-nodenithy-amoy-unsafe', Pynithy: 'ecld-pynithy-amoy-unsafe' },
    tags: { nodenithy: 'amoy_unsafe', pynithy: null },
    sessionTag: 'amoy_unsafe', extraction: 'amoy',
    registry: AMOY_REGISTRY_VARS('0x0C0f52ebd72cd2d2cBe94F385c9e23cec528b706')
  }
];

// The networks release 1.8.7 adds, in the order ecld-init offers them after
// the published ones.
const ADDED_NETWORKS = [
  {
    option: 'Bloxberg Testnet Pox10', name: 'Bloxberg_Testnet_Pox10', kind: 'pox10',
    images: { Nodenithy: 'etny-nodenithy-testnet-pox10', Pynithy: 'etny-pynithy-testnet-pox10' },
    tags: { nodenithy: 'bloxberg_testnet_pox10', pynithy: 'bloxberg_testnet_pox10' },
    sessionTag: 'bloxberg_testnet_pox10', extraction: 'bloxberg_testnet_pox10',
    registry: BLOXBERG_REGISTRY_VARS('0x7dBC1b591cc3b7136D863bc7430C6Db50E929665')
  },
  {
    option: 'Polygon Amoy Pox10', name: 'Polygon_Amoy_Pox10', kind: 'pox10',
    images: { Nodenithy: 'ecld-nodenithy-amoy-pox10', Pynithy: 'ecld-pynithy-amoy-pox10' },
    tags: { nodenithy: 'polygon_amoy_pox10', pynithy: 'polygon_amoy_pox10' },
    sessionTag: 'polygon_amoy_pox10', extraction: 'polygon_amoy_pox10',
    registry: AMOY_REGISTRY_VARS('0xa2EE2a9118d0011AF05a6196c862D37d8c29F8eC')
  }
];
const NETWORKS = [...PUBLISHED_NETWORKS, ...ADDED_NETWORKS];

// The build tables of both build scripts, one row per trustedzone image:
// [PoX, image registry, RPC, chain id].
const BLOXBERG = 'https://bloxberg.ethernity.cloud';
const POLYGON = 'https://polygon-bor-rpc.publicnode.com';
const AMOY = 'https://polygon-amoy-bor-rpc.publicnode.com';
const IOTEX = 'https://babel-api.testnet.iotex.io';
const SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com';
const LITVM = 'https://rpc.testnet.liteforge.zeeve.net/';
const bothKinds = (prefix, suffix, row) => ({
  [`${prefix}-pynithy${suffix}`]: row,
  [`${prefix}-nodenithy${suffix}`]: row
});
const PUBLISHED_BUILD_ROWS = {
  ...bothKinds('etny', '-testnet', ['0x830c781F0352050343211B6BFA83600B3e77647C', '0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1', BLOXBERG, 8995]),
  ...bothKinds('etny', '', ['0x549A6E06BB2084100148D50F51CF77a3436C3Ae7', '0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31', BLOXBERG, 8995]),
  ...bothKinds('ecld', '', ['0x439945BE73fD86fcC172179021991E96Beff3Cc4', '0x689f3806874d3c8A973f419a4eB24e6fBA7E830F', POLYGON, 137]),
  ...bothKinds('ecld', '-amoy', ['0xd1182deA61CDa785C320cdBE5888EaC4178cAAF2', '0x0C0f52ebd72cd2d2cBe94F385c9e23cec528b706', AMOY, 80002]),
  ...bothKinds('ecld', '-amoy-unsafe', ['0xd1182deA61CDa785C320cdBE5888EaC4178cAAF2', '0x0C0f52ebd72cd2d2cBe94F385c9e23cec528b706', AMOY, 80002]),
  ...bothKinds('ecld', '-iotex-testnet', ['0xD56385A97413Ed80E28B1b54A193b98F2C49c975', '0xa7467A6391816be9367a1cC52E0ef0c15FfE3cCC', IOTEX, 4690]),
  ...bothKinds('ecld', '-ethereum-sepolia', ['0x798975F9FdD90A21Cb11Ac26F1377e1542c58f9c', '0xa7E43a269E3307cf9d246b07df2B89CAA1b4C42F', SEPOLIA, 11155111]),
  ...bothKinds('ecld', '-ethereum-sepolia-unsafe', ['0x798975F9FdD90A21Cb11Ac26F1377e1542c58f9c', '0xa7E43a269E3307cf9d246b07df2B89CAA1b4C42F', SEPOLIA, 11155111]),
  ...bothKinds('ecld', '-litvm-testnet', ['0xE35991de1f2A435e29E70406FA2781b1AffCb168', '0xAf8Ce29103E1f59feDD49688ff070Ffc2346AF1D', LITVM, 4441]),
  ...bothKinds('etny', '-testnet-unsafe', ['0x830c781F0352050343211B6BFA83600B3e77647C', '0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1', BLOXBERG, 8995]),
  ...bothKinds('ecld', '-litvm-testnet-unsafe', ['0xE35991de1f2A435e29E70406FA2781b1AffCb168', '0xAf8Ce29103E1f59feDD49688ff070Ffc2346AF1D', LITVM, 4441])
};
const ADDED_BUILD_ROWS = {
  ...bothKinds('etny', '-testnet-pox10', ['0x69A7bEB5Da2d3dA711d52E491D71e51296b08745', '0x7dBC1b591cc3b7136D863bc7430C6Db50E929665', BLOXBERG, 8995]),
  ...bothKinds('ecld', '-amoy-pox10', ['0x9Aad82557c84c11C4031382d8Bf2cacF8f256a02', '0xa2EE2a9118d0011AF05a6196c862D37d8c29F8eC', AMOY, 80002])
};

const PUBLISHED_CAS = {
  VALIDATOR_REGISTRY: {
    'etny-pynithy-testnet': '0xc346BfFC83f318FbbC34987cEF85716a3f7dCcB0',
    'etny-nodenithy-testnet': '0xc346BfFC83f318FbbC34987cEF85716a3f7dCcB0',
    'ecld-pynithy-litvm-testnet': '0xbE3759f327e8643fC5A1717fb2072A0dAcBAD29E',
    'ecld-nodenithy-litvm-testnet': '0xbE3759f327e8643fC5A1717fb2072A0dAcBAD29E',
    'ecld-pynithy-ethereum-sepolia': '0x8ad24b3F406A41a0F8D3440021792EB203957F43',
    'ecld-nodenithy-ethereum-sepolia': '0x8ad24b3F406A41a0F8D3440021792EB203957F43',
    'ecld-pynithy-amoy': '0x48079D66B39cD3213587d3b5300BCEc401df6676',
    'ecld-nodenithy-amoy': '0x48079D66B39cD3213587d3b5300BCEc401df6676'
  },
  SESSION_REGISTRY: {
    'etny-pynithy-testnet': '0x78f0c5E92E7A9Ec2f2A36A4509ED4a75D0f9463B',
    'etny-nodenithy-testnet': '0x78f0c5E92E7A9Ec2f2A36A4509ED4a75D0f9463B',
    'ecld-pynithy-litvm-testnet': '0xfA70B5Df7C773A21164cAc5413704117e4dEaB76',
    'ecld-nodenithy-litvm-testnet': '0xfA70B5Df7C773A21164cAc5413704117e4dEaB76',
    'ecld-pynithy-ethereum-sepolia': '0xDbB249E108d19fC1691483Bf897bA8BA0dA99c06',
    'ecld-nodenithy-ethereum-sepolia': '0xDbB249E108d19fC1691483Bf897bA8BA0dA99c06',
    'ecld-pynithy-amoy': '0x059662030fEeB4Ea8Fc7b05951A578d527a827e5',
    'ecld-nodenithy-amoy': '0x059662030fEeB4Ea8Fc7b05951A578d527a827e5'
  },
  CHAIN: {
    'etny-pynithy-testnet': { rpcUrl: 'https://bloxberg.ethernity.cloud', chainId: 8995 },
    'etny-nodenithy-testnet': { rpcUrl: 'https://bloxberg.ethernity.cloud', chainId: 8995 },
    'ecld-pynithy-litvm-testnet': { rpcUrl: 'https://rpc.testnet.liteforge.zeeve.net/', chainId: 4441 },
    'ecld-nodenithy-litvm-testnet': { rpcUrl: 'https://rpc.testnet.liteforge.zeeve.net/', chainId: 4441 },
    'ecld-pynithy-ethereum-sepolia': { rpcUrl: 'https://sepolia.gateway.tenderly.co', chainId: 11155111 },
    'ecld-nodenithy-ethereum-sepolia': { rpcUrl: 'https://sepolia.gateway.tenderly.co', chainId: 11155111 },
    'ecld-pynithy-amoy': { rpcUrl: 'https://polygon-amoy-bor-rpc.publicnode.com', chainId: 80002 },
    'ecld-nodenithy-amoy': { rpcUrl: 'https://polygon-amoy-bor-rpc.publicnode.com', chainId: 80002 }
  },
  UNSAFE_NETWORKS: {
    Bloxberg_Testnet_Unsafe: 'Bloxberg_Testnet',
    LitVM_LiteForge_Unsafe: 'LitVM_LiteForge',
    Ethereum_Sepolia_Unsafe: 'Ethereum_Sepolia',
    Polygon_Amoy_Testnet_Unsafe: 'Polygon_Amoy_Testnet'
  },
  TESTNETS: [
    'Bloxberg_Testnet', 'Polygon_Amoy_Testnet', 'IoTeX_Testnet', 'Ethereum_Sepolia', 'LitVM_LiteForge',
    'Bloxberg_Testnet_Unsafe', 'LitVM_LiteForge_Unsafe', 'Ethereum_Sepolia_Unsafe', 'Polygon_Amoy_Testnet_Unsafe'
  ]
};

// The runner network of each key network.js takes: the constructor's address,
// its chain id and RPC where the runner needs them, and the (network, type)
// the runner is set to.
const BLOXBERG_TOKEN = '0x02882F03097fE8cD31afbdFbB5D72a498B41112c';
const AMOY_TOKEN = '0x9927809B61122B2af3f3b3A3303875e0687b8eE3';
const SEPOLIA_NETWORK = { address: '0x2E27677fb67531eb09134fE331C27899f87ADe10', chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com' };
const LITVM_NETWORK = { address: '0x95Aa17fCFaAB75e8ed7d7DF218045795dCeB9c50', chainId: 4441, rpcUrl: 'https://rpc.testnet.liteforge.zeeve.net/' };
const PUBLISHED_RUNNER_NETWORKS = {
  BLOXBERG_TESTNET: { address: BLOXBERG_TOKEN },
  BLOXBERG_TESTNET_UNSAFE: { address: BLOXBERG_TOKEN, unsafe: ['BLOXBERG', 'TESTNET_UNSAFE'] },
  BLOXBERG_MAINNET: { address: '0x549A6E06BB2084100148D50F51CF77a3436C3Ae7' },
  POLYGON_MAINNET: { address: '0xc6920888988cAcEeA7ACCA0c96f2D65b05eE22Ba' },
  POLYGON_AMOY: { address: AMOY_TOKEN },
  POLYGON_AMOY_TESTNET: { address: AMOY_TOKEN },
  POLYGON_AMOY_UNSAFE: { address: AMOY_TOKEN, unsafe: ['POLYGON', 'TESTNET_UNSAFE'] },
  POLYGON_AMOY_TESTNET_UNSAFE: { address: AMOY_TOKEN, unsafe: ['POLYGON', 'TESTNET_UNSAFE'] },
  IOTEX_TESTNET: { address: '0x95Aa17fCFaAB75e8ed7d7DF218045795dCeB9c50', chainId: 4690, rpcUrl: 'https://babel-api.testnet.iotex.io' },
  ETHEREUM_SEPOLIA: SEPOLIA_NETWORK,
  SEPOLIA: SEPOLIA_NETWORK,
  ETHEREUM_SEPOLIA_UNSAFE: { ...SEPOLIA_NETWORK, unsafe: ['SEPOLIA', 'TESTNET_UNSAFE'] },
  LITVM_LITEFORGE: LITVM_NETWORK,
  LITVM: LITVM_NETWORK,
  LITVM_LITEFORGE_UNSAFE: { ...LITVM_NETWORK, unsafe: ['LITVM', 'TESTNET_UNSAFE'] }
};
const ADDED_RUNNER_NETWORKS = {
  BLOXBERG_TESTNET_POX10: { address: '0x69A7bEB5Da2d3dA711d52E491D71e51296b08745', pox10: ['BLOXBERG', 'TESTNET_POX10'] },
  POLYGON_AMOY_POX10: { address: AMOY_TOKEN, pox10: ['POLYGON', 'TESTNET_POX10'] }
};

// The networks ecld-info knows, and the -unsafe ones it derives from them.
const PUBLISHED_INFO = {
  BLOXBERG_MAINNET: {
    type: 'mainnet', chainId: 8995, rpc: 'https://bloxberg.ethernity.cloud',
    protocol: '0x549A6E06BB2084100148D50F51CF77a3436C3Ae7',
    imageRegistry: '0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31',
    esr: '0x4Bf5cDE3BFD73dd10B707f8B123Ba631D2EBEAD2'
  },
  BLOXBERG_TESTNET: {
    type: 'testnet', chainId: 8995, rpc: 'https://bloxberg.ethernity.cloud',
    protocol: '0x830c781F0352050343211B6BFA83600B3e77647C',
    imageRegistry: '0xa372a6e1Eb7Fcf343AF6b91E809b900C55001CD1',
    esr: '0x0Ea1728EAE108FD3B9340ae91451348E2Cc6b4E4'
  },
  LITVM_LITEFORGE: {
    type: 'testnet', chainId: 4441, rpc: 'https://rpc.testnet.liteforge.zeeve.net/',
    protocol: '0xE35991de1f2A435e29E70406FA2781b1AffCb168',
    imageRegistry: '0xAf8Ce29103E1f59feDD49688ff070Ffc2346AF1D',
    esr: '0x709052Fe77Af543d3d9FE2Ac06a15c635c8D4Be5'
  },
  POLYGON_AMOY_TESTNET: {
    type: 'testnet', chainId: 80002, rpc: 'https://polygon-amoy-bor-rpc.publicnode.com',
    protocol: '0xd1182deA61CDa785C320cdBE5888EaC4178cAAF2',
    imageRegistry: '0x0C0f52ebd72cd2d2cBe94F385c9e23cec528b706',
    esr: '0x1DC58496ed1cA66FD1E0b51fA28A9E7451970843'
  },
  ETHEREUM_SEPOLIA: {
    type: 'testnet', chainId: 11155111, rpc: 'https://sepolia.gateway.tenderly.co',
    protocol: '0x798975F9FdD90A21Cb11Ac26F1377e1542c58f9c',
    imageRegistry: '0xa7E43a269E3307cf9d246b07df2B89CAA1b4C42F',
    esr: '0x9927809B61122B2af3f3b3A3303875e0687b8eE3'
  }
};
const UNSAFE_INFO = { type: 'unsafe testnet, no CAS' };
const PUBLISHED_INFO_UNSAFE = {
  BLOXBERG_TESTNET_UNSAFE: { ...PUBLISHED_INFO.BLOXBERG_TESTNET, ...UNSAFE_INFO },
  LITVM_LITEFORGE_UNSAFE: { ...PUBLISHED_INFO.LITVM_LITEFORGE, ...UNSAFE_INFO },
  ETHEREUM_SEPOLIA_UNSAFE: { ...PUBLISHED_INFO.ETHEREUM_SEPOLIA, ...UNSAFE_INFO },
  POLYGON_AMOY_TESTNET_UNSAFE: { ...PUBLISHED_INFO.POLYGON_AMOY_TESTNET, ...UNSAFE_INFO }
};
const ADDED_INFO = {
  BLOXBERG_TESTNET_POX10: {
    type: 'testnet, PoX 1.0', chainId: 8995, rpc: 'https://bloxberg.ethernity.cloud',
    protocol: '0x69A7bEB5Da2d3dA711d52E491D71e51296b08745',
    imageRegistry: '0x7dBC1b591cc3b7136D863bc7430C6Db50E929665',
    esr: '0x0Ea1728EAE108FD3B9340ae91451348E2Cc6b4E4'
  },
  POLYGON_AMOY_POX10: {
    type: 'testnet, PoX 1.0', chainId: 80002, rpc: 'https://polygon-amoy-bor-rpc.publicnode.com',
    protocol: '0x9Aad82557c84c11C4031382d8Bf2cacF8f256a02',
    imageRegistry: '0xa2EE2a9118d0011AF05a6196c862D37d8c29F8eC'
  }
};

const PRODUCTION_ATTESTATION = {
  tolerate: '[hyperthreading, outdated-tcb, software-hardening-needed]',
  ignoreAdvisories: '["INTEL-SA-00615"]'
};
const TESTNET_ATTESTATION = {
  tolerate: '[hyperthreading, outdated-tcb, software-hardening-needed, debug-mode]',
  ignoreAdvisories: '["*"]'
};

// The rows of a build script's ECRunner table, by trustedzone image.
const ROW = /^\s*'([a-z0-9-]+)':\s*\['(0x[0-9a-fA-F]{40})',\s*'(0x[0-9a-fA-F]{40})',\s*'([^']+)',\s*(\d+)\]/;
const buildRows = (file) => Object.fromEntries(read(file).split(/\r?\n/).map((line) => line.match(ROW)).filter(Boolean)
  .map(([, name, pox, registry, rpc, chainId]) => [name, [pox, registry, rpc, Number(chainId)]]));

// The entries of a build script's trustedZoneNetByBlockchain map.
const buildTags = (file) => {
  const text = read(file);
  const from = text.indexOf('const trustedZoneNetByBlockchain = {');
  assert.ok(from >= 0, `${file} has no trustedZoneNetByBlockchain`);
  const body = text.slice(from, text.indexOf('};', from));
  return Object.fromEntries([...body.matchAll(/^\s*([A-Za-z0-9_]+): '([a-z0-9_]+)',$/gm)].map(([, name, tag]) => [name, tag]));
};

// What image_registry.js binds for `name`, run as `node image_registry.js
// <name> ...` with BLOCKCHAIN_NETWORK set to `envName` in its environment
// (unset when undefined): its declarations and setVars, from the script's
// text, evaluated as the script evaluates them.
const registryVars = (file, envName, name) => {
  const text = read(file);
  const from = text.indexOf('let BLOCKCHAIN_NETWORK');
  const to = text.indexOf('setVars();') + 'setVars();'.length;
  assert.ok(from >= 0 && to > from, `${file} has no setVars prelude`);
  const body = `${text.slice(from, to)}\nBLOCKCHAIN_NETWORK = networkName; setVars(networkName);\n`
    + 'return { NETWORK_RPC, IMAGE_REGISTRY_ADDRESS, CHAIN_ID, GAS, GAS_PRICE };';
  return new Function('process', 'networkName', body)({ env: envName ? { BLOCKCHAIN_NETWORK: envName } : {} }, name);
};

test('ecld-init offers the published networks in their published order, then the two PoX 1.0 testnet networks', () => {
  assert.deepEqual(init.NETWORK_OPTIONS, NETWORKS.map((n) => n.option));
  assert.deepEqual(init.NETWORK_OPTIONS.slice(0, PUBLISHED_NETWORKS.length), PUBLISHED_NETWORKS.map((n) => n.option));
  for (const { option, name } of NETWORKS) {
    assert.equal(option.replace(/ /g, '_'), name);
  }
  assert.deepEqual(ADDED_NETWORKS.map((n) => n.name), ['Bloxberg_Testnet_Pox10', 'Polygon_Amoy_Pox10']);
});

test('every network keeps its trustedzone image per service type', () => {
  for (const { option, images } of NETWORKS) {
    for (const [serviceType, image] of Object.entries(images)) {
      assert.equal(init.trustedZoneImageFor(option, serviceType), image, `${option} ${serviceType}`);
    }
  }
  // A choice outside the list takes the bloxberg testnet's image.
  assert.equal(init.trustedZoneImageFor('Elsewhere', 'Nodenithy'), 'etny-nodenithy-testnet');
});

test('every network keeps its kind: a mainnet, a testnet, an -unsafe testnet or a PoX 1.0 testnet network', () => {
  for (const { name, kind } of NETWORKS) {
    for (const spelled of [name, name.toUpperCase(), name.toLowerCase()]) {
      assert.equal(casConfig.isMainnetNetwork(spelled), kind === 'mainnet', spelled);
      assert.equal(casConfig.isTestnetNetwork(spelled), kind === 'testnet' || kind === 'unsafe', spelled);
      assert.equal(casConfig.isUnsafeNetwork(spelled), kind === 'unsafe', spelled);
      assert.equal(casConfig.isPox10TestnetNetwork(spelled), kind === 'pox10', spelled);
      assert.equal(casConfig.isScontainCasNetwork(spelled), kind === 'mainnet' || kind === 'pox10', spelled);
      assert.deepEqual(casConfig.sessionAttestation(spelled),
        kind === 'testnet' || kind === 'unsafe' ? TESTNET_ATTESTATION : PRODUCTION_ATTESTATION, spelled);
    }
    assert.equal(casConfig.nameOnNetwork('demo', name), kind === 'unsafe' ? 'demo-unsafe' : 'demo', name);
  }
});

test('the ethernity-cas tables hold the published entries and no PoX 1.0 template', () => {
  for (const [table, published] of Object.entries(PUBLISHED_CAS)) {
    assert.deepEqual(casConfig[table], published, table);
  }
  assert.deepEqual(casConfig.POX10_TESTNETS, {
    Bloxberg_Testnet_Pox10: 'bloxberg_testnet_pox10',
    Polygon_Amoy_Pox10: 'polygon_amoy_pox10'
  });
  // A securelock is CAS-provisioned on a mainnet, on a PoX 1.0 testnet
  // network and where its template has a SessionRegistry.
  for (const { name, kind, images } of NETWORKS) {
    for (const image of Object.values(images)) {
      const scontainCas = casConfig.isScontainCasNetwork(name);
      const expected = kind === 'mainnet' || kind === 'pox10' || image in PUBLISHED_CAS.SESSION_REGISTRY;
      assert.equal(casConfig.casProvisioned(image, scontainCas), expected, `${name} ${image}`);
    }
  }
});

test('every network keeps its securelock session tag and its name at the certificate extraction service', () => {
  for (const { name, sessionTag, extraction } of NETWORKS) {
    assert.equal(casConfig.sessionTag(name), sessionTag, name);
    assert.equal(casConfig.extractionNetwork(name), extraction, name);
  }
  // Both runners' clients of the service take the name from cas/config.js.
  const clients = ['../nodenithy/run/public_key_service.js', '../pynithy/run/public_key_service.js'].map(read);
  assert.equal(clients[0], clients[1]);
  assert.match(clients[0], /const network = casConfig\.extractionNetwork\(options\.network\);/);
});

test('both build scripts hold the published rows with their published values, and the four PoX 1.0 rows', () => {
  for (const file of ['../nodenithy/build.mjs', '../pynithy/build.mjs']) {
    assert.deepEqual(buildRows(file), { ...PUBLISHED_BUILD_ROWS, ...ADDED_BUILD_ROWS }, file);
  }
  assert.deepEqual(Object.keys(ADDED_BUILD_ROWS).filter((name) => name in PUBLISHED_BUILD_ROWS), []);
  // The table's lines are the same lines in both scripts.
  const tableLines = (file) => read(file).split(/\r?\n/).filter((line) => ROW.test(line) || /^\s*\/\/ --- /.test(line));
  assert.deepEqual(tableLines('../nodenithy/build.mjs'), tableLines('../pynithy/build.mjs'));
});

test('each build names the published SDK registry tag of every network it builds for, and the PoX 1.0 words', () => {
  for (const kind of ['nodenithy', 'pynithy']) {
    const expected = Object.fromEntries(NETWORKS.filter((n) => n.tags[kind] !== null).map((n) => [n.name, n.tags[kind]]));
    assert.deepEqual(buildTags(`../${kind}/build.mjs`), expected, kind);
  }
  // A tag both builds carry is the same tag.
  const [nodenithy, pynithy] = ['nodenithy', 'pynithy'].map((kind) => buildTags(`../${kind}/build.mjs`));
  for (const [name, tag] of Object.entries(pynithy)) {
    assert.equal(nodenithy[name], tag, name);
  }
});

test('image_registry.js binds every network to its published RPC, registry, chain and gas, and the PoX 1.0 networks to theirs', () => {
  const scripts = ['../nodenithy/run/image_registry.js', '../pynithy/run/image_registry.js'];
  assert.equal(read(scripts[0]), read(scripts[1]));
  for (const { name, registry } of NETWORKS) {
    // As ecld-publish runs it, and as ecld-init does in a directory with no .env.
    assert.deepEqual(registryVars(scripts[0], name, name), registry, name);
    assert.deepEqual(registryVars(scripts[0], undefined, name), registry, `${name}, no environment`);
  }
});

test('network.js names the published runner network of every published key, and the two PoX 1.0 keys', () => {
  const expected = { ...PUBLISHED_RUNNER_NETWORKS, ...ADDED_RUNNER_NETWORKS };
  for (const [key, runnerNetwork] of Object.entries(expected)) {
    const found = network.networkFor(runnerEnums, key);
    assert.equal(found.key, key);
    assert.deepEqual(found.network, runnerNetwork, key);
    assert.deepEqual(found.known, Object.keys(expected), key);
  }
  // Each BLOCKCHAIN_NETWORK ecld-init writes is a key, however it is cased.
  for (const { name } of NETWORKS) {
    assert.deepEqual(network.networkFor(runnerEnums, name).network, expected[name.toUpperCase()], name);
    assert.deepEqual(network.networkFor(runnerEnums, name.replace(/_/g, ' ')).network, expected[name.toUpperCase()], name);
  }
  assert.equal(network.networkFor(runnerEnums, 'Elsewhere').network, null);
});

test('with a runner that predates the PoX 1.0 testnet networks, network.js knows the published keys alone', () => {
  const { POX10_TESTNET_TYPE, ...before } = runnerEnums;
  assert.equal(POX10_TESTNET_TYPE, 'TESTNET_POX10');
  for (const [key, runnerNetwork] of Object.entries(PUBLISHED_RUNNER_NETWORKS)) {
    const found = network.networkFor(before, key);
    assert.deepEqual(found.network, runnerNetwork, key);
    assert.deepEqual(found.known, Object.keys(PUBLISHED_RUNNER_NETWORKS), key);
  }
  for (const key of Object.keys(ADDED_RUNNER_NETWORKS)) {
    assert.equal(network.networkFor(before, key).network, null, key);
  }
});

test('the -unsafe variant of a network is the published one; a PoX 1.0 testnet network has none', () => {
  for (const [unsafe, sibling] of Object.entries(PUBLISHED_CAS.UNSAFE_NETWORKS)) {
    assert.equal(network.unsafeVariant(sibling), unsafe);
    assert.equal(network.unsafeVariant(unsafe), unsafe);
  }
  for (const name of ['Bloxberg_Mainnet', 'Polygon_Mainnet', 'IoTeX_Testnet', 'Bloxberg_Testnet_Pox10', 'Polygon_Amoy_Pox10']) {
    assert.equal(network.unsafeVariant(name), null, name);
  }
});

test('ecld-info knows the published networks with their published values, and the two PoX 1.0 networks', () => {
  assert.deepEqual(info.NETWORKS, { ...PUBLISHED_INFO, ...ADDED_INFO, ...PUBLISHED_INFO_UNSAFE });
  assert.deepEqual(Object.keys(ADDED_INFO).filter((name) => name in PUBLISHED_INFO || name in PUBLISHED_INFO_UNSAFE), []);
});
