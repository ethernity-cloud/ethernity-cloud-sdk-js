const fs = require('fs');
require('dotenv').config();

const filePath = 'src/ec_helloworld_example.js';
const fileContent = fs.readFileSync(filePath, 'utf8');

const updatedContent = fileContent
    .replace(/const PROJECT_NAME = ".*?";/, `const PROJECT_NAME = "${process.env.PROJECT_NAME}";`)
    .replace(/const IPFS_ENDPOINT = ".*?";/, `const IPFS_ENDPOINT = "${process.env.IPFS_ENDPOINT}";`)

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