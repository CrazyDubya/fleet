import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const FORBIDDEN = [/\bthree\b/, /\bdocument\b/, /\bwindow\b/, /Date\.now\(/, /Math\.random\(/];
const PURE_DIRS = ['src/physics', 'src/table', 'src/rules'];
const PURE_FILES = ['src/save/schema.js'];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('purity: physics/, table/, rules/ and save/schema.js touch nothing impure', () => {
  const files = [];
  for (const d of PURE_DIRS) files.push(...walk(path.join(root, d)));
  for (const f of PURE_FILES) {
    const full = path.join(root, f);
    if (fs.existsSync(full)) files.push(full);
  }

  assert.ok(files.length > 0, 'expected at least one pure-layer file to check');

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN) {
      assert.ok(
        !pattern.test(src),
        `${path.relative(root, file)} matches forbidden pattern ${pattern} — physics/table/rules must stay headless`
      );
    }
  }
});
