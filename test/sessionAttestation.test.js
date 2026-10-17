// A securelock session relaxes attestation, tolerating a debug-signed enclave
// and ignoring every Intel advisory, on a testnet alone: a mainnet, an empty
// BLOCKCHAIN_NETWORK and a name the SDK does not list all get the production
// rules. Both runners fill their session template through sessionAttestation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { TESTNETS, isTestnetNetwork, isMainnetNetwork, sessionAttestation } = require('../cas/config.js');

// The networks ecld-init offers, as it writes BLOCKCHAIN_NETWORK.
const MAINNETS = ['Bloxberg_Mainnet', 'Polygon_Mainnet'];
const OFFERED_TESTNETS = [
  'Bloxberg_Testnet', 'Polygon_Amoy_Testnet', 'IoTeX_Testnet', 'Ethereum_Sepolia', 'LitVM_LiteForge',
  'Bloxberg_Testnet_Unsafe', 'LitVM_LiteForge_Unsafe', 'Ethereum_Sepolia_Unsafe',
];
const PRODUCTION = '[hyperthreading, outdated-tcb, software-hardening-needed]';

test('every network ecld-init offers is exactly one of a mainnet and a testnet', () => {
  for (const n of MAINNETS) {
    assert.ok(isMainnetNetwork(n), n);
    assert.ok(!isTestnetNetwork(n), n);
  }
  for (const n of OFFERED_TESTNETS) {
    assert.ok(isTestnetNetwork(n), n);
    assert.ok(!isMainnetNetwork(n), n);
  }
  assert.deepEqual([...TESTNETS].sort(), [...OFFERED_TESTNETS].sort());
});

test('a testnet session tolerates debug-mode and ignores every advisory, however its name is cased', () => {
  for (const n of OFFERED_TESTNETS) {
    for (const spelled of [n, n.toUpperCase(), n.toLowerCase()]) {
      const a = sessionAttestation(spelled);
      assert.equal(a.tolerate, '[hyperthreading, outdated-tcb, software-hardening-needed, debug-mode]', spelled);
      assert.equal(a.ignoreAdvisories, '["*"]', spelled);
    }
  }
});

test('a mainnet, an empty network and an unlisted name get no debug-mode and one ignored advisory', () => {
  for (const n of [...MAINNETS, '', undefined, null, 'Ethereum_Mainnet', 'LitVM_Mainnet', 'Bloxberg Testnet', ' Bloxberg_Testnet']) {
    const a = sessionAttestation(n);
    assert.equal(a.tolerate, PRODUCTION, String(n));
    assert.doesNotMatch(a.tolerate, /debug/, String(n));
    assert.equal(a.ignoreAdvisories, '["INTEL-SA-00615"]', String(n));
  }
});

test('both runners fill the session template from sessionAttestation alone', () => {
  for (const runner of ['pynithy', 'nodenithy']) {
    const src = fs.readFileSync(path.join(__dirname, '..', runner, 'run.js'), 'utf8');
    assert.match(src, /casConfig\.sessionAttestation\(process\.env\.BLOCKCHAIN_NETWORK\)/, runner);
    assert.match(src, /\.replace\(\/__TOLERATE__\/g, attestation\.tolerate\)/, runner);
    assert.match(src, /\.replace\(\/__IGNORE_ADVISORIES__\/g, attestation\.ignoreAdvisories\)/, runner);
    assert.doesNotMatch(src, /debug-mode/, `${runner}/run.js carries no tolerate list of its own`);
    const tpl = fs.readFileSync(path.join(__dirname, '..', runner, 'run', 'etny-securelock-test.yaml.tpl'), 'utf8');
    assert.match(tpl, /tolerate: __TOLERATE__/, runner);
    assert.match(tpl, /ignore_advisories: __IGNORE_ADVISORIES__/, runner);
  }
});
