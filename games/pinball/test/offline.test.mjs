import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function walk(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'vendor') out.push(...walk(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

test('offline: no http(s) src/href anywhere in index.html or src/', () => {
  const files = [path.join(root, 'index.html'), ...walk(path.join(root, 'src'), '.js')];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const matches = text.match(/(src|href)\s*=?\s*["'`]https?:\/\//gi);
    assert.equal(matches, null, `${path.relative(root, file)} references an external URL`);
  }
});
