// cas/session_registry.js register, ecld-publish's registration of a
// securelock session, against a JSON-RPC stand-in of one SessionRegistry and
// an IPFS add stand-in on the loopback. The registry answers its `rules` in
// one form: the flat form (one measurement list, and RULES_FORM() reverting,
// as the deployed registries answer) or the per-service form (a list per
// service, RULES_FORM() 2, ethernity-cas contracts/SessionRegistry.sol).
// register takes the form the caller names (cas/config.js
// SESSION_RULES_FORM, 1 for every registry listed there): it posts the body's
// measurements as the one list of the flat form, exactly as before, or each
// service of the body's `services:` with its own list in the per-service
// form; and it throws before it pins the body when the registry's
// RULES_FORM() states another form, or when the form named is neither.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ethers } = require('ethers');
const sessionRegistry = require('../cas/session_registry.js');
const { SESSION_REGISTRY, SESSION_RULES_FORM } = require('../cas/config.js');

const REGISTRY = '0x00000000000000000000000000000000000000aa';
// Hardhat's first default account (the mnemonic "test test ... junk").
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const MR_A = 'aa'.repeat(32);
const MR_B = 'bb'.repeat(32);
const MR_C = 'cc'.repeat(32);
const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'nodenithy', 'run', 'etny-securelock-test.yaml.tpl'), 'utf8');

const RULES_FLAT = '(string[] tolerate, string[] ignoreAdvisories, string[] mrenclaves, uint16 minIsvSvn, bool debugAllowed, bool skipQuoteVerification)';
const RULES_PER_SERVICE = '(string[] tolerate, string[] ignoreAdvisories, (string name, string[] mrenclaves)[] services, uint16 minIsvSvn, bool debugAllowed, bool skipQuoteVerification)';
// The SessionRegistry of each form as register calls it.
const registryOf = (rules) => new ethers.utils.Interface([
  `function register(bytes32 sessionHash, string name, string bodyCid, string imageCid, uint8 hashAlgo, ${rules} rulesIn) returns (uint32 version)`,
  'function latest(string name) view returns (bytes32)',
  'function record(bytes32 id) view returns (bytes32 sessionHash, address creator, string enclaveName, uint32 version, string bodyCid, string imageCid, uint8 hashAlgo, uint64 registeredAt, bool exists)',
  'function RULES_FORM() view returns (uint8)',
]);
const IFACE = { 1: registryOf(RULES_FLAT), 2: registryOf(RULES_PER_SERVICE) };
const REVERT = { code: 3, message: 'execution reverted', data: '0x' };

// A securelock session body for `name` listing the measurements `mrs`, as
// run.js renders the template.
function securelockBody(name, mrs) {
  return Buffer.from(TEMPLATE.replace('__PREDECESSOR__', '').replace('__MRENCLAVE__', mrs.join('", "'))
    .replaceAll('__ENCLAVE_NAME__', name).replace('__TOLERATE__', '[hyperthreading, outdated-tcb]')
    .replace('__IGNORE_ADVISORIES__', '["*"]').replace('__NODE_FLAGS__', '').replace('__ESR_ENVIRONMENT__', '# ESR not enabled'));
}

// A body of two services, the second's measurements listed with a repeat,
// and an image entry and an environment key whose `name:` is no service's.
const twoServices = (name) => Buffer.from(`name: ${name}
security:
  attestation:
    tolerate: [hyperthreading]
    ignore_advisories: ["*"]
services:
   - name: application
     mrenclaves: [ "${MR_A}" ]
     environment:
        name: not-a-service
   - name: executor
     mrenclaves: [ "${MR_B}", "${MR_C}", "${MR_B}" ]
images:
   - name: application_image
`);

// The stand-in: a SessionRegistry at REGISTRY in rules form `state.form`
// holding no version, recording the registrations sent to it (`state.sent`,
// each decoded) and the IPFS adds (`state.adds`).
const state = { form: 1, sent: [], adds: 0 };

function answer(method, params) {
  const iface = IFACE[state.form];
  switch (method) {
    case 'eth_chainId': return '0x7a69';
    case 'net_version': return '31337';
    case 'eth_gasPrice': return '0x3b9aca00';
    case 'eth_estimateGas': return '0x100000';
    case 'eth_getTransactionCount': return '0x0';
    case 'eth_blockNumber': return '0x1';
    case 'eth_call': {
      const { data } = params[0];
      const call = iface.parseTransaction({ data });
      if (call.name === 'RULES_FORM') {
        if (state.form === 1) throw REVERT;
        return iface.encodeFunctionResult('RULES_FORM', [2]);
      }
      if (call.name === 'latest') return iface.encodeFunctionResult('latest', [ethers.constants.HashZero]);
      if (call.name === 'register') return iface.encodeFunctionResult('register', [1]);
      throw new Error(`no answer for ${call.name}`);
    }
    case 'eth_sendRawTransaction': {
      const tx = ethers.utils.parseTransaction(params[0]);
      assert.equal(tx.to.toLowerCase(), REGISTRY);
      state.sent.push(iface.parseTransaction({ data: tx.data }));
      return tx.hash;
    }
    case 'eth_getTransactionReceipt':
      return {
        transactionHash: params[0], transactionIndex: '0x0', blockHash: `0x${'11'.repeat(32)}`, blockNumber: '0x1',
        from: ethers.utils.computeAddress(KEY), to: REGISTRY, cumulativeGasUsed: '0x1', gasUsed: '0x1',
        effectiveGasPrice: '0x1', contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x1', type: '0x0',
      };
    case 'eth_getTransactionByHash': return null;
    case 'eth_getBlockByNumber':
      return {
        number: '0x1', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'00'.repeat(32)}`, timestamp: '0x1',
        nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0',
        miner: ethers.constants.AddressZero, extraData: '0x', transactions: [],
      };
    default: throw new Error(`no answer for ${method}`);
  }
}

let server;
let url;
test.before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/api/v0/add')) {
        state.adds += 1;
        res.end(JSON.stringify({ Hash: CID }));
        return;
      }
      const body = JSON.parse(raw);
      const one = (call) => {
        try {
          return { jsonrpc: '2.0', id: call.id, result: answer(call.method, call.params) };
        } catch (e) {
          return { jsonrpc: '2.0', id: call.id, error: e === REVERT ? REVERT : { code: -32000, message: String(e.message) } };
        }
      };
      res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

// register of `body` in rules form `rulesForm` against a registry in form
// `registryForm`, the stand-in's record reset first.
function register(body, rulesForm, registryForm) {
  Object.assign(state, { form: registryForm, sent: [], adds: 0 });
  return sessionRegistry.register(url, 31337, REGISTRY, rulesForm, KEY, body, url);
}

test('register posts each service of the body with its own measurements to a registry of the per-service form under form 2', async () => {
  const done = await register(twoServices('demo_SECURELOCK_amoy'), 2, 2);
  assert.deepEqual([done.name, done.cid, done.registered], ['demo_SECURELOCK_amoy', CID, true]);
  assert.equal(state.adds, 1);
  assert.equal(state.sent.length, 1);
  const call = state.sent[0];
  assert.equal(call.signature, 'register(bytes32,string,string,string,uint8,(string[],string[],(string,string[])[],uint16,bool,bool))');
  const rules = call.args.rulesIn;
  assert.deepEqual(rules.services.map((s) => [s.name, [...s.mrenclaves]]), [['application', [MR_A]], ['executor', [MR_B, MR_C]]]);
  assert.deepEqual([...rules.tolerate], ['hyperthreading']);
  assert.deepEqual([...rules.ignoreAdvisories], ['*']);
});

test('register posts the securelock session as one service, application, under form 2', async () => {
  await register(securelockBody('demo_SECURELOCK_amoy', [MR_A, MR_B]), 2, 2);
  const rules = state.sent[0].args.rulesIn;
  assert.deepEqual(rules.services.map((s) => [s.name, [...s.mrenclaves]]), [['application', [MR_A, MR_B]]]);
  assert.deepEqual([...rules.tolerate], ['hyperthreading', 'outdated-tcb']);
});

test('register posts the one list of the flat form, as before, to a registry of the flat rules under form 1', async () => {
  const done = await register(twoServices('demo_SECURELOCK_amoy'), 1, 1);
  assert.equal(done.registered, true);
  const call = state.sent[0];
  assert.equal(call.signature, 'register(bytes32,string,string,string,uint8,(string[],string[],string[],uint16,bool,bool))');
  assert.deepEqual([...call.args.rulesIn.mrenclaves], [MR_A, MR_B, MR_C]);
  const flat = sessionRegistry.parseNameAndRules(twoServices('demo_SECURELOCK_amoy').toString('utf8')).rules;
  assert.deepEqual([...call.args.rulesIn.mrenclaves], flat.mrenclaves);
});

test('register throws before it pins the body when the registry states another form, or when the form named is neither', async () => {
  for (const [rulesForm, registryForm] of [[2, 1], [1, 2]]) {
    await assert.rejects(register(securelockBody('demo_SECURELOCK_amoy', [MR_A]), rulesForm, registryForm),
      new RegExp(`answers rules form ${registryForm}, not the configured ${rulesForm}`));
    assert.equal(state.adds, 0, 'nothing pinned');
    assert.equal(state.sent.length, 0, 'nothing sent');
  }
  for (const rulesForm of [undefined, 0, 3, '2']) {
    await assert.rejects(register(securelockBody('demo_SECURELOCK_amoy', [MR_A]), rulesForm, 2),
      /is not a form of a SessionRegistry's rules/);
    assert.equal(state.adds, 0);
  }
});

test('cas/config.js names the rules form, 1, of every SessionRegistry it lists, and no other', () => {
  assert.deepEqual(Object.keys(SESSION_RULES_FORM).sort(), Object.keys(SESSION_REGISTRY).sort());
  for (const [template, form] of Object.entries(SESSION_RULES_FORM)) assert.equal(form, 1, template);
});

test('both runners pass the template\'s rules form to register', () => {
  for (const runner of ['nodenithy', 'pynithy']) {
    const src = fs.readFileSync(path.join(__dirname, '..', runner, 'run.js'), 'utf8');
    assert.ok(src.includes('casConfig.SESSION_REGISTRY[templateName],\n            casConfig.SESSION_RULES_FORM[templateName],\n            process.env.PRIVATE_KEY'), runner);
  }
});
