'use strict';

/* Whether an image registry takes securelock registrations.
 *
 * ECImageRegistryV4 (pox-smart-contract-litvm ECImageRegistryV4.sol) imports
 * the owners of the securelock names from its seed source while
 * seedingOpen() answers true, and refuses registerImage and addImage with
 * SeedingOpen() until its owner calls closeSeeding. A registry without
 * seeding (ECImageRegistry V1 to V3) has no seedingOpen(): the call reverts,
 * and the registry takes registrations. */

const { ethers } = require('ethers');
const { isRevert } = require('./revert.js');

const SEEDING_ABI = ['function seedingOpen() view returns (bool)'];

// Whether the registry at `address`, read through `provider`, is seeding;
// false for a registry whose seedingOpen() reverts. A read the node does not
// answer throws.
async function seedingOpen(provider, address) {
  const registry = new ethers.Contract(address, SEEDING_ABI, provider);
  try {
    return Boolean(await registry.seedingOpen());
  } catch (e) {
    if (isRevert(e)) return false;
    throw e;
  }
}

// Why a publish on the registry at `address` stops while it is seeding.
function seedingRefusal(address) {
  return `the image registry ${address} is seeding its securelock name owners (seedingOpen() answers true): `
    + 'it refuses registerImage and addImage with SeedingOpen() until its owner closes seeding. '
    + 'Publish once seeding is closed.';
}

module.exports = { SEEDING_ABI, seedingOpen, seedingRefusal };
