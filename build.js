const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Increment VERSION on every build, mirroring the Python SDK's build.py
// (config VERSION += 1). VERSION is the immutable per-build registry channel and
// the enclave-name suffix, so each build must advance it. Existing projects seed
// VERSION as "v1"; parse whatever trailing integer is present (v1 -> 1, 22 -> 22,
// empty -> 0), increment, and persist as a plain integer. It must never equal
// "v3" (the protocol channel that acts as the moving "latest" pointer); plain
// integers can't collide with the "v3" string, so this is safe.
const writeEnv = (key, value) => {
    const envFile = '.env';
    let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    const regex = new RegExp(`^${key}=.*`, 'm');
    if (regex.test(content)) content = content.replace(regex, `${key}=${value}`);
    else content += (content && !content.endsWith('\n') ? '\n' : '') + `${key}=${value}`;
    fs.writeFileSync(envFile, content, 'utf8');
};

const bumpVersion = () => {
    const raw = (process.env.VERSION || '0').toString();
    const digits = raw.match(/\d+/);
    const next = (digits ? parseInt(digits[0], 10) : 0) + 1;
    process.env.VERSION = String(next);
    writeEnv('VERSION', String(next));
    console.log(`Version incremented to ${next}`);
    return next;
};

bumpVersion();

const serviceType = process.env.SERVICE_TYPE;

if (serviceType === "Nodenithy") {
    console.log("Adding prerequisites for Nodenithy...");
    const scriptPath = path.resolve(__dirname, 'nodenithy/build.mjs');
    console.log(`Running script: ${scriptPath}`);
    execSync(`node ${scriptPath}`, { stdio: 'inherit' });
    console.log(`Build script finished. You can now proceed to publish: npm run ecld-publish.`);
} else if (serviceType === "Pynithy") {
    console.log("Adding prerequisites for Pynithy...");
    const scriptPath = path.resolve(__dirname, 'pynithy/build.mjs');
    console.log(`Running script: ${scriptPath}`);
    execSync(`node ${scriptPath}`, { stdio: 'inherit' });
    console.log(`Build script finished. You can now proceed to publish: npm run ecld-publish.`);
} else {
    console.error("Something went wrong");
    process.exit(1);
}