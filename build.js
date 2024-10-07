const { execSync } = require('child_process');
const path = require('path');
require('dotenv').config();

const serviceType = process.env.SERVICE_TYPE;

if (serviceType === "Nodenithy") {
    console.log("Adding prerequisites for Nodenithy...");
    const scriptPath = path.resolve(__dirname, 'nodenithy/build.js');
    console.log(`Running script: ${scriptPath}`);
    execSync(`node ${scriptPath}`, { stdio: 'inherit' });
    console.log(`Build script finished. You can now proceed to publish: npm run ecld-publish.`);
} else if (serviceType === "Pynithy") {
    console.log("Adding prerequisites for Pynithy...");
    const scriptPath = path.resolve(__dirname, 'pynithy/build.js');
    console.log(`Running script: ${scriptPath}`);
    execSync(`node ${scriptPath}`, { stdio: 'inherit' });
    console.log(`Build script finished. You can now proceed to publish: npm run ecld-publish.`);
} else {
    console.error("Something went wrong");
    process.exit(1);
}