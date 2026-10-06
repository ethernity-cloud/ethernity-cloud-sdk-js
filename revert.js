// What the node answered when a contract call failed.
//
// ethers 5 reads revert data only from a geth-style JSON-RPC error, which it
// turns into the call's result and decodes into a CALL_EXCEPTION with no
// node error nested. The bloxberg node (Parity 2.7) answers eth_call with
// {"data": "Reverted 0x..."}, which ethers reports as a CALL_EXCEPTION with
// "missing revert data" and the node's error nested, and its eth_estimateGas
// error carries no data at all. ethers reports an eth_call that timed out as
// the same CALL_EXCEPTION, with the timeout nested. A refusal is therefore
// read from a simulated call (callStatic), out of the node's own error.
const { ethers } = require('ethers');

const ERROR_STRING = '0x08c379a0'; // Error(string)
const PANIC = '0x4e487b71'; // Panic(uint256)

function bodyError(body) {
  try {
    return JSON.parse(body).error;
  } catch (e) {
    return undefined;
  }
}

// The JSON-RPC errors the node answered with: the errors nested in an ethers
// error, and in the response bodies it carries, that hold the node's numeric
// error code. A call the node never answered has none.
function nodeErrors(e) {
  const found = [];
  for (let err = e, depth = 0; err && depth < 5; err = err.error, depth++) {
    for (const candidate of [err, bodyError(err.body)]) {
      if (candidate && typeof candidate.code === 'number') found.push(candidate);
    }
  }
  return found;
}

// Whether the node answered the call with a revert, rather than failing to
// answer it (a timeout, an unreachable node, a rate limit).
function isRevert(e) {
  if (e.code !== ethers.errors.CALL_EXCEPTION) return false;
  if (!e.error) return true;
  return nodeErrors(e).some((err) => (typeof err.data === 'string' && err.data.startsWith('Reverted'))
    || /revert/i.test(err.message || ''));
}

// The revert data the node returned, as 0x-prefixed hex with at least a
// selector, or null.
function revertData(e) {
  for (const err of nodeErrors(e)) {
    if (typeof err.data !== 'string') continue;
    const m = err.data.match(/^(?:Reverted )?(0x(?:[0-9a-fA-F]{2})*)$/);
    if (m && m[1].length >= 10) return m[1];
  }
  return null;
}

// The refusal as the contract states it: a require message, or a custom
// error of `iface` with its arguments. Falls back to the error's own message
// when the node returned no revert data.
function revertReason(e, iface) {
  if (e.errorName === 'Error' && e.reason) return e.reason;
  if (e.errorName) return `${e.errorName}(${(e.errorArgs || []).map(String).join(', ')})`;
  const data = revertData(e);
  if (!data) return e.reason || e.message;
  const args = `0x${data.slice(10)}`;
  try {
    if (data.startsWith(ERROR_STRING)) return ethers.utils.defaultAbiCoder.decode(['string'], args)[0];
    if (data.startsWith(PANIC)) return `Panic(${ethers.utils.defaultAbiCoder.decode(['uint256'], args)[0]})`;
    const parsed = iface.parseError(data);
    return `${parsed.name}(${parsed.args.map(String).join(', ')})`;
  } catch (err) {
    return `reverted with data ${data}`;
  }
}

module.exports = { isRevert, revertData, revertReason };
