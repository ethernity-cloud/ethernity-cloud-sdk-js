// The PoX 1.0 testnet networks, Bloxberg_Testnet_Pox10 and Polygon_Amoy_Pox10:
// copies of the mainnets' PoX 1.0 contracts on the bloxberg testnet and on
// Polygon Amoy, built and published for as the mainnet each copies is (signed
// --production, the session at the Scontain CAS). The SDK's tables agree with
// the runner's on every network: the runner ecld-run and the Hello World
// template construct for a BLOCKCHAIN_NETWORK is on the PoX and the image
// registry the build bakes into that network's securelock, so Polygon Amoy's
// two networks, which share a token address, never stand in for each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import EthernityCloudRunner from '@ethernity-cloud/runner';
import * as runnerEnums from '@ethernity-cloud/runner/enums.js';
import casConfig from '../cas/config.js';
import network from '../network.js';
import init from '../init.js';

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

// The rows of a build script's ECRunner table, by trustedzone image.
const ROW = /^\s*'([a-z0-9-]+)':\s*\['(0x[0-9a-fA-F]{40})',\s*'(0x[0-9a-fA-F]{40})',\s*'([^']+)',\s*(\d+)\]/;
const buildRows = (file) => Object.fromEntries(read(file).split(/\r?\n/).map((line) => line.match(ROW)).filter(Boolean)
  .map(([, name, pox, registry, rpc, chainId]) => [name, { pox, registry, rpc, chainId: Number(chainId) }]));

// The runner of `blockchainNetwork` as ecld-run and the Hello World template
// build it: the address and chain id of the SDK's network table, then the
// (network, type) the table names. Its wallet is on `chainId`; its events are
// discarded and its image registry is bound without the read of the enclave's
// details.
const runnerFor = async (blockchainNetwork, chainId) => {
  const { network: found } = network.networkFor(runnerEnums, blockchainNetwork);
  assert.ok(found, blockchainNetwork);
  const provider = { getNetwork: async () => ({ chainId: BigInt(chainId) }) };
  const runner = new EthernityCloudRunner(found.address, { provider }, found.chainId);
  runner.dispatchECEvent = () => {};
  runner.getEnclaveDetails = async () => {};
  if (found.unsafe) await runner.setNetwork(...found.unsafe);
  if (found.pox10) await runner.setNetwork(...found.pox10);
  await runner.resolveNetworkContext();
  return runner;
};

const SERVICE_TYPES = ['Nodenithy', 'Pynithy'];

test('on every network ecld-init offers, the runner the SDK constructs is on the PoX and image registry the build bakes', async () => {
  const rows = buildRows('../nodenithy/build.mjs');
  for (const option of init.NETWORK_OPTIONS) {
    const blockchainNetwork = option.replace(/ /g, '_');
    for (const serviceType of SERVICE_TYPES) {
      const image = init.trustedZoneImageFor(option, serviceType);
      const row = rows[image];
      assert.ok(row, `${image} has no build row`);
      const runner = await runnerFor(blockchainNetwork, row.chainId);
      const label = `${blockchainNetwork} ${image}`;
      assert.equal(runner.networkConfig.protocolAddress, row.pox, label);
      assert.equal(runner.protocolContract.getContract().target, row.pox, label);
      await runner.initializeImageRegistry('a-securelock');
      assert.equal(runner.imageRegistryContract.getContract().target, row.registry, label);
      assert.equal(runner.networkConfig.networkName, runnerEnums.ECNetworkByChainIdDictionary[row.chainId], label);
      assert.equal(runner.isMainnet(), casConfig.isMainnetNetwork(blockchainNetwork), label);
      assert.equal(runner.isUnsafe(), casConfig.isUnsafeNetwork(blockchainNetwork), label);
      // The runner takes the trustedzone ecld-init wrote for the network.
      assert.doesNotThrow(() => runner.selectTrustedZone(image), label);
    }
  }
});

test('Polygon Amoy\'s two networks share the constructor address and nothing else', async () => {
  const pox20 = network.networkFor(runnerEnums, 'Polygon_Amoy_Testnet').network;
  const pox10 = network.networkFor(runnerEnums, 'Polygon_Amoy_Pox10').network;
  assert.equal(pox10.address, pox20.address);
  assert.equal(pox20.pox10, undefined);
  assert.deepEqual(pox10.pox10, ['POLYGON', 'TESTNET_POX10']);

  const onPox20 = await runnerFor('Polygon_Amoy_Testnet', 80002);
  const onPox10 = await runnerFor('Polygon_Amoy_Pox10', 80002);
  assert.equal(onPox20.protocolContract.getContract().target, '0xd1182deA61CDa785C320cdBE5888EaC4178cAAF2');
  assert.equal(onPox10.protocolContract.getContract().target, '0x9Aad82557c84c11C4031382d8Bf2cacF8f256a02');
  await onPox20.initializeImageRegistry('a-securelock');
  await onPox10.initializeImageRegistry('a-securelock');
  assert.equal(onPox20.imageRegistryContract.getContract().target, '0x0C0f52ebd72cd2d2cBe94F385c9e23cec528b706');
  assert.equal(onPox10.imageRegistryContract.getContract().target, '0xa2EE2a9118d0011AF05a6196c862D37d8c29F8eC');
  // Each runs its own trustedzones and refuses the other's.
  for (const kind of ['nodenithy', 'pynithy']) {
    assert.doesNotThrow(() => onPox20.selectTrustedZone(`ecld-${kind}-amoy`));
    assert.doesNotThrow(() => onPox10.selectTrustedZone(`ecld-${kind}-amoy-pox10`));
    assert.throws(() => onPox20.selectTrustedZone(`ecld-${kind}-amoy-pox10`), /is a trustedzone of the PoX 1\.0 network POLYGON TESTNET_POX10/);
    assert.throws(() => onPox10.selectTrustedZone(`ecld-${kind}-amoy`), /^Error: POLYGON TESTNET_POX10 runs only its PoX 1\.0 trustedzones/);
  }
});

test('the bloxberg PoX 1.0 network has its own constructor address: the copy\'s PoX, which is its token', async () => {
  const pox20 = network.networkFor(runnerEnums, 'Bloxberg_Testnet').network;
  const pox10 = network.networkFor(runnerEnums, 'Bloxberg_Testnet_Pox10').network;
  assert.equal(pox10.address, '0x69A7bEB5Da2d3dA711d52E491D71e51296b08745');
  assert.notEqual(pox10.address, pox20.address);
  assert.deepEqual(pox10.pox10, ['BLOXBERG', 'TESTNET_POX10']);
  const runner = await runnerFor('Bloxberg_Testnet_Pox10', 8995);
  assert.equal(runner.tokenContract.contractAddress(), '0x69A7bEB5Da2d3dA711d52E491D71e51296b08745');
  assert.equal(runner.protocolContract.getContract().target, '0x69A7bEB5Da2d3dA711d52E491D71e51296b08745');
});

test('both builds bake the runner\'s PoX, image registry and chain into a PoX 1.0 securelock', () => {
  const families = [
    ['etny', 'testnet-pox10', 'BLOXBERG', 'https://bloxberg.ethernity.cloud'],
    ['ecld', 'amoy-pox10', 'POLYGON', 'https://polygon-amoy-bor-rpc.publicnode.com']
  ];
  for (const file of ['../nodenithy/build.mjs', '../pynithy/build.mjs']) {
    const rows = buildRows(file);
    for (const [prefix, suffix, key, rpc] of families) {
      const descriptor = runnerEnums.ECPox10TestnetConfig[key];
      for (const kind of ['pynithy', 'nodenithy']) {
        const name = `${prefix}-${kind}-${suffix}`;
        assert.equal(name, runnerEnums.ECRunner[key][`${kind.toUpperCase()}_RUNNER_TESTNET_POX10`]);
        assert.deepEqual(rows[name], {
          pox: descriptor.protocolAddress,
          registry: descriptor.imageRegistry[kind.toUpperCase()],
          rpc,
          chainId: runnerEnums.ECNetworkByChainId[key].TESTNET_POX10
        }, `${file} ${name}`);
        // No ethernity-cas registry is baked or consulted for the template.
        assert.equal(casConfig.VALIDATOR_REGISTRY[name], undefined, name);
        assert.equal(casConfig.SESSION_REGISTRY[name], undefined, name);
        assert.equal(casConfig.CHAIN[name], undefined, name);
      }
    }
  }
});

test('a PoX 1.0 securelock is built as a mainnet one: enclave network type "mainnet", signed --production', () => {
  for (const name of ['Bloxberg_Testnet_Pox10', 'Polygon_Amoy_Pox10']) {
    assert.equal(casConfig.isScontainCasNetwork(name), true, name);
    assert.equal(casConfig.isMainnetNetwork(name), false, name);
    assert.equal(casConfig.isTestnetNetwork(name), false, name);
    assert.equal(casConfig.isUnsafeNetwork(name), false, name);
  }
  for (const kind of ['nodenithy', 'pynithy']) {
    const build = read(`../${kind}/build.mjs`);
    assert.match(build, /const scontainCas = casConfig\.isScontainCasNetwork\(process\.env\.BLOCKCHAIN_NETWORK\);/, kind);
    assert.match(build, /\.replace\(\/__NETWORK_TYPE__\/g, scontainCas \? 'mainnet' : 'testnet'\)/, kind);
    assert.match(build, /casConfig\.casProvisioned\(templateName, scontainCas\)/, kind);
    assert.doesNotMatch(build, /isMainnet/, kind);
  }
  // Signed --production follows from casProvisioned, which holds on these networks.
  assert.equal(casConfig.casProvisioned('etny-nodenithy-testnet-pox10', true), true);
  assert.equal(casConfig.casProvisioned('ecld-pynithy-amoy-pox10', true), true);
});

test('a PoX 1.0 publish posts the session to the Scontain CAS and names the trustedzone session the image registry records', () => {
  for (const kind of ['nodenithy', 'pynithy']) {
    const run = read(`../${kind}/run.js`);
    assert.match(run, /const scontainCas = casConfig\.isScontainCasNetwork\(process\.env\.BLOCKCHAIN_NETWORK\);/, kind);
    assert.match(run, /const cas = casConfig\.casProvisioned\(templateName, scontainCas\);/, kind);
    assert.match(run, /const casTestnet = !scontainCas && cas;/, kind);
    assert.match(run, /const pox10 = casConfig\.isPox10TestnetNetwork\(process\.env\.BLOCKCHAIN_NETWORK\);/, kind);
    assert.doesNotMatch(run, /isMainnet/, kind);
    // The session is read where a validator set attests the network and on a
    // PoX 1.0 testnet network; a mainnet's compose keeps the published name.
    assert.match(run, /if \(casTestnet \|\| pox10\) \{\s+trustedZoneSession = execSync\(`node \.\/image_registry\.js "\$\{process\.env\.BLOCKCHAIN_NETWORK\}" \$\{templateName\} "v3" "getTrustedZoneSession"`\)/, kind);
    assert.ok(run.includes(`const ENCLAVE_NAME_TRUSTEDZONE = trustedZoneSession || 'ecld-${kind}-trustedzone-v3-3.0.0';`), kind);
    // The validator set's CAS replaces scone-cas.cf on a CAS-attested testnet alone.
    assert.match(run, /if \(casTestnet\) \{\s+const fileCasAddr = file === 'docker-compose-final\.yml' \? publishedCasAddr : casAddr;/, kind);
    assert.match(run, /\} else if \(!casTestnet\) \{/, kind);
    assert.match(run, /axios\.post\('https:\/\/scone-cas\.cf:8081\/session'/, kind);
  }
});

test('the session tag and the extraction service name of a PoX 1.0 network are its word, unlike any published network\'s', () => {
  const published = init.NETWORK_OPTIONS.map((option) => option.replace(/ /g, '_'))
    .filter((name) => !casConfig.isPox10TestnetNetwork(name));
  const publishedTags = published.map((name) => casConfig.sessionTag(name));
  for (const [name, word] of Object.entries(casConfig.POX10_TESTNETS)) {
    assert.equal(name.toLowerCase(), word);
    assert.equal(casConfig.sessionTag(name), word);
    assert.equal(casConfig.sessionTag(name.toUpperCase()), word);
    assert.equal(casConfig.extractionNetwork(name), word);
    assert.ok(!publishedTags.includes(word), word);
    // ENCLAVE_NAME_SECURELOCK as both builds form it.
    const session = `demo-SECURELOCK-V3-${casConfig.sessionTag(name)}-v3`.replace(/\//g, '_').replace(/-/g, '_');
    assert.equal(session, `demo_SECURELOCK_V3_${word}_v3`);
  }
});

test('the Hello World template names the PoX 1.0 network on the runner, in both templates', () => {
  const preStart = ['nodenithy', 'pynithy'].map((kind) => read(`../${kind}/src/preStart.mjs`));
  assert.equal(preStart[0], preStart[1]);
  assert.match(preStart[0], /^ {2}POX10_NETWORK: network\.pox10 \|\| null,$/m);
  assert.match(preStart[0], /^ {2}UNSAFE_NETWORK: network\.unsafe \|\| null,$/m);
  for (const kind of ['nodenithy', 'pynithy']) {
    const example = read(`../${kind}/src/ec_helloworld_example.js`);
    assert.match(example, /^const POX10_NETWORK = null;$/m, kind);
    assert.match(example, /^const UNSAFE_NETWORK = null;$/m, kind);
    assert.match(example, /if \(POX10_NETWORK\) \{\s+await runner\.setNetwork\(\.\.\.POX10_NETWORK\);\s+\}/, kind);
  }
  const ecldRun = read('../run.js');
  assert.match(ecldRun, /if \(network\.unsafe\) await runner\.setNetwork\(\.\.\.network\.unsafe\);\s+if \(network\.pox10\) await runner\.setNetwork\(\.\.\.network\.pox10\);/);
});

test('the SDK depends on a runner that carries the PoX 1.0 testnet networks', () => {
  const range = JSON.parse(read('../package.json')).dependencies['@ethernity-cloud/runner'];
  const lowest = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  assert.ok(lowest, range);
  const [major, minor, patch] = lowest.slice(1).map(Number);
  assert.ok(major > 0 || minor > 6 || (minor === 6 && patch >= 36), range);
  assert.equal(runnerEnums.POX10_TESTNET_TYPE, 'TESTNET_POX10');
});
