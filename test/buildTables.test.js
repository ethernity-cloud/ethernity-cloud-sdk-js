// The PoX and image registry each build bakes into the securelock for the
// testnets with their own contract family are the runner's: a securelock
// baked against another family reads the trustedzone certificate from the
// wrong registry, cannot verify the trustedzone's signed task handover, and
// signs its result without the order binding, which the trustedzone then
// rejects ("INVALID RESULT SIGNATURE"). The tables are read as text: the
// build scripts run the build when imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ECAddress } from '@ethernity-cloud/runner/enums.js';

const ROW = /^\s*'([a-z0-9-]+)':\s*\['(0x[0-9a-fA-F]{40})',\s*'(0x[0-9a-fA-F]{40})',\s*'([^']+)',\s*(\d+)\]/;
const rowsOf = (file) => Object.fromEntries(fs.readFileSync(new URL(file, import.meta.url), 'utf8')
  .split(/\r?\n/).map((line) => line.match(ROW)).filter(Boolean)
  .map(([, name, pox, registry, rpc, chainId]) => [name, { pox, registry, rpc, chainId: Number(chainId) }]));

const families = [
  ['ethereum-sepolia', ECAddress.SEPOLIA, 11155111],
  ['litvm-testnet', ECAddress.LITVM, 4441],
];

for (const file of ['../nodenithy/build.mjs', '../pynithy/build.mjs']) {
  const rows = rowsOf(file);
  for (const [suffix, address, chainId] of families) {
    test(`${file}: every ${suffix} row (and its -unsafe twin) bakes the runner's PoX and image registry`, () => {
      for (const kind of ['pynithy', 'nodenithy']) {
        for (const name of [`ecld-${kind}-${suffix}`, `ecld-${kind}-${suffix}-unsafe`]) {
          const row = rows[name];
          assert.ok(row, `${name} has no row`);
          assert.equal(row.pox.toLowerCase(), address.TESTNET_PROTOCOL_ADDRESS.toLowerCase(), `${name} PoX`);
          assert.equal(row.registry.toLowerCase(), address.IMAGE_REGISTRY[kind.toUpperCase()].TESTNET_ADDRESS.toLowerCase(), `${name} image registry`);
          assert.equal(row.chainId, chainId, `${name} chain id`);
        }
      }
    });
  }
}
