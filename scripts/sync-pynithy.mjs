#!/usr/bin/env node
// Mirrors the Python SDK's securelock tree into pynithy/build/securelock.
//
// The pynithy securelock's canonical sources live in ethernity-cloud-sdk-py
// (ethernity_cloud_sdk_py/commands/pynithy/build/securelock); this package
// ships a byte-for-byte copy of its Dockerfile.base.tpl, Dockerfile.tpl,
// scripts/ and src/. `__pycache__` directories and `*.pyc` files are build
// leftovers of either checkout and are never copied or compared.
//
//   node scripts/sync-pynithy.mjs [--check] [<path to ethernity-cloud-sdk-py>]
//
// The Python SDK's path comes from the argument, else from the environment
// variable ETHERNITY_CLOUD_SDK_PY, else from the sibling checkout
// ../ethernity-cloud-sdk-py. `--check` lists the differences and exits 1
// without copying; test/pynithyMirror.test.js makes the same comparison.
//
// A text file is compared with CR LF read as LF: both repositories store these
// files with LF (this one through .gitattributes `* text=auto eol=lf`, the
// Python SDK through core.autocrlf on its Windows checkouts), so a line-ending
// difference between two working trees is checkout conversion, not content.
// A file with a NUL byte in its first 8000 bytes is binary (git's text=auto
// rule) and is compared raw. A differing file is copied raw; git normalises
// its line endings on commit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ENV_VAR = 'ETHERNITY_CLOUD_SDK_PY';
export const DEFAULT_SDK_PY = path.join(ROOT, '..', 'ethernity-cloud-sdk-py');
export const SOURCE_SUBDIR = path.join('ethernity_cloud_sdk_py', 'commands', 'pynithy', 'build', 'securelock');
export const MIRROR_DIR = path.join(ROOT, 'pynithy', 'build', 'securelock');
export const ENTRIES = ['Dockerfile.base.tpl', 'Dockerfile.tpl', 'scripts', 'src'];

export function pythonSdkDir(env = process.env) {
  return path.resolve(env[ENV_VAR] || DEFAULT_SDK_PY);
}

export function sourceDir(sdkPy) {
  return path.join(sdkPy, SOURCE_SUBDIR);
}

function ignored(name) {
  return name === '__pycache__' || name.endsWith('.pyc');
}

function walk(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath, out);
    else if (entry.isFile()) out.push(relPath);
  }
}

/** The relative paths (forward slashes, sorted) of every file under ENTRIES in `dir`. */
export function listTree(dir) {
  const out = [];
  for (const entry of ENTRIES) {
    const p = path.join(dir, entry);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walk(p, entry, out);
    else out.push(entry);
  }
  return out.sort();
}

export function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/** The bytes git compares: a text file with CR LF read as LF, a binary file as is. */
export function comparable(buf) {
  if (isBinary(buf)) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

export function sameContent(a, b) {
  return comparable(a).equals(comparable(b));
}

/**
 * { missing, extra, differing }: files of the source tree absent from the
 * mirror, files of the mirror absent from the source, and files whose content
 * differs. All three empty means the mirror equals the source.
 */
export function compareTrees(source, mirror) {
  const sourceFiles = listTree(source);
  const mirrorFiles = new Set(listTree(mirror));
  const result = { missing: [], extra: [], differing: [] };
  for (const rel of sourceFiles) {
    if (!mirrorFiles.has(rel)) { result.missing.push(rel); continue; }
    const a = fs.readFileSync(path.join(source, rel));
    const b = fs.readFileSync(path.join(mirror, rel));
    if (!sameContent(a, b)) result.differing.push(rel);
  }
  for (const rel of mirrorFiles) {
    if (!sourceFiles.includes(rel)) result.extra.push(rel);
  }
  return result;
}

/** Copies every missing or differing file raw and removes every extra one. */
export function syncTree(source, mirror) {
  const diff = compareTrees(source, mirror);
  const copied = [...diff.missing, ...diff.differing].sort();
  for (const rel of copied) {
    const dest = path.join(mirror, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(source, rel), dest);
  }
  for (const rel of diff.extra) fs.rmSync(path.join(mirror, rel));
  return { copied, removed: diff.extra };
}

function describe(diff) {
  const lines = [];
  for (const rel of diff.missing) lines.push(`missing in mirror: ${rel}`);
  for (const rel of diff.extra) lines.push(`not in the Python SDK: ${rel}`);
  for (const rel of diff.differing) lines.push(`differs: ${rel}`);
  return lines;
}

function main(argv) {
  const check = argv.includes('--check');
  const arg = argv.find((a) => !a.startsWith('--'));
  const sdkPy = arg ? path.resolve(arg) : pythonSdkDir();
  const source = sourceDir(sdkPy);
  if (!fs.existsSync(source)) {
    console.error(`no Python SDK securelock tree at ${source} (pass the ethernity-cloud-sdk-py path or set ${ENV_VAR})`);
    return 2;
  }
  if (check) {
    const diff = compareTrees(source, MIRROR_DIR);
    const lines = describe(diff);
    if (!lines.length) { console.log(`pynithy/build/securelock equals ${source}`); return 0; }
    for (const line of lines) console.log(line);
    return 1;
  }
  const { copied, removed } = syncTree(source, MIRROR_DIR);
  for (const rel of copied) console.log(`copied ${rel}`);
  for (const rel of removed) console.log(`removed ${rel}`);
  console.log(`${copied.length} copied, ${removed.length} removed from ${source}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
