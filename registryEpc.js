'use strict';

/* The EPC need ecld-publish records for a securelock image.
 *
 * ECImageRegistryV4 (pox-smart-contract-litvm ECImageRegistryV4.sol; spec
 * matching.md section 16 item 41; D200) holds per securelock image its EPC
 * need in units of 64 MiB: imageEpcUnits(ipfsHash) answers it, 0 for none
 * recorded, and setImageEpcUnits(ipfsHash, epcUnits), 1 to 65,535 units,
 * writes it once, from the wallet that registered the image while it owns the
 * image's name. A runner states at least that need in every request for the
 * image. The project setting ECLD_EPC_MIB is the need in MiB, rounded up to
 * whole units; a need of one unit (64 MiB, the setting's absence) records
 * none. A need recorded already is never written again: one equal to the
 * publish's is left as it is, and one that differs stops the publish. A
 * registry without imageEpcUnits (ECImageRegistry V1 to V3) reverts the read
 * and records no need, which the developer is told. */

const { ethers } = require('ethers');
const { isRevert } = require('./revert.js');

const EPC_SETTING = 'ECLD_EPC_MIB';
const EPC_UNIT_MIB = 64;
const EPC_MAX_UNITS = 65535;
const EPC_MAX_MIB = EPC_MAX_UNITS * EPC_UNIT_MIB;
const EPC_ABI = ['function imageEpcUnits(string ipfsHash) view returns (uint16)'];

// The publish's EPC need in units of 64 MiB from ECLD_EPC_MIB's text: 1 when
// it is unset or empty, else the MiB rounded up to whole units. Throws for a
// text that is not a whole number of 1 to EPC_MAX_MIB.
function epcUnitsOfSetting(text) {
  if (text === undefined || text === null || String(text).trim() === '') return 1;
  const value = String(text).trim();
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > EPC_MAX_MIB) {
    throw new Error(`${EPC_SETTING} is the EPC the securelock needs, in MiB: a whole number of 1 to ${EPC_MAX_MIB}, `
      + `not ${JSON.stringify(String(text))}`);
  }
  return Math.ceil(Number(value) / EPC_UNIT_MIB);
}

// What the publish does with a need of `units` when the registry records
// `recorded` units for the image (null: the registry has no imageEpcUnits):
// 'write' the need, 'keep' the equal need recorded, 'stop' on a recorded need
// that differs, 'none' when nothing is recorded or written.
function epcStep(recorded, units) {
  if (recorded === null) return 'none';
  if (recorded === 0) return units > 1 ? 'write' : 'none';
  return recorded === units ? 'keep' : 'stop';
}

// The EPC need the registry at `address`, read through `provider`, records
// for `ipfsHash`; null for a registry whose imageEpcUnits reverts. A read the
// node does not answer throws.
async function readEpcUnits(provider, address, ipfsHash) {
  const registry = new ethers.Contract(address, EPC_ABI, provider);
  try {
    return Number(await registry.imageEpcUnits(ipfsHash));
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
}

const mib = (units) => units * EPC_UNIT_MIB;

// Records the publish's EPC need of `units` for the registered image
// `ipfsHash` on the registry at `address` (epcStep), the write sent through
// `write('setImageEpcUnits', ipfsHash, units)`. Returns what the developer is
// told, '' for nothing; throws when a need recorded already differs.
async function recordEpcNeed(provider, address, ipfsHash, units, write) {
  const recorded = await readEpcUnits(provider, address, ipfsHash);
  const step = epcStep(recorded, units);
  if (step === 'stop') {
    throw new Error(`the image registry ${address} records an EPC need of ${recorded} units of ${EPC_UNIT_MIB} MiB `
      + `(${mib(recorded)} MiB) for ${ipfsHash}, and this publish states ${units} (${mib(units)} MiB, ${EPC_SETTING}): `
      + `the need is written once. Set ${EPC_SETTING} to ${mib(recorded)}, or publish a new image.`);
  }
  if (step === 'keep') return `The EPC need of ${ipfsHash} is recorded: ${recorded} units of ${EPC_UNIT_MIB} MiB.`;
  if (step === 'write') {
    await write('setImageEpcUnits', ipfsHash, units);
    return `The EPC need of ${ipfsHash} is recorded: ${units} units of ${EPC_UNIT_MIB} MiB (${mib(units)} MiB).`;
  }
  if (recorded === null && units > 1) {
    return `The image registry ${address} records no EPC need (imageEpcUnits reverts): the need of ${units} units `
      + `of ${EPC_UNIT_MIB} MiB (${EPC_SETTING}) is not recorded.`;
  }
  return '';
}

module.exports = { EPC_SETTING, EPC_UNIT_MIB, EPC_MAX_MIB, epcUnitsOfSetting, epcStep, readEpcUnits, recordEpcNeed };
