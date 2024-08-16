// console.log("Running postinstall script...");
const fs = require('fs');
const path = require('path');

// Path to the package.json file
// should be the package.json file from the root of the project
const packageJsonPath = path.join(__dirname, '../..', 'package.json');

// console.log("packageJsonPath: ", packageJsonPath);

// Read the package.json file
// if it does not exist, create an empty object
const packageJson = fs.existsSync(packageJsonPath) ? JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) : {};

// Default scripts to add
const defaultScripts = {
  "ecld-build": "cross-env node ./node_modules/ethernity-cloud-sdk-js/build.js",
  "ecld-publish": "cross-env node ./node_modules/ethernity-cloud-sdk-js/publish.js && cross-env node ./node_modules/ethernity-cloud-sdk-js/nodenithy/run.js",
  "ecld-init": "cross-env node ./node_modules/ethernity-cloud-sdk-js/init.js",
  "ecld-run": "cross-env ecld-run",
  "start": "node src/preStart.js && react-scripts start"
};

// Add default scripts to the package.json scripts section
packageJson.scripts = {
  ...packageJson.scripts,
  ...defaultScripts
};

// Write the updated package.json back to the file
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');

// console.log('Default scripts added to package.json');
process.stdout.write("Installation complete! Please run `npm run ecld-init` to initialize the project.\n");