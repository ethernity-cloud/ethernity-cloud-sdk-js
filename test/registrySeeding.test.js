// registrySeeding.js against a JSON-RPC stand-in of an image registry on the
// loopback: ECImageRegistryV4 answers seedingOpen() true while it imports the
// owners of the securelock names and refuses registerImage and addImage with
// SeedingOpen() (pox-smart-contract-litvm ECImageRegistryV4.sol); a registry
// without seeding (V1 to V3) reverts the call, the bloxberg node (Parity)
// answering "Reverted 0x", a geth node "execution reverted". ecld-publish
// reads it first, in both runners (nodenithy/run.js, pynithy/run.js, through
// image_registry.js checkSeeding), and stops before anything is started while
// the registry is seeding or its answer cannot be read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ethers } = require('ethers');
const { seedingOpen, seedingRefusal } = require('../registrySeeding.js');

const REGISTRY = '0x00000000000000000000000000000000000000aa';
const IFACE = new ethers.utils.Interface(['function seedingOpen() view returns (bool)']);

// What the stand-in answers seedingOpen() with: true, false, 'geth' (a geth
// revert), 'parity' (the bloxberg node's revert) or 'down' (HTTP 503, no
// JSON-RPC answer).
const state = { answer: true, calls: 0 };

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
        assert.equal(IFACE.parseTransaction({ data: call.params[0].data }).name, 'seedingOpen');
        state.calls += 1;
        if (state.answer === 'geth') return { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted', data: '0x' } };
        if (state.answer === 'parity') return { jsonrpc: '2.0', id: call.id, error: { code: -32015, message: 'VM execution error.', data: 'Reverted 0x' } };
        return { jsonrpc: '2.0', id: call.id, result: IFACE.encodeFunctionResult('seedingOpen', [state.answer]) };
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

const read = (answer) => {
  Object.assign(state, { answer, calls: 0 });
  return seedingOpen(new ethers.providers.StaticJsonRpcProvider({ url, timeout: 5000 }, 31337), REGISTRY);
};

test('a registry seeding its name owners answers true, one that closed seeding false', async () => {
  assert.equal(await read(true), true);
  assert.equal(state.calls, 1);
  assert.equal(await read(false), false);
});

test('a registry without seedingOpen() takes registrations: a geth revert and the bloxberg node\'s are false', async () => {
  assert.equal(await read('geth'), false);
  assert.equal(await read('parity'), false);
});

test('a read the node does not answer throws: it is not a registry without seeding', async () => {
  await assert.rejects(read('down'));
});

test('the refusal names the registry, seedingOpen() and SeedingOpen()', () => {
  const text = seedingRefusal(REGISTRY);
  assert.ok(text.includes(REGISTRY));
  assert.ok(text.includes('seedingOpen() answers true'));
  assert.ok(text.includes('SeedingOpen()'));
});

test('both image_registry.js copies are one file, whose checkSeeding exits 1 on a seeding registry and on an unread answer', () => {
  const read = (runner) => fs.readFileSync(path.join(__dirname, '..', runner, 'run', 'image_registry.js'), 'utf8');
  const src = read('nodenithy');
  assert.equal(read('pynithy'), src);
  const action = src.slice(src.indexOf("if (action === 'checkSeeding')"), src.indexOf("if (action === 'isV2')"));
  assert.ok(action.includes('seeding = await seedingOpen(imageRegistry.provider, IMAGE_REGISTRY_ADDRESS);'));
  assert.ok(/\} catch \(e\) \{\n[^\n]*is seeding[^\n]*\n\s*process\.exit\(1\);/.test(action));
  assert.ok(/if \(seeding\) \{\n[^\n]*seedingRefusal\(IMAGE_REGISTRY_ADDRESS\)[^\n]*\n\s*process\.exit\(1\);/.test(action));
});

test('both runners read checkSeeding at the start of the publish, before the Kubo or the registry container starts', () => {
  for (const runner of ['nodenithy', 'pynithy']) {
    const src = fs.readFileSync(path.join(__dirname, '..', runner, 'run.js'), 'utf8');
    const main = src.indexOf('const main = async () => {');
    const check = src.indexOf('"v3" "checkSeeding"`');
    assert.ok(main > 0 && check > main, runner);
    assert.ok(check < src.indexOf('new LocalKubo(', main), runner);
    assert.ok(check < src.indexOf('new LocalRegistry(', main), runner);
    assert.ok(/"checkSeeding"`, \{ stdio: 'inherit', env: \{ \.\.\.process\.env, PROJECT_NAME: securelock \} \}\);\n    \} catch \(e\) \{\n        process\.exit\(1\);\n    \}/.test(src), runner);
  }
});
