// Runs before `react-scripts start` (the project's `npm start`): fills the
// constants at the top of src/ec_helloworld_example.js from the project's
// .env, the way ecld-run reads the same values. PROJECT_NAME and
// TRUSTED_ZONE_IMAGE take their -unsafe form on an -unsafe network; the
// network's token address, chain id and -unsafe (network, type) come from the
// runner's own enums through the SDK's network table.
import fs from 'fs';
import { createRequire } from 'module';
import dotenv from 'dotenv';
import * as enums from '@ethernity-cloud/runner/enums.js';

dotenv.config();
const require = createRequire(import.meta.url);
const casConfig = require('@ethernity-cloud/sdk-js/cas/config.js');
const { networkFor } = require('@ethernity-cloud/sdk-js/network.js');

const { PROJECT_NAME, TRUSTED_ZONE_IMAGE, BLOCKCHAIN_NETWORK, IPFS_ENDPOINT } = process.env;
if (!PROJECT_NAME || !BLOCKCHAIN_NETWORK) {
  console.error('preStart: PROJECT_NAME and BLOCKCHAIN_NETWORK are not set in .env; run `npm run ecld-init` first.');
  process.exit(1);
}
const { network, known } = networkFor(enums, BLOCKCHAIN_NETWORK);
if (!network) {
  console.error(`preStart: unknown BLOCKCHAIN_NETWORK '${BLOCKCHAIN_NETWORK}' in .env. Known: ${known.join(', ')}`);
  process.exit(1);
}

const constants = {
  PROJECT_NAME: casConfig.nameOnNetwork(PROJECT_NAME, BLOCKCHAIN_NETWORK),
  TRUSTED_ZONE_IMAGE: casConfig.nameOnNetwork(TRUSTED_ZONE_IMAGE, BLOCKCHAIN_NETWORK) || '',
  NETWORK_ADDRESS: network.address,
  CHAIN_ID: network.chainId || null,
  UNSAFE_NETWORK: network.unsafe || null,
  IPFS_ENDPOINT: IPFS_ENDPOINT || 'https://ipfs.ethernity.cloud',
};

const filePath = 'src/ec_helloworld_example.js';
let content = fs.readFileSync(filePath, 'utf8');
for (const [name, value] of Object.entries(constants)) {
  const line = new RegExp(`^const ${name} = .*;$`, 'm');
  if (!line.test(content)) {
    console.error(`preStart: ${filePath} has no 'const ${name} = ...;' line to fill.`);
    process.exit(1);
  }
  content = content.replace(line, `const ${name} = ${JSON.stringify(value)};`);
}
fs.writeFileSync(filePath, content, 'utf8');
