import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

export const ECRunner = {
  'etny-pynithy-testnet': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c'],
  'etny-nodenithy-testnet': ['0x02882F03097fE8cD31afbdFbB5D72a498B41112c'],
  'etny-pynithy': ['0x549A6E06BB2084100148D50F51CF77a3436C3Ae7'],
  'etny-nodenithy': ['0x549A6E06BB2084100148D50F51CF77a3436C3Ae7'],
  'ecld-nodenithy-testnet': ['0xfb450e40f590F1B5A119a4B82E6F3579D6742a00'],
  'ecld-pynithy': ['0xc6920888988cAcEeA7ACCA0c96f2D65b05eE22Ba'],
  'ecld-nodenithy': ['0xc6920888988cAcEeA7ACCA0c96f2D65b05eE22Ba']
};

const filePath = 'src/ec_helloworld_example.js';
const fileContent = fs.readFileSync(filePath, 'utf8');

const updatedContent = fileContent
    .replace(/const PROJECT_NAME = ".*?";/, `const PROJECT_NAME = "${process.env.PROJECT_NAME}";`)
    .replace(/const IPFS_ENDPOINT = ".*?";/, `const IPFS_ENDPOINT = "${process.env.IPFS_ENDPOINT}";`)
    .replace(/new EthernityCloudRunner\(.*?\);/, `new EthernityCloudRunner('${ECRunner[process.env.ENCLAVE_NAME_TRUSTEDZONE]}');`);

fs.writeFileSync(filePath, updatedContent, 'utf8');

// const code = updatedContent.match(/const code = `hello\("(.*?)"\);/)[1];

const imageRegistryPath = 'node_modules/@ethernity-cloud/runner/contract/operation/imageRegistryContract.js';
const imageRegistryContent = fs.readFileSync(imageRegistryPath, 'utf8');

// Log the original content for debugging
// console.log('Original imageRegistryContent:', imageRegistryContent);

// Replace the content in imageRegistryContract.js
// const updatedImageRegistryContent = imageRegistryContent.replace(/getLatestTrustedZoneImageCertPublicKey\([^)]*\);/, "getLatestTrustedZoneImageCertPublicKey('" + process.env.ENCLAVE_NAME_TRUSTEDZONE + "', 'v3')").replace(/getLatestImageVersionPublicKey\([^)]*\)/, "getLatestImageVersionPublicKey(imageName, '" + process.env.VERSION + "')");
const updatedImageRegistryContent = imageRegistryContent.replace(
    /async getEnclaveDetailsV3\(.*?\{[\s\S]*?\}\s*\}/,
    `async getEnclaveDetailsV3(imageName, version) {
      try {
        const trustedZonePublicKey = (await this.contract.getLatestTrustedZoneImageCertPublicKey('${process.env.ENCLAVE_NAME_TRUSTEDZONE}', 'v3'));
        const imageDetails = await this.contract.getLatestImageVersionPublicKey(imageName, '${process.env.VERSION}');
        return [imageDetails[0], trustedZonePublicKey[1], imageDetails[2]];
      } catch (e) {
        console.log(e);
        return null;
      }
    }`
  );


fs.writeFileSync(imageRegistryPath, updatedImageRegistryContent, 'utf8');

const runnerPath = 'node_modules/@ethernity-cloud/runner/runner.js';
const runnerContent = fs.readFileSync(runnerPath, 'utf8');

const updatedRunnerContent = runnerContent.replace(/this.#enclaveImageIPFSHash}:.*?:/, "this.#enclaveImageIPFSHash}:"+process.env.ENCLAVE_NAME_TRUSTEDZONE+":").replace(/new ImageRegistryContract\([^)]*\);/, "new ImageRegistryContract(this.#networkAddress, '"+process.env.ENCLAVE_NAME_TRUSTEDZONE+"');");

fs.writeFileSync(runnerPath, updatedRunnerContent, 'utf8');