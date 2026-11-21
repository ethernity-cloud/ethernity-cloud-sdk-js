// The packed package: every relative import of a JavaScript file that
// `npm pack --dry-run --json` lists names a file the list holds, so the
// installed package resolves it. npm pack --dry-run makes its list from the
// `files` of package.json and writes and sends nothing; --ignore-scripts runs
// no script of the package. Each .js, .mjs and .cjs file listed is parsed
// with acorn, extended with acorn-jsx for the React template, as a module or
// else as a script; the imports read are its static and dynamic imports, its
// exports from another module, and its require() and require.resolve() calls,
// each with a string argument. A relative import resolves as a require() of
// it does: the file named, it with .js, .mjs, .cjs or .json, or its index.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Parser } = require('acorn');
const jsx = require('acorn-jsx');

const root = path.join(__dirname, '..');
const parser = Parser.extend(jsx());

// A directory of the packed tree that ecld-build fills from the dApp's
// project, and the packed directory the project's copy is made from:
// nodenithy/build.mjs copies the dApp's src/serverless/ into the securelock's
// source, and init.js copies nodenithy/src/ into the dApp's src/.
const FILLED_FROM_PROJECT = {
  'nodenithy/build/securelock/src/serverless/': 'nodenithy/src/serverless/'
};

// The paths npm pack lists, from the package's root with forward slashes.
const packedFiles = () => {
  const packed = spawnSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8', shell: true });
  assert.equal(packed.status, 0, packed.stderr);
  return JSON.parse(packed.stdout)[0].files.map((file) => file.path);
};

// The string an import names: a string literal, or a template literal
// without substitutions; null for any other argument.
const named = (node) => {
  if (node && node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node && node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
};

const isRequire = (callee) => (callee.type === 'Identifier' && callee.name === 'require') ||
  (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' &&
    callee.object.name === 'require' && callee.property.name === 'resolve');

// The specifiers the JavaScript `source` imports; throws when it parses
// neither as a module nor as a script.
const importsOf = (source) => {
  let tree = null;
  let failure = null;
  for (const sourceType of ['module', 'script']) {
    try {
      tree = parser.parse(source, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: sourceType === 'script' });
      break;
    } catch (error) {
      failure = error;
    }
  }
  if (!tree) throw failure;
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node.type !== 'string') return;
    let specifier = null;
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type)) {
      specifier = named(node.source);
    } else if (node.type === 'CallExpression' && isRequire(node.callee)) {
      specifier = named(node.arguments[0]);
    }
    if (specifier !== null) found.push(specifier);
    for (const value of Object.values(node)) walk(value);
  };
  walk(tree);
  return found;
};

// The packed file the relative import `specifier` of the packed file `file`
// names, or null when `files` holds none.
const resolved = (files, file, specifier) => {
  let target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  for (const [filled, copied] of Object.entries(FILLED_FROM_PROJECT)) {
    if (target.startsWith(filled)) target = copied + target.slice(filled.length);
  }
  const candidates = [target, `${target}.js`, `${target}.mjs`, `${target}.cjs`, `${target}.json`, `${target}/index.js`];
  return candidates.find((candidate) => files.has(candidate)) || null;
};

test('every relative import of a packed JavaScript file names a file of the package', () => {
  const files = new Set(packedFiles());
  const imports = [];
  for (const file of [...files].filter((name) => /\.(js|mjs|cjs)$/.test(name))) {
    let specifiers;
    try {
      specifiers = importsOf(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch (error) {
      assert.fail(`${file} parses neither as a module nor as a script: ${error.message}`);
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) imports.push([file, specifier]);
    }
  }
  // Among them: the payload lint ecld-build imports inside a try, and the
  // dApp's backend the securelock loads.
  const has = (file, specifier) => imports.some(([from, to]) => from === file && to === specifier);
  assert.ok(has('nodenithy/build.mjs', '../payloadLint.mjs'));
  assert.ok(has('nodenithy/build/securelock/src/etny_exec.js', './serverless/backend'));
  const unresolved = imports
    .filter(([file, specifier]) => resolved(files, file, specifier) === null)
    .map(([file, specifier]) => `${file} -> ${specifier}`);
  assert.deepEqual(unresolved, []);
});
