// Register a securelock session ON-CHAIN, in the ethernity-cas SessionRegistry.
//
// On a CAS-attested testnet the CAS is a validator set that reads its sessions
// from the chain and never accepts a POST: the publisher pins the session body
// to IPFS and submits SessionRegistry.register itself, with the wallet that
// owns the ImageRegistry entry. The first registration of a name fixes its
// creator; later versions of the same name must come from that wallet.
//
// The body is pinned as CIDv1/raw/sha2-256, so with hashAlgo 1 the on-chain
// sessionHash and the CID commit to the same digest (sha256 of the exact
// bytes) -- what lets a validator check the body it fetched against the chain
// without trusting the gateway. The same recipe as etny-pynithy's
// v3/run/register_session.py and the Python SDK's session_registry.py.
//
// The rules are posted in the form of the registry's `rules`, which the
// caller names (cas/config.js SESSION_RULES_FORM): 1, the flat form (one
// measurement list for the session), or 2, the per-service form (the
// measurements of each service of the body's `services:`). Before the body is
// pinned, the registry's RULES_FORM() is read (a revert is form 1, the
// registries of the flat form having none), and a registry that states
// another form than the one named stops the registration.
const crypto = require('crypto');
const axios = require('axios');
const { ethers } = require('ethers');
const { isRevert, revertReason } = require('../revert.js');

// The forms of a SessionRegistry's `rules`, numbered as its RULES_FORM()
// numbers them.
const FLAT_FORM = 1;
const PER_SERVICE_FORM = 2;

// The rules struct of each form: the flat form's lists the session's
// measurements (`mrenclaves`), the per-service form's each service's
// (`services`, each a name and its measurements).
const RULES = {
  [FLAT_FORM]: '(string[] tolerate, string[] ignoreAdvisories, string[] mrenclaves, uint16 minIsvSvn, bool debugAllowed, bool skipQuoteVerification)',
  [PER_SERVICE_FORM]: '(string[] tolerate, string[] ignoreAdvisories, (string name, string[] mrenclaves)[] services, uint16 minIsvSvn, bool debugAllowed, bool skipQuoteVerification)',
};

// The SessionRegistry's ABI in rules form `form`. `latest` and `record` name a
// version by its record key: a record id (keccak256(abi.encode(name,
// sessionHash))), or the body's hash on the registries that key records by
// it. The record holds the body's hash on both.
const abiOf = (form) => [
  `function register(bytes32 sessionHash, string name, string bodyCid, string imageCid, uint8 hashAlgo, ${RULES[form]} rulesIn) returns (uint32)`,
  'function latest(string name) view returns (bytes32)',
  'function record(bytes32 id) view returns (bytes32 sessionHash, address creator, string enclaveName, uint32 version, string bodyCid, string imageCid, uint8 hashAlgo, uint64 registeredAt, bool exists)',
  'function linkImage(bytes32 id, string imageCid)',
  'function RULES_FORM() view returns (uint8)',
  'error NotCreator(address creator, address caller)',
  'error DuplicateSession(bytes32 recordId)',
  'error NotImageNameOwner(string project, address nameOwner, address caller)',
  'error NotAllowedPublisher(address caller)',
  'error AmbiguousSecurelockName(string name)',
  'error EmptyServiceName(uint256 index)',
  'error DuplicateService(string name)',
];

const HASH_ALGO_SHA256 = 1;

function yamlList(text) {
  let t = text.trim();
  if (t.startsWith('[')) {
    const end = t.indexOf(']');
    t = end >= 0 ? t.slice(1, end) : t.slice(1);
  }
  return t.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter((x) => x);
}

// The session's name and the SessionRules the registry stores beside it.
function parseNameAndRules(text) {
  let name = '';
  let tolerate = [], ignoreAdvisories = [], mrenclaves = [];
  let minIsvSvn = 0, debugAllowed = false, skipQuoteVerification = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!name && line.startsWith('name:')) {
      name = line.slice('name:'.length).trim().replace(/^["']|["']$/g, '');
    } else if (line.startsWith('tolerate:')) {
      tolerate = yamlList(line.slice('tolerate:'.length));
      debugAllowed = tolerate.some((t) => t.toLowerCase().includes('debug'));
    } else if (line.startsWith('ignore_advisories:')) {
      ignoreAdvisories = yamlList(line.slice('ignore_advisories:'.length));
    } else if (line.startsWith('mrenclaves:')) {
      for (const m of yamlList(line.slice('mrenclaves:'.length))) {
        if (m && !mrenclaves.includes(m)) mrenclaves.push(m);
      }
    } else if (line.startsWith('isvsvn:') || line.startsWith('min_isvsvn:')) {
      const n = parseInt(line.split(':', 2)[1].trim(), 10);
      if (!Number.isNaN(n)) minIsvSvn = n;
    } else if (line.startsWith('skip_quote_verification:')) {
      skipQuoteVerification = line.slice('skip_quote_verification:'.length).trim().replace(/^["']|["']$/g, '') === 'true';
    }
  }
  return { name, rules: { tolerate, ignoreAdvisories, mrenclaves, minIsvSvn, debugAllowed, skipQuoteVerification } };
}

// The services of the body's top-level `services:` list, in order, each
// {name, mrenclaves}: the `name:` of its entry and the measurements of its
// `mrenclaves:` line, an inline list as parseNameAndRules reads one, each kept
// once. A service without that line admits none. A key of an entry is one at
// the column of the entry's first key; deeper lines are nested values and are
// not read.
function parseServices(text) {
  const services = [];
  let section = null;
  let itemColumn = null;
  let keyColumn = null;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const column = raw.length - raw.trimStart().length;
    if (column === 0) {
      section = line.split(':', 1)[0].trim();
      itemColumn = null;
      keyColumn = null;
      continue;
    }
    if (section !== 'services') continue;
    if (line.startsWith('- ') && (itemColumn === null || itemColumn === column)) {
      itemColumn = column;
      const entry = line.slice(2).trimStart();
      keyColumn = column + line.length - entry.length;
      services.push({ name: '', mrenclaves: [] });
      line = entry;
    } else if (column !== keyColumn || services.length === 0) {
      continue;
    }
    const at = line.indexOf(':');
    const key = (at < 0 ? line : line.slice(0, at)).trim();
    const value = at < 0 ? '' : line.slice(at + 1);
    const service = services[services.length - 1];
    if (key === 'name') {
      service.name = value.trim().replace(/^["']|["']$/g, '');
    } else if (key === 'mrenclaves') {
      for (const m of yamlList(value)) {
        if (m && !service.mrenclaves.includes(m)) service.mrenclaves.push(m);
      }
    }
  }
  return services;
}

// The session's name and the rules `register` takes in rules form `form`: in
// the flat form those of parseNameAndRules; in the per-service form the same
// with the measurement list replaced by the body's services (parseServices).
function rulesOf(text, form) {
  const { name, rules } = parseNameAndRules(text);
  if (form === FLAT_FORM) return { name, rules };
  const { tolerate, ignoreAdvisories, minIsvSvn, debugAllowed, skipQuoteVerification } = rules;
  return {
    name,
    rules: { tolerate, ignoreAdvisories, services: parseServices(text), minIsvSvn, debugAllowed, skipQuoteVerification },
  };
}

function sessionHash(body) {
  return '0x' + crypto.createHash('sha256').update(body).digest('hex');
}

// Pin the exact bytes as CIDv1/raw/sha2-256 and return the CID. `token` is
// the API's Authorization header value (IPFS_TOKEN), sent when set.
async function pinBody(ipfsApiUrl, body, token = '') {
  const form = new FormData();
  form.append('file', new Blob([body]), 'session');
  const headers = token ? { Authorization: token } : {};
  const r = await axios.post(`${ipfsApiUrl}/api/v0/add?cid-version=1&raw-leaves=true&pin=true`, form, { headers, timeout: 60000 });
  return r.data.Hash;
}

// The registry at `registryAddress` in rules form `form`, signing with `key`
// when one is given. The calls of `latest`, `record` and `linkImage` are the
// same in both forms.
function contract(rpcUrl, registryAddress, key, form = FLAT_FORM) {
  const provider = new ethers.providers.JsonRpcProvider({ url: rpcUrl, timeout: 30000 });
  const signer = key ? new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`, provider) : provider;
  return new ethers.Contract(registryAddress, abiOf(form), signer);
}

// The form a rules form names, 1 or 2; throws for any other value.
function formOf(form) {
  if (form === FLAT_FORM || form === PER_SERVICE_FORM) return form;
  throw new Error(`SessionRegistry: ${form} is not a form of a SessionRegistry's rules: 1 is the flat form, 2 the per-service form`);
}

// Throws unless the registry `reg` states rules form `form`: its RULES_FORM()
// answer, or the flat form when that call reverts. An answer that is no form,
// and a read that fails for another reason than a revert, throw too.
async function requireForm(reg, form) {
  let stated;
  try {
    stated = Number(await reg.RULES_FORM());
  } catch (e) {
    if (!isRevert(e)) throw e;
    stated = FLAT_FORM;
  }
  if (stated !== FLAT_FORM && stated !== PER_SERVICE_FORM) {
    throw new Error(`SessionRegistry ${reg.address} answers RULES_FORM ${stated}, which is no form`);
  }
  if (stated !== form) {
    throw new Error(`SessionRegistry ${reg.address} answers rules form ${stated}, not the configured ${form} (SESSION_RULES_FORM)`);
  }
}

// The latest version of `name`: {id, hash, creator}, or null when it has none.
async function latestRecord(reg, name) {
  const id = await reg.latest(name);
  if (/^0x0+$/.test(id)) return null;
  const rec = await reg.record(id);
  return { id, hash: rec.sessionHash.toLowerCase(), creator: rec.creator };
}

// The legacy gas price a registry write is sent with: the chain's eth_gasPrice
// plus 10 %, and 1 mwei at the least. The bloxberg testnet reports 1 mwei;
// Amoy's Bor reports about 30 gwei and refuses a price under its 25 gwei
// minimum tip; LitVM refuses a price under its base fee.
const MIN_GAS_PRICE = ethers.utils.parseUnits('1', 'mwei');
async function gasPrice(provider) {
  const price = (await provider.getGasPrice()).mul(110).div(100);
  return price.gt(MIN_GAS_PRICE) ? price : MIN_GAS_PRICE;
}

// Send `method(...args)` to the registry. It is simulated first, so a call
// the registry refuses stops with the registry's reason (`refused` names the
// call), then sent with its gas estimate plus 30% (a registration's cost
// grows with the length of the name) at the chain's gas price. The wallet
// signs for the chain its RPC serves (ethers takes no chainId override on a
// contract call), so an RPC serving another chain than `chainId` is refused
// before anything is sent.
async function send(reg, chainId, refused, method, ...args) {
  const { chainId: served } = await reg.provider.getNetwork();
  if (served !== chainId) {
    throw new Error(`SessionRegistry: the RPC serves chain ${served}, not ${chainId}`);
  }
  try {
    await reg.callStatic[method](...args);
  } catch (e) {
    throw new Error(`SessionRegistry refuses ${refused}: ${revertReason(e, reg.interface)}`);
  }
  const gas = await reg.estimateGas[method](...args);
  const tx = await reg[method](...args, {
    gasLimit: gas.mul(13).div(10), gasPrice: await gasPrice(reg.provider),
  });
  const rcpt = await tx.wait();
  if (rcpt.status !== 1) throw new Error(`SessionRegistry.${method} reverted for ${refused} (tx ${tx.hash})`);
}

// Pin `body` through `ipfsApiUrl` (with `ipfsToken` as its Authorization
// header when set) and register it under its own `name:`, its rules in the
// registry's rules form `rulesForm` (1 or 2). Returns {name, hash, cid,
// registered}: `registered` is false when the chain already held these exact
// bytes as the name's latest version, registered by this wallet.
async function register(rpcUrl, chainId, registryAddress, rulesForm, key, body, ipfsApiUrl, imageCid = '', ipfsToken = '') {
  const form = formOf(rulesForm);
  const { name, rules } = rulesOf(body.toString('utf8'), form);
  if (!name) throw new Error('the session body has no `name:`');
  const hash = sessionHash(body);
  const reg = contract(rpcUrl, registryAddress, key, form);
  await requireForm(reg, form);
  const cid = await pinBody(ipfsApiUrl, body, ipfsToken);
  const latest = await latestRecord(reg, name);
  if (latest && latest.hash === hash && latest.creator.toLowerCase() === (await reg.signer.getAddress()).toLowerCase()) {
    return { name, hash, cid, registered: false };
  }
  await send(reg, chainId, name, 'register', hash, name, cid, imageCid, HASH_ALGO_SHA256, rules);
  return { name, hash, cid, registered: true };
}

// Point the name's latest version at the published image CID. A node behind
// the chain can answer that a name registered minutes earlier has no record,
// so the name is read again every 15 seconds for `waitMs` before it is called
// unregistered.
async function linkImage(rpcUrl, chainId, registryAddress, key, name, imageCid, waitMs = 600000) {
  const reg = contract(rpcUrl, registryAddress, key);
  const deadline = Date.now() + waitMs;
  let latest = await latestRecord(reg, name);
  while (!latest) {
    if (Date.now() >= deadline) throw new Error(`no registered session named ${name}`);
    await sleep(15000);
    latest = await latestRecord(reg, name);
  }
  await send(reg, chainId, `the link of ${name}`, 'linkImage', latest.id, imageCid);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Block until the chain reports `name`'s latest version at body hash `hash`,
// then hold while the validators pick it up: the elected writer's poll
// (ECAS_SESSION_WATCH_SECS, 60 s) notices the registration and generates the
// secrets, its recordKey transaction confirms, and the other validators' next
// poll adopts the recorded blob. The enclave cannot retry and the validator
// it dials is the node's choice, so the wait covers the LAST validator to
// adopt.
async function waitVisible(rpcUrl, registryAddress, name, hash, timeoutMs = 180000) {
  const reg = contract(rpcUrl, registryAddress, null);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let got;
    try {
      const latest = await latestRecord(reg, name);
      got = latest ? latest.hash : '(none)';
    } catch (e) { got = `(read failed: ${e.message})`; }
    if (got === hash.toLowerCase()) {
      console.log(`\t✔  session ${name} visible on chain at ${got}`);
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`session ${name} did not become visible within ${timeoutMs / 1000}s (chain reports ${got}, expected ${hash})`);
    }
    await sleep(5000);
  }
  const poll = parseInt(process.env.CAS_SESSION_POLL_SECS || '60', 10);
  const hold = 2 * poll + 60;
  console.log(`\t   holding ${hold}s for the CAS validators to generate and mirror it`);
  await sleep(hold * 1000);
}

module.exports = { parseNameAndRules, sessionHash, pinBody, register, linkImage, waitVisible, HASH_ALGO_SHA256 };
