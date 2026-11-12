// pynithy/build/securelock mirrors the Python SDK's securelock tree
// (ethernity-cloud-sdk-py ethernity_cloud_sdk_py/commands/pynithy/build/securelock:
// Dockerfile.base.tpl, Dockerfile.tpl, scripts/, src/). scripts/sync-pynithy.mjs
// copies it; this test fails when the mirror differs from a reachable Python
// SDK checkout (ETHERNITY_CLOUD_SDK_PY, else the sibling
// ../ethernity-cloud-sdk-py) and checks the comparison itself on a scratch tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENV_VAR, MIRROR_DIR, pythonSdkDir, sourceDir, listTree, compareTrees, syncTree, sameContent,
} from '../scripts/sync-pynithy.mjs';

const EQUAL = { missing: [], extra: [], differing: [] };

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pynithy-mirror-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('the mirror equals the Python SDK securelock tree', (t) => {
  const source = sourceDir(pythonSdkDir());
  if (!fs.existsSync(source)) {
    t.skip(`no Python SDK checkout at ${source} (set ${ENV_VAR})`);
    return;
  }
  const diff = compareTrees(source, MIRROR_DIR);
  assert.deepEqual(diff, EQUAL,
    `pynithy/build/securelock differs from ${source}; run node scripts/sync-pynithy.mjs`);
});

test('the mirror tree holds the four mirrored entries and no build leftovers', () => {
  const files = listTree(MIRROR_DIR);
  assert.ok(files.includes('Dockerfile.base.tpl'));
  assert.ok(files.includes('Dockerfile.tpl'));
  assert.ok(files.some((f) => f.startsWith('scripts/')));
  assert.ok(files.some((f) => f.startsWith('src/')));
  assert.ok(!files.some((f) => f.includes('__pycache__') || f.endsWith('.pyc')));
});

test('a changed byte, a missing file and an extra file are each reported', (t) => {
  const source = scratch(t);
  const mirror = scratch(t);
  put(source, 'Dockerfile.tpl', 'FROM a\n');
  put(source, 'src/a.py', 'x = 1\n');
  put(source, 'src/only-source.py', 'y = 2\n');
  put(mirror, 'Dockerfile.tpl', 'FROM a\n');
  put(mirror, 'src/a.py', 'x = 2\n');
  put(mirror, 'src/only-mirror.py', 'z = 3\n');
  put(mirror, 'src/__pycache__/a.cpython-311.pyc', Buffer.from([0, 1, 2]));
  assert.deepEqual(compareTrees(source, mirror), {
    missing: ['src/only-source.py'],
    extra: ['src/only-mirror.py'],
    differing: ['src/a.py'],
  });
});

test('CR LF reads as LF in a text file; a binary file is compared raw', () => {
  assert.ok(sameContent(Buffer.from('a\r\nb\r\n'), Buffer.from('a\nb\n')));
  assert.ok(!sameContent(Buffer.from('a\nb\n'), Buffer.from('a\nc\n')));
  const bin = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0x0d, 0x0a]);
  const binLf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0x0a]);
  assert.ok(sameContent(bin, Buffer.from(bin)));
  assert.ok(!sameContent(bin, binLf));
});

test('syncTree copies the missing and differing files and removes the extra ones', (t) => {
  const source = scratch(t);
  const mirror = scratch(t);
  put(source, 'Dockerfile.base.tpl', 'FROM base\n');
  put(source, 'scripts/run.sh', '#!/bin/sh\n');
  put(source, 'src/a.py', 'x = 1\n');
  put(source, 'src/same.py', 's = 0\n');
  put(mirror, 'src/a.py', 'x = 2\n');
  put(mirror, 'src/same.py', 's = 0\r\n');
  put(mirror, 'src/stale.py', 'gone\n');
  const result = syncTree(source, mirror);
  assert.deepEqual(result, {
    copied: ['Dockerfile.base.tpl', 'scripts/run.sh', 'src/a.py'],
    removed: ['src/stale.py'],
  });
  assert.deepEqual(compareTrees(source, mirror), EQUAL);
  assert.equal(fs.readFileSync(path.join(mirror, 'src/a.py'), 'utf8'), 'x = 1\n');
  assert.equal(fs.readFileSync(path.join(mirror, 'src/same.py'), 'utf8'), 's = 0\r\n');
  assert.ok(!fs.existsSync(path.join(mirror, 'src/stale.py')));
});
