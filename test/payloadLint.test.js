// The payload safety lint (payloadLint.mjs analyze) on a backend.js that
// parses only as a script, the sloppy-mode CommonJS nodenithy/build.mjs loads
// it as, and on one that parses neither as a module nor as a script. No
// build: analyze() is given the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const lint = () => import(pathToFileURL(path.join(__dirname, '..', 'payloadLint.mjs')).href);

// What analyze() reports of `source`: each finding as severity@line.
const reported = async (source) => {
  const { analyze } = await lint();
  const { findings, optedOut } = analyze(source, 'src/serverless/backend.js');
  return { optedOut, findings: findings.map((f) => `${f.severity}@${f.line}`), messages: findings.map((f) => f.message) };
};

// The kind of each finding analyze() reports of `source` (undefined for a
// finding of the code it checked).
const kinds = async (source) => {
  const { analyze } = await lint();
  return analyze(source, 'src/serverless/backend.js').findings.map((f) => f.kind);
};

test('a backend.js that parses only in sloppy mode is checked: eval of the task input after a with statement, a legacy octal literal or a top-level return is an error on its line', async () => {
  const sources = {
    'with statement': 'with (o) { x = 1; }\nfunction f() { return eval(___etny_data_set___); }',
    'legacy octal literal': 'var mode = 0755;\nfunction f() { return eval(___etny_data_set___); }',
    'top-level return': 'if (typeof module === "undefined") return;\nmodule.exports = { f: () => new Function(___etny_data_set___) };'
  };
  for (const [label, source] of Object.entries(sources)) {
    assert.deepEqual((await reported(source)).findings, ['error@2'], label);
  }
  // A warning is reported in sloppy mode as in a module, and the line
  // opt-out silences a finding there.
  assert.deepEqual((await reported('var m = 0755;\neval("1 + 1");')).findings, ['warning@2']);
  assert.deepEqual((await reported('var m = 0755;\neval(___etny_data_set___); // ecld: allow-eval')).findings, []);
});

test('a backend.js that parses neither as a module nor as a script is one error, on the line of the script parse\'s failure, naming both parsers\' messages; only the file opt-out turns it off', async () => {
  // As a module the octal literal of line 2 fails, as a script the import of
  // line 1.
  const source = 'import x from "x";\nvar mode = 0755;\nmodule.exports = () => eval(___etny_data_set___);';
  const { findings, messages, optedOut } = await reported(source);
  assert.equal(optedOut, false);
  assert.deepEqual(findings, ['error@1']);
  assert.match(messages[0], /^src\/serverless\/backend\.js parses neither as an ES module \(.+ \(2:\d+\)\) nor as a script \(.+ \(1:0\)\), so the lint cannot check it/);
  // That error is of the kind 'unparsed', which nodenithy/build.mjs prints
  // under its own heading; an error of the code it checked has no kind.
  assert.deepEqual(await kinds(source), ['unparsed']);
  assert.deepEqual(await kinds('module.exports = () => eval(___etny_data_set___);'), [undefined]);
  // The line opt-out on that line does not silence it.
  assert.deepEqual((await reported('const ok = 1;\nconst = 2; // ecld: allow-eval')).findings, ['error@2']);
  assert.deepEqual(await reported(`// ecld: allow-eval-file\n${source}`), { optedOut: true, findings: [], messages: [] });
});
