// Which CAS a CAS-attested testnet's enclaves are provisioned from.
//
// The validators are enumerated from the ValidatorRegistry and their enclave
// endpoints read from the CasKeyStore the registry names via keyStore() --
// the same chain data the node's own resolver uses before every task. Only
// /dns4, /dns, /ip4 and /ip6 endpoints are used: the SDK runs on a
// developer's machine with no Tor proxy. The CAS the publish dials is taken
// only after its REST port answered GET /validator/identity. The CAS the
// published compose names is the first active validator in registry order,
// unprobed: the node and the extraction service resolve a CAS again before
// they run the compose, and a rerun of the same publish renders the same
// compose while the validator set is unchanged.
//
// Multiaddrs advertise the ENCLAVE port; the REST port follows the pairing
// convention rest = 9081 + (enclave - 19765). Enclave ports outside
// [19765, 19965) fall back to REST 9081.
//
// ECLD_CAS_ADDR=host:port overrides resolution.
const axios = require('axios');
const { ethers } = require('ethers');

const REGISTRY_ABI = [
  'function validatorCount() view returns (uint256)',
  'function validatorSet(uint256) view returns (address)',
  'function isValidator(address) view returns (bool)',
  'function keyStore() view returns (address)',
];
const STORE_ABI = ['function multiaddrsOf(address) view returns (string[])'];

const ENCLAVE_PORT_BASE = 19765;
const REST_PORT_BASE = 9081;

// "/dns4|dns|ip4|ip6/HOST/tcp/PORT" -> {host, port}; anything else null.
function parseMultiaddr(ma) {
  const parts = String(ma).split('/').filter((p) => p !== '');
  if (parts.length !== 4 || parts[2] !== 'tcp') return null;
  if (!['dns4', 'dns6', 'dns', 'ip4', 'ip6'].includes(parts[0])) return null;
  const port = Number(parts[3]);
  if (!Number.isInteger(port)) return null;
  return { host: parts[1], port };
}

function restPortFor(enclavePort) {
  if (enclavePort >= ENCLAVE_PORT_BASE && enclavePort < ENCLAVE_PORT_BASE + 200) {
    return REST_PORT_BASE + (enclavePort - ENCLAVE_PORT_BASE);
  }
  return REST_PORT_BASE;
}

// The address the CAS REST port reports for itself, or null when it did not answer.
async function identityAnswers(host, restPort, timeoutMs) {
  try {
    const r = await axios.get(`http://${host}:${restPort}/validator/identity`, { timeout: timeoutMs });
    return (r.data && r.data.address) || null;
  } catch (e) {
    return null;
  }
}

// The ValidatorRegistry, the CasKeyStore it names and its validator count.
async function registry(rpcUrl, registryAddress) {
  const provider = new ethers.providers.JsonRpcProvider({ url: rpcUrl, timeout: 30000 });
  const reg = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);
  const total = (await reg.validatorCount()).toNumber();
  const store = total ? new ethers.Contract(await reg.keyStore(), STORE_ABI, provider) : null;
  return { reg, store, total };
}

// The usable endpoints of validator `index` as {host, port} (the ENCLAVE
// port), or none when it is not an active validator.
async function endpointsOf({ reg, store }, index) {
  const v = await reg.validatorSet(index);
  if (!(await reg.isValidator(v))) return [];
  return (await store.multiaddrsOf(v)).map(parseMultiaddr).filter(Boolean);
}

// "host:port" (the ENCLAVE port) of the first active validator whose REST port
// answers, sweeping from a rotating offset; null when none answered.
async function resolveCas(rpcUrl, registryAddress, probeTimeoutMs = 10000, startAt = null) {
  const set = await registry(rpcUrl, registryAddress);
  if (set.total === 0) return null;
  const offset = startAt === null ? Math.floor(Math.random() * set.total) : startAt % set.total;
  for (let step = 0; step < set.total; step++) {
    for (const { host, port } of await endpointsOf(set, (offset + step) % set.total)) {
      if (await identityAnswers(host, restPortFor(port), probeTimeoutMs)) {
        return `${host}:${port}`;
      }
    }
  }
  return null;
}

// The CAS to provision against: ECLD_CAS_ADDR when set, else resolved from
// chain. Throws when neither yields one -- a compose without a reachable CAS
// cannot harvest a certificate.
async function casAddressFor(rpcUrl, registryAddress) {
  const override = String(process.env.ECLD_CAS_ADDR || '').trim();
  if (override) return override;
  if (!registryAddress) {
    throw new Error('no ValidatorRegistry is known for this network and ECLD_CAS_ADDR is not set');
  }
  const resolved = await resolveCas(rpcUrl, registryAddress);
  if (!resolved) {
    throw new Error(`no CAS validator registered in ${registryAddress} answered on its REST port; set ECLD_CAS_ADDR=host:port to name one`);
  }
  return resolved;
}

// The CAS the published compose names: ECLD_CAS_ADDR when set, else
// "host:port" (the ENCLAVE port) of the first active validator in registry
// order, unprobed. Throws when neither yields one.
async function publishedCasAddress(rpcUrl, registryAddress) {
  const override = String(process.env.ECLD_CAS_ADDR || '').trim();
  if (override) return override;
  if (!registryAddress) {
    throw new Error('no ValidatorRegistry is known for this network and ECLD_CAS_ADDR is not set');
  }
  const set = await registry(rpcUrl, registryAddress);
  for (let index = 0; index < set.total; index++) {
    const [first] = await endpointsOf(set, index);
    if (first) return `${first.host}:${first.port}`;
  }
  throw new Error(`no active validator in ${registryAddress} publishes a usable endpoint`);
}

module.exports = { parseMultiaddr, restPortFor, identityAnswers, resolveCas, casAddressFor, publishedCasAddress };
