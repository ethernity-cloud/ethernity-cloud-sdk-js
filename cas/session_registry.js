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
const crypto = require('crypto');
const axios = require('axios');
const { ethers } = require('ethers');
const { revertReason } = require('../revert.js');

// `latest` and `record` name a version by its record key: a record id
// (keccak256(abi.encode(name, sessionHash))), or the body's hash on the
// registries that key records by it. The record holds the body's hash on both.
const ABI = [
  'function register(bytes32 sessionHash, string name, string bodyCid, string imageCid, uint8 hashAlgo, (string[] tolerate, string[] ignoreAdvisories, string[] mrenclaves, uint16 minIsvSvn, bool debugAllowed, bool skipQuoteVerification) rulesIn) returns (uint32)',
  'function latest(string name) view returns (bytes32)',
  'function record(bytes32 id) view returns (bytes32 sessionHash, address creator, string enclaveName, uint32 version, string bodyCid, string imageCid, uint8 hashAlgo, uint64 registeredAt, bool exists)',
  'function linkImage(bytes32 id, string imageCid)',
  'error NotCreator(address creator, address caller)',
  'error DuplicateSession(bytes32 recordId)',
  'error NotImageNameOwner(string project, address nameOwner, address caller)',
  'error NotAllowedPublisher(address caller)',
  'error AmbiguousSecurelockName(string name)',
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

function sessionHash(body) {
  return '0x' + crypto.createHash('sha256').update(body).digest('hex');
}

// Pin the exact bytes as CIDv1/raw/sha2-256 and return the CID.
async function pinBody(ipfsApiUrl, body) {
  const form = new FormData();
  form.append('file', new Blob([body]), 'session');
  const r = await axios.post(`${ipfsApiUrl}/api/v0/add?cid-version=1&raw-leaves=true&pin=true`, form, { timeout: 60000 });
  return r.data.Hash;
}

function contract(rpcUrl, registryAddress, key) {
  const provider = new ethers.providers.JsonRpcProvider({ url: rpcUrl, timeout: 30000 });
  const signer = key ? new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`, provider) : provider;
  return new ethers.Contract(registryAddress, ABI, signer);
}

// The latest version of `name`: {id, hash, creator}, or null when it has none.
async function latestRecord(reg, name) {
  const id = await reg.latest(name);
  if (/^0x0+$/.test(id)) return null;
  const rec = await reg.record(id);
  return { id, hash: rec.sessionHash.toLowerCase(), creator: rec.creator };
}

// Send `method(...args)` to the registry. It is simulated first, so a call
// the registry refuses stops with the registry's reason (`refused` names the
// call), then sent with its gas estimate plus 30%: a registration's cost
// grows with the length of the name.
async function send(reg, chainId, refused, method, ...args) {
  try {
    await reg.callStatic[method](...args);
  } catch (e) {
    throw new Error(`SessionRegistry refuses ${refused}: ${revertReason(e, reg.interface)}`);
  }
  const gas = await reg.estimateGas[method](...args);
  const tx = await reg[method](...args, {
    gasLimit: gas.mul(13).div(10), gasPrice: ethers.utils.parseUnits('1', 'mwei'), chainId,
  });
  const rcpt = await tx.wait();
  if (rcpt.status !== 1) throw new Error(`SessionRegistry.${method} reverted for ${refused} (tx ${tx.hash})`);
}

// Pin `body` and register it under its own `name:`. Returns
// {name, hash, cid, registered}: `registered` is false when the chain already
// held these exact bytes as the name's latest version, registered by this
// wallet.
async function register(rpcUrl, chainId, registryAddress, key, body, ipfsApiUrl, imageCid = '') {
  const { name, rules } = parseNameAndRules(body.toString('utf8'));
  if (!name) throw new Error('the session body has no `name:`');
  const hash = sessionHash(body);
  const reg = contract(rpcUrl, registryAddress, key);
  const cid = await pinBody(ipfsApiUrl, body);
  const latest = await latestRecord(reg, name);
  if (latest && latest.hash === hash && latest.creator.toLowerCase() === (await reg.signer.getAddress()).toLowerCase()) {
    return { name, hash, cid, registered: false };
  }
  await send(reg, chainId, name, 'register', hash, name, cid, imageCid, HASH_ALGO_SHA256, rules);
  return { name, hash, cid, registered: true };
}

// Point the name's latest version at the published image CID.
async function linkImage(rpcUrl, chainId, registryAddress, key, name, imageCid) {
  const reg = contract(rpcUrl, registryAddress, key);
  const latest = await latestRecord(reg, name);
  if (!latest) throw new Error(`no registered session named ${name}`);
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
