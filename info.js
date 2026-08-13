#!/usr/bin/env node
/**
 * ecld-info: everything a developer needs to read or troubleshoot an enclave.
 *
 * Read-only and free (eth_call + event logs -- no task, no gas, no private
 * key). Reads your project's identity from .env (PROJECT_NAME / IPFS_HASH /
 * BLOCKCHAIN_NETWORK), then reports:
 *
 *   NETWORK       name, type, chain id, RPC, contract addresses, live block
 *   TRUSTEDZONE   the gatekeeper enclave's Image Registry record
 *   SECURELOCK    the executor enclave's Image Registry record
 *   ESR           registry address, total keys, and -- with --enclave <wallet>
 *                 -- this enclave's recent StateCommitted events
 *
 * Subcommands (default: the full summary):
 *   ecld-info                       full summary
 *   ecld-info network               just the network section
 *   ecld-info trustedzone           just the trustedzone registration
 *   ecld-info securelock            just the securelock registration
 *   ecld-info esr address|count|state|version|list   ESR inspection
 *
 * Registration is keyed by the image's IPFS hash: pass --ipfs <hash> for an
 * exact record, or --name <n> to resolve the latest registered version of a
 * name. With neither, .env IPFS_HASH / PROJECT_NAME are used.
 *
 * Network: --network NAME, else ESR_NETWORK env, else .env BLOCKCHAIN_NETWORK,
 * else BLOXBERG_TESTNET.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

// Authoritative per-network values (mirror of the Python SDK's network table).
const NETWORKS = {
  BLOXBERG_MAINNET: {
    type: 'mainnet', chainId: 8995, rpc: 'https://core.bloxberg.org',
    protocol: '0x549A6E06BB2084100148D50F51CF77a3436C3Ae7',
    imageRegistry: '0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31',
    esr: '0xF76469A5659670B6ade366dE635e6463aaB8f3D8',
  },
  BLOXBERG_TESTNET: {
    type: 'testnet', chainId: 8995, rpc: 'https://core.bloxberg.org',
    protocol: '0x02882F03097fE8cD31afbdFbB5D72a498B41112c',
    imageRegistry: '0x15D73a742529C3fb11f3FA32EF7f0CC3870ACA31',
    esr: '0xda5e68Bb5e68ee14D73b8de2a4D3Ca15736fACfb',
  },
  LITVM_LITEFORGE: {
    type: 'testnet', chainId: 0, rpc: 'https://liteforge.rpc.caldera.xyz/infra-partner-http',
    protocol: '', imageRegistry: '', esr: '0xbAa7F9E3287ff95D177104eD469E6d0Fd19dBB0F',
  },
};

const IMAGE_REGISTRY_ABI = [
  'function imageDetails(string) view returns (address owner, string ipfsHash, string version, string session, uint256 fee, address rewardAddress, bool validated, bool published, string certPublicKey, string dockerComposeHash, string name)',
  'function trustedZoneImageDetails(string) view returns (address owner, string ipfsHash, string version, string session, uint256 fee, address rewardAddress, bool validated, bool published, string certPublicKey, string dockerComposeHash, string name)',
  'function imageVersions(string, uint256) view returns (string)',
  'function trustedZoneImageVersions(string, uint256) view returns (string)',
];

const ESR_ABI = [
  'function getState(address enclave, bytes32 key) view returns (string cid, uint256 version, uint64 updatedAt)',
  'function getVersion(address enclave, bytes32 key) view returns (uint256)',
  'function exists(address enclave, bytes32 key) view returns (bool)',
  'function entryCount() view returns (uint256)',
  'function getEntriesFrom(uint256 start, uint256 limit) view returns (address[] enclaves, bytes32[] keys, string[] cids, uint256[] versions, uint64[] updatedAts, uint256 total)',
  'event StateCommitted(address indexed enclave, bytes32 indexed key, string cid, uint256 version, uint256 seq)',
];

function resolveNetwork(name) {
  name = (name || process.env.ESR_NETWORK || process.env.BLOCKCHAIN_NETWORK || 'BLOXBERG_TESTNET')
    .toUpperCase();
  const net = NETWORKS[name];
  if (!net) {
    throw new Error(`Unknown network '${name}'. Known: ${Object.keys(NETWORKS).join(', ')}`);
  }
  return { name, net };
}

function provider(rpc) {
  return new ethers.providers.JsonRpcProvider(rpc);
}

function keyHash(key) {
  return ethers.utils.id(key); // keccak256(utf8(key))
}

function looksLikeCID(cid) {
  return typeof cid === 'string' && (cid.startsWith('Qm') || cid.startsWith('bafk')) && cid.length > 20;
}

function decodeDetails(d, fallbackName) {
  return {
    name: d.name || fallbackName,
    published: Boolean(d.published),
    validated: Boolean(d.validated),
    image_ipfs_hash: d.ipfsHash || null,
    image_version: d.version || null,
    reward_address: d.rewardAddress,
    owner: d.owner,
    docker_compose_hash: d.dockerComposeHash || null,
    attestation_session: Boolean(d.session),
    cert_present: Boolean(d.certPublicKey),
  };
}

async function lookupRegistration(reg, kind, ipfs, name) {
  const detailsFn = kind === 'trustedzone' ? 'trustedZoneImageDetails' : 'imageDetails';
  const versionsFn = kind === 'trustedzone' ? 'trustedZoneImageVersions' : 'imageVersions';
  if (ipfs) {
    try { return decodeDetails(await reg[detailsFn](ipfs), ipfs); }
    catch (e) { return { found: false, error: e.message }; }
  }
  if (name) {
    let latest = null;
    for (let i = 0; i < 64; i += 1) {
      let v;
      try { v = await reg[versionsFn](name, i); } catch (e) { break; }
      if (!v) break;
      latest = v;
    }
    if (latest) {
      try { return decodeDetails(await reg[detailsFn](latest), name); }
      catch (e) { return { found: false, error: e.message }; }
    }
    return { found: false, note: `no registered version for name '${name}' -- the Image Registry is keyed by image IPFS hash; pass --ipfs <hash>` };
  }
  return { found: false, note: 'no --ipfs or --name to look up' };
}

async function sectionNetwork(prov, name, net) {
  const out = {
    network: name, type: net.type, chain_id: net.chainId, rpc: net.rpc,
    protocol_contract: net.protocol || '(n/a)',
    image_registry: net.imageRegistry || '(n/a)',
    esr_contract: net.esr || '(not deployed)',
  };
  try {
    out.latest_block = await prov.getBlockNumber();
    out.connected = true;
  } catch (e) {
    out.connected = false; out.error = e.message;
  }
  return out;
}

async function sectionRegistration(prov, net, kind, ipfs, name) {
  if (!net.imageRegistry) return { note: 'no image registry on this network' };
  const reg = new ethers.Contract(net.imageRegistry, IMAGE_REGISTRY_ABI, prov);
  return lookupRegistration(reg, kind, ipfs, name);
}

async function sectionEsr(prov, net, enclaveWallet, eventsN) {
  if (!net.esr) return { note: 'ESR is not deployed on this network' };
  const esr = new ethers.Contract(net.esr, ESR_ABI, prov);
  const out = { esr_contract: net.esr };
  try { out.total_registry_entries = (await esr.entryCount()).toNumber(); } catch (e) { /* ignore */ }
  if (enclaveWallet) {
    try {
      const latest = await prov.getBlockNumber();
      const from = Math.max(0, latest - 500000);
      const flt = esr.filters.StateCommitted(ethers.utils.getAddress(enclaveWallet));
      let logs = await esr.queryFilter(flt, from, 'latest');
      logs = logs.slice(-eventsN);
      out.recent_commits = logs.map((l) => ({
        key_hash: l.args.key,
        version: l.args.version.toNumber(),
        cid: l.args.cid,
        seq: l.args.seq.toNumber(),
        block: l.blockNumber,
      }));
    } catch (e) {
      out.recent_commits_error = e.message;
    }
  } else {
    out.recent_commits_note = 'pass --enclave <ESR wallet> to list this enclave\'s state commits';
  }
  return out;
}

async function esrQuery(prov, name, net, args) {
  const esrAddr = args.contract || net.esr;
  const sub = args.esrCmd || 'address';
  if (sub === 'address') return { network: name, esr_contract: esrAddr || '(not deployed)', rpc: net.rpc };
  if (!esrAddr) throw new Error(`ESR is not deployed on ${name}.`);
  const c = new ethers.Contract(esrAddr, ESR_ABI, prov);
  if (sub === 'count') return { network: name, entry_count: (await c.entryCount()).toNumber() };
  if (sub === 'version') {
    const v = (await c.getVersion(ethers.utils.getAddress(args.enclave), keyHash(args.key))).toNumber();
    return { enclave: args.enclave, key: args.key, version: v };
  }
  if (sub === 'state') {
    const enclave = ethers.utils.getAddress(args.enclave);
    const kh = keyHash(args.key);
    const [cid, version, updated] = await c.getState(enclave, kh);
    const exists = await c.exists(enclave, kh);
    return {
      network: name, enclave: args.enclave, key: args.key, key_hash: kh,
      exists, version: version.toNumber(), cid: cid || null, cid_valid: looksLikeCID(cid),
      updated_at: updated.toNumber(),
      note: 'cid points at ENCRYPTED state; only the enclave can decrypt it',
    };
  }
  if (sub === 'list') {
    const start = parseInt(args.start || 0, 10);
    const limit = parseInt(args.limit || 50, 10);
    const [encs, keys, cids, versions, updated, total] = await c.getEntriesFrom(start, limit);
    const entries = encs.map((e, i) => ({
      enclave: e, key_hash: keys[i], cid: cids[i] || null,
      version: versions[i].toNumber(), updated_at: updated[i].toNumber(),
    }));
    return { network: name, total: total.toNumber(), start, returned: entries.length, entries };
  }
  throw new Error(`unknown esr subcommand: ${sub}`);
}

// ---- arg parsing (tiny, dependency-free) -----------------------------------

function parseArgs(argv) {
  const a = { _: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t.startsWith('--')) { a[t.slice(2)] = argv[i + 1]; i += 1; }
    else a._.push(t);
  }
  return a;
}

function emit(obj, asJson) {
  if (asJson) { console.log(JSON.stringify(obj, null, 2)); return; }
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) { console.log(`${k}:`); v.forEach((it) => console.log('  ' + JSON.stringify(it))); }
    else console.log(`${k}: ${v}`);
  }
}

function printFull(info) {
  const n = info.network;
  console.log('NETWORK');
  console.log(`  ${n.network} (${n.type}, chain ${n.chain_id})   block ${n.latest_block || '?'}   ${n.connected ? 'connected' : 'NOT CONNECTED'}`);
  console.log(`  rpc:            ${n.rpc}`);
  console.log(`  protocol:       ${n.protocol_contract}`);
  console.log(`  image registry: ${n.image_registry}`);
  console.log(`  esr:            ${n.esr_contract}`);
  for (const [label, key] of [['TRUSTEDZONE', 'trustedzone'], ['SECURELOCK', 'securelock']]) {
    const r = info[key] || {};
    console.log(label);
    if (r.published || r.validated || r.image_ipfs_hash) {
      console.log(`  published:    ${r.published ? 'yes' : 'no'}   validated: ${r.validated ? 'yes' : 'no'}`);
      console.log(`  image hash:   ${r.image_ipfs_hash}`);
      console.log(`  version:      ${r.image_version}`);
      console.log(`  reward addr:  ${r.reward_address}`);
      console.log(`  attestation:  ${r.attestation_session ? 'MRENCLAVE session present' : 'none'}`);
    } else {
      console.log(`  not found     (${r.error || r.note || 'not registered'})`);
    }
  }
  const e = info.esr || {};
  console.log('ESR');
  if (e.note) { console.log(`  ${e.note}`); return; }
  console.log(`  registry:     ${e.esr_contract}`);
  if ('total_registry_entries' in e) console.log(`  total keys:   ${e.total_registry_entries} (all enclaves)`);
  if (e.recent_commits) {
    console.log(`  recent state commits for this enclave: ${e.recent_commits.length}`);
    e.recent_commits.forEach((c) => console.log(`    v${c.version}  seq ${c.seq}  ${c.key_hash}  ${c.cid}  (block ${c.block})`));
  } else if (e.recent_commits_note) console.log(`  ${e.recent_commits_note}`);
  else if (e.recent_commits_error) console.log(`  (could not read commits: ${e.recent_commits_error})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const section = args._[0];               // network | trustedzone | securelock | esr | undefined
  const { name: netName, net } = resolveNetwork(args.network);
  const prov = provider(net.rpc);

  const ipfs = args.ipfs || process.env.IPFS_HASH || null;
  const projName = args.name || process.env.PROJECT_NAME || null;

  if (section === 'esr') {
    args.esrCmd = args._[1];
    const obj = await esrQuery(prov, netName, net, args);
    emit(obj, args.json);
    return;
  }
  if (section === 'network') { emit(await sectionNetwork(prov, netName, net), args.json); return; }
  if (section === 'trustedzone') { emit(await sectionRegistration(prov, net, 'trustedzone', ipfs, projName), args.json); return; }
  if (section === 'securelock') { emit(await sectionRegistration(prov, net, 'securelock', ipfs, projName), args.json); return; }

  const info = {
    project: { name: projName || '(unknown)', dapp_type: process.env.SERVICE_TYPE || process.env.DAPP_TYPE, version: process.env.VERSION },
    network: await sectionNetwork(prov, netName, net),
    trustedzone: await sectionRegistration(prov, net, 'trustedzone', ipfs, projName),
    securelock: await sectionRegistration(prov, net, 'securelock', ipfs, projName),
    esr: await sectionEsr(prov, net, args.enclave || null, parseInt(args.events || 10, 10)),
  };
  if (args.json) { console.log(JSON.stringify(info, null, 2)); return; }
  const pr = info.project;
  console.log(`PROJECT  ${pr.name}${pr.dapp_type ? '   type ' + pr.dapp_type : ''}${pr.version != null ? '   version ' + pr.version : ''}`);
  printFull(info);
}

main().catch((e) => { console.error(`ecld-info: ${e.message}`); process.exit(1); });
