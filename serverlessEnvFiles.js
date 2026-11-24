// ecld-build copies the project's src/serverless whole into the securelock's
// image. The image is published and its files are measured, not encrypted:
// anyone reads them. The enclaves read no .env file from the image. Both build
// entries (nodenithy/build.mjs, pynithy/build.mjs) end with status 1, before
// they remove, copy or build anything, when src/serverless holds a file named
// .env or .env.<anything>.
const fs = require('fs');
const path = require('path');

const ENV_FILE_NAME = /^\.env(\..*)?$/s;

function isDirectory(entry) {
  try {
    return fs.statSync(entry).isDirectory();
  } catch {
    return false;
  }
}

// The entries under `dir` named .env or .env.<anything> that are not
// directories, at any depth, as sorted paths relative to `dir` with / between
// the names. A link to a directory is entered, and each directory once. A
// `dir` that does not exist holds none.
function find(dir) {
  const found = [];
  const entered = new Set();
  const walk = (folder, prefix) => {
    const real = fs.realpathSync(folder);
    if (entered.has(real)) return;
    entered.add(real);
    for (const name of fs.readdirSync(folder)) {
      const entry = path.join(folder, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      if (isDirectory(entry)) walk(entry, relative);
      else if (ENV_FILE_NAME.test(name)) found.push(relative);
    }
  };
  if (isDirectory(dir)) walk(dir, '');
  return found.sort();
}

// The lines of the refusal that names `found`, a result of find().
function refusal(found) {
  return [
    'ERROR: src/serverless holds a file named .env or .env.<name>:',
    ...found.map((name) => `       src/serverless/${name}`),
    '       Everything in src/serverless is published with the enclave image and readable by anyone.',
    '       A secret belongs in the task\'s payload or input, which are encrypted for the enclave.',
    '       Remove each file listed from src/serverless before building.',
  ];
}

module.exports = { find, refusal };
