// registryEpc.js against a JSON-RPC stand-in of an image registry on the
// loopback: ECImageRegistryV4 answers imageEpcUnits(ipfsHash) with the EPC
// need it records for a securelock image (0 for none) and takes
// setImageEpcUnits once (pox-smart-contract-litvm ECImageRegistryV4.sol;
// D200, OD24); a registry without the function (V1 to V3) reverts the read,
// the bloxberg node (Parity) answering "Reverted 0x", a geth node "execution
// reverted". ecld-publish (nodenithy/run.js, pynithy/run.js) refuses an
// ECLD_EPC_MIB that is not a whole number of 1 to 4,194,240 MiB at its start,
// and records the need (image_registry.js recordEpcNeed) after the
// registration and before the certificate: a need recorded already that
// differs from the publish's ends the publish.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ethers } = require('ethers');
const { EPC_MAX_MIB, epcUnitsOfSetting, epcStep, recordEpcNeed } = require('../registryEpc.js');

const REGISTRY = '0x00000000000000000000000000000000000000aa';
const HASH = 'QmImage';
const IFACE = new ethers.utils.Interface(['function imageEpcUnits(string ipfsHash) view returns (uint16)']);

// What the stand-in answers imageEpcUnits with: a number, 'geth' (a geth
// revert), 'parity' (the bloxberg node's revert) or 'down' (HTTP 503, no
// JSON-RPC answer).
const state = { answer: 0, reads: [] };

let server;
let url;
test.before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const one = (call) => {
        if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: '0x7a69' };
        if (call.method === 'net_version') return { jsonrpc: '2.0', id: call.id, result: '31337' };
        if (call.method !== 'eth_call') return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'no such method' } };
        assert.equal(call.params[0].to.toLowerCase(), REGISTRY);
        const parsed = IFACE.parseTransaction({ data: call.params[0].data });
        assert.equal(parsed.name, 'imageEpcUnits');
        state.reads.push(parsed.args[0]);
        if (state.answer === 'geth') return { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted', data: '0x' } };
        if (state.answer === 'parity') return { jsonrpc: '2.0', id: call.id, error: { code: -32015, message: 'VM execution error.', data: 'Reverted 0x' } };
        return { jsonrpc: '2.0', id: call.id, result: IFACE.encodeFunctionResult('imageEpcUnits', [state.answer]) };
      };
      if (state.answer === 'down' && !(Array.isArray(body) ? body : [body]).every((c) => c.method !== 'eth_call')) {
        res.writeHead(503);
        res.end('Service Unavailable');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

// recordEpcNeed for a publish of `units` on a registry answering `answer`:
// [what the developer is told, the writes sent].
const record = async (answer, units) => {
  Object.assign(state, { answer, reads: [] });
  const writes = [];
  const told = await recordEpcNeed(new ethers.providers.StaticJsonRpcProvider({ url, timeout: 5000 }, 31337),
    REGISTRY, HASH, units, async (...args) => { writes.push(args); });
  return [told, writes];
};

test('ECLD_EPC_MIB is the need in MiB rounded up to units of 64 MiB, one unit when unset', () => {
  assert.equal(epcUnitsOfSetting(undefined), 1);
  assert.equal(epcUnitsOfSetting(''), 1);
  assert.equal(epcUnitsOfSetting('1'), 1);
  assert.equal(epcUnitsOfSetting('64'), 1);
  assert.equal(epcUnitsOfSetting('65'), 2);
  assert.equal(epcUnitsOfSetting(' 130 '), 3);
  assert.equal(epcUnitsOfSetting(String(EPC_MAX_MIB)), 65535);
});

test('an ECLD_EPC_MIB that is not a whole number of 1 to 4,194,240 is refused', () => {
  for (const text of ['0', '4194241', '-1', '1.5', '0x40', '64M', 'abc']) {
    assert.throws(() => epcUnitsOfSetting(text),
      /ECLD_EPC_MIB is the EPC the securelock needs, in MiB: a whole number of 1 to 4194240/, text);
  }
});

test('a need above one unit is written once on a registry that records none', async () => {
  const [told, writes] = await record(0, 3);
  assert.deepEqual(writes, [['setImageEpcUnits', HASH, 3]]);
  assert.deepEqual(state.reads, [HASH]);
  assert.equal(told, `The EPC need of ${HASH} is recorded: 3 units of 64 MiB (192 MiB).`);
});

test('a need of one unit records none', async () => {
  assert.deepEqual(await record(0, 1), ['', []]);
});

test('a need recorded already and equal to the publish\'s is left as it is', async () => {
  const [told, writes] = await record(3, 3);
  assert.deepEqual(writes, []);
  assert.equal(told, `The EPC need of ${HASH} is recorded: 3 units of 64 MiB.`);
});

test('a need recorded already that differs from the publish\'s ends the publish and writes nothing', async () => {
  for (const [recorded, units] of [[3, 2], [3, 4], [5, 1]]) {
    Object.assign(state, { answer: recorded, reads: [] });
    const writes = [];
    await assert.rejects(
      recordEpcNeed(new ethers.providers.StaticJsonRpcProvider({ url, timeout: 5000 }, 31337), REGISTRY, HASH, units,
        async (...args) => { writes.push(args); }),
      (e) => e.message === `the image registry ${REGISTRY} records an EPC need of ${recorded} units of 64 MiB `
        + `(${recorded * 64} MiB) for ${HASH}, and this publish states ${units} (${units * 64} MiB, ECLD_EPC_MIB): `
        + `the need is written once. Set ECLD_EPC_MIB to ${recorded * 64}, or publish a new image.`);
    assert.deepEqual(writes, []);
  }
});

test('a registry without imageEpcUnits records nothing and the developer is told of a need above one unit', async () => {
  for (const revert of ['geth', 'parity']) {
    const [told, writes] = await record(revert, 3);
    assert.deepEqual(writes, []);
    assert.equal(told, `The image registry ${REGISTRY} records no EPC need (imageEpcUnits reverts): the need of 3 `
      + 'units of 64 MiB (ECLD_EPC_MIB) is not recorded.');
    assert.deepEqual(await record(revert, 1), ['', []]);
  }
});

test('a read the node does not answer is an error and nothing is written', async () => {
  const writes = [];
  Object.assign(state, { answer: 'down', reads: [] });
  await assert.rejects(recordEpcNeed(new ethers.providers.StaticJsonRpcProvider({ url, timeout: 5000 }, 31337),
    REGISTRY, HASH, 3, async (...args) => { writes.push(args); }));
  assert.deepEqual(writes, []);
});

test('the step of each recorded need', () => {
  assert.deepEqual([epcStep(null, 3), epcStep(0, 3), epcStep(0, 1), epcStep(3, 3), epcStep(1, 1), epcStep(3, 1)],
    ['none', 'write', 'none', 'keep', 'keep', 'stop']);
});

test('both image_registry.js copies hold recordEpcNeed, which exits 1 when the step fails', () => {
  const read = (runner) => fs.readFileSync(path.join(__dirname, '..', runner, 'run', 'image_registry.js'), 'utf8');
  const src = read('nodenithy');
  assert.equal(read('pynithy'), src);
  const action = src.slice(src.indexOf("if (action === 'recordEpcNeed')"), src.indexOf("if (action === 'setImageCert')"));
  assert.ok(action.includes('process.env.IPFS_HASH || "", epcUnitsOfSetting(process.env[EPC_SETTING]),'));
  assert.ok(action.includes("(method, ...args) => imageRegistry.write(method, ...args));"));
  assert.ok(/\} catch \(e\) \{\n\s*console\.error\(`Error: \$\{e\.message\}`\);\n\s*process\.exit\(1\);/.test(action));
});

test('both runners refuse the setting at the start and record the need after the registration, before the certificate', () => {
  for (const runner of ['nodenithy', 'pynithy']) {
    const src = fs.readFileSync(path.join(__dirname, '..', runner, 'run.js'), 'utf8');
    const main = src.indexOf('const main = async () => {');
    const setting = src.indexOf('epcUnitsOfSetting(process.env[EPC_SETTING]);', main);
    assert.ok(setting > src.indexOf('"v3" "checkSeeding"`', main), runner);
    assert.ok(setting < src.indexOf('new LocalKubo(', main) && setting < src.indexOf('new LocalRegistry(', main), runner);
    const steps = [...src.matchAll(/"v3" "recordEpcNeed"`, \{ stdio: 'inherit', env: [^\n]*\);\n\s*\} catch \(e\) \{\n\s*process\.exit\(1\);/g)];
    assert.equal(steps.length, 2, runner);
    const [twoStep, oneStep] = steps.map((m) => m.index);
    assert.ok(twoStep > src.indexOf('"v3" "registerImage"`') && twoStep < src.indexOf('uploadToIpfs();', main), runner);
    assert.ok(twoStep < src.indexOf('"v3" "setImageCert"`'), runner);
    assert.ok(oneStep < src.indexOf('"registerSecureLockImage"`') && oneStep > src.indexOf('registryEnv.IPFS_HASH = process.env.IPFS_HASH;'), runner);
  }
});
