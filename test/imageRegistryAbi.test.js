// nodenithy/run/image_registry.abi and pynithy/run/image_registry.abi, the ABI
// ecld-publish calls the image registry with (run/image_registry.js), are
// byte-identical copies of pox-smart-contract-litvm's abi/ECImageRegistryV4.json
// at SOURCE_COMMIT: every function, event and error of ECImageRegistryV4,
// whose earlier registries' functions (registerImage, setImageCert,
// addImage, addTrustedZoneImage, imageDetails, ...) it holds under the same
// signatures. Each entry's selector or topic0 is the one
// test/fixtures/abi-selectors.json lists for ECImageRegistryV4.json, and that
// file lists no entry the copy lacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { LITVM_ENV, SOURCE_COMMIT, litvmCheckout, shownAt } = require('./helpers/litvmCheckout');

const ROOT = path.join(__dirname, '..');
const COPIES = ['nodenithy/run/image_registry.abi', 'pynithy/run/image_registry.abi'];
const SOURCE = 'abi/ECImageRegistryV4.json';
const SELECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'abi-selectors.json'), 'utf8'));
const ROWS = SELECTORS.entries.filter((e) => e.abi === 'ECImageRegistryV4.json');

const read = (file) => fs.readFileSync(path.join(ROOT, file));

// The (kind, name, signature, value) of every function, event and error of
// `abi`: a function's and an error's selector, an event's topic0.
function selectorsOf(abi) {
  const iface = new ethers.utils.Interface(abi);
  const rows = [];
  for (const f of Object.values(iface.functions)) rows.push(['function', f.name, f.format(), iface.getSighash(f)]);
  for (const e of Object.values(iface.events)) rows.push(['event', e.name, e.format(), iface.getEventTopic(e)]);
  for (const e of Object.values(iface.errors)) rows.push(['error', e.name, e.format(), iface.getSighash(e)]);
  return rows.map((r) => r.join(' ')).sort();
}

test('the two run ABI copies are identical', () => {
  assert.ok(read(COPIES[0]).equals(read(COPIES[1])));
});

test('every entry of the run ABI has the selector abi-selectors.json lists, and it lists none the ABI lacks', () => {
  const listed = ROWS.map((e) => [e.kind, e.name, e.signature, e.kind === 'event' ? e.topic0 : e.selector].join(' ')).sort();
  assert.equal(ROWS.length, 92);
  for (const copy of COPIES) {
    assert.deepEqual(selectorsOf(JSON.parse(read(copy).toString('utf8'))), listed, copy);
  }
});

test('the functions ecld-publish calls are in the run ABI', () => {
  const iface = new ethers.utils.Interface(JSON.parse(read(COPIES[0]).toString('utf8')));
  for (const name of ['registerImage', 'setImageCert', 'imageEpcUnits', 'setImageEpcUnits', 'seedingOpen',
    'imageDetails', 'getImageCertPublicKey', 'imageNameOwner', 'allowedWallets']) {
    assert.ok(iface.getFunction(name), name);
  }
  assert.ok(iface.getError('SeedingOpen') && iface.getError('ImageEpcRefused'));
});

test('the run ABI copies are the source commit\'s ECImageRegistryV4 ABI', (t) => {
  const checkout = litvmCheckout();
  if (checkout === null) {
    t.skip(`no pox-smart-contract-litvm checkout found (set ${LITVM_ENV})`);
    return;
  }
  const source = shownAt(checkout, SOURCE);
  assert.ok(source !== null, `${checkout} holds no ${SOURCE_COMMIT}:${SOURCE}`);
  for (const copy of COPIES) {
    assert.ok(read(copy).equals(source), `${copy} differs from ${SOURCE_COMMIT}:${SOURCE}`);
  }
});
