/**
 * Build-time safety lint for the serverless backend (JS dApps).
 *
 * WHAT THIS IS: a lint that runs on the developer's machine at ecld-build,
 * flagging dynamic code execution -- especially of task INPUT -- before the
 * enclave image is sealed. Purpose: stop an honest developer from accidentally
 * writing `eval(<task input>)`, which would let a submitter run arbitrary code
 * inside the dApp's enclave and bypass the per-key state ACL for that dApp's
 * other users.
 *
 * WHAT THIS IS NOT: a sandbox or a defence against a MALICIOUS author (who
 * builds their own image and can remove this check). Cross-dApp isolation
 * rests on the enclave encryption key; hard per-key ownership rests on the
 * trustedzone re-adjudicating commits. This is defence in depth against the
 * accidental footgun.
 *
 * POLICY
 * - ERROR: eval / a Function(...) constructor whose argument references the
 *   task input (`___etny_data_set___`).
 * - WARNING: any other eval / Function / dynamic member access we cannot prove
 *   is untainted (sound taint analysis is undecidable; indirection like
 *   `const f = eval; f(x)` is deliberately NOT claimed caught).
 *
 * OPT-OUT (this is a lint, not an unbypassable wall):
 * - `// ecld: allow-eval` on the offending line silences that finding.
 * - `// ecld: allow-eval-file` anywhere in the file disables the lint for it.
 */

import { Parser } from 'acorn';

const INPUT_NAMES = new Set(['___etny_data_set___']);
const FILE_OPT_OUT = 'ecld: allow-eval-file';
const LINE_OPT_OUT = 'ecld: allow-eval';

function mentionsInput(node) {
  let found = false;
  (function walk(n) {
    if (found || !n || typeof n !== 'object') return;
    if (n.type === 'Identifier' && INPUT_NAMES.has(n.name)) { found = true; return; }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(node);
  return found;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

export function analyze(source, filename = 'backend.js') {
  if (source.includes(FILE_OPT_OUT)) return { findings: [], optedOut: true };

  const allowLines = new Set();
  source.split('\n').forEach((l, i) => { if (l.includes(LINE_OPT_OUT)) allowLines.add(i + 1); });

  let ast;
  try {
    ast = Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (e) {
    return { findings: [], optedOut: false }; // caller already reports parse errors
  }

  const findings = [];
  const add = (severity, node, message) => {
    const line = node.loc ? node.loc.start.line : lineOf(source, node.start || 0);
    if (allowLines.has(line)) return;
    findings.push({ severity, line, message });
  };

  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;

    // eval(...)
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval') {
      const tainted = node.arguments.some(mentionsInput);
      add(tainted ? 'error' : 'warning', node,
        tainted
          ? 'eval() is called on task input (___etny_data_set___). A submitter could run '
            + 'arbitrary code inside your enclave and reach other users\' state. Parse the '
            + 'input explicitly instead of executing it. (// ecld: allow-eval to override.)'
          : 'eval() executes code dynamically. Ensure its argument is never derived from task '
            + 'input; the lint cannot prove this automatically. (// ecld: allow-eval to silence.)');
    }

    // new Function(...) / Function(...)
    const isFnCtor =
      (node.type === 'NewExpression' || node.type === 'CallExpression')
      && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'Function';
    if (isFnCtor) {
      const tainted = (node.arguments || []).some(mentionsInput);
      add(tainted ? 'error' : 'warning', node,
        tainted
          ? 'the Function constructor is built from task input; a submitter could run arbitrary '
            + 'code inside your enclave. Do not construct functions from untrusted input.'
          : 'the Function constructor compiles code at runtime. Ensure its source is not derived '
            + 'from task input. (// ecld: allow-eval to silence.)');
    }

    // Computed member access with an input-derived key: obj[<input>]
    if (node.type === 'MemberExpression' && node.computed && mentionsInput(node.property)) {
      add('warning', node,
        'a property is selected using task input (obj[input]). Safe for plain data lookups, but '
        + 'never use an input-derived key to reach functions or module internals.');
    }

    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);

  findings.sort((a, b) => a.line - b.line);
  return { findings, optedOut: false };
}
