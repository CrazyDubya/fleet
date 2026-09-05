import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// Strips // and /* */ comments before anything else is scanned. This guard exists to catch
// real impurity — an import of the THREE.js renderer, or a read of a browser global — and
// prose ABOUT those things (a doc comment saying "three keyboard nudges", or explaining why a
// function must not touch `window`) is neither. Regex on raw source text can't tell code from
// comments, and a guard that can't tell them apart necessarily gets one direction wrong: either
// it flags real prose (what this test was doing before this fix — tilt.js's own comment
// mentioning "three keyboard nudges" failed the board) or, if "fixed" by only softening the
// patterns, it can just as easily stop catching the real thing it was built for. Comments and
// strings are not code; stripping them first is what lets the patterns below stay narrow AND
// stay strict — matching the actual violating forms (an import/require of 'three', a property
// access on document/window) rather than a bare word that could be prose.
//
// Not a full JS tokenizer (no handling for a regex literal containing `//`, or a string
// containing an unescaped quote via unusual escaping) — good enough for source this project
// controls, where none of that occurs today; test/glue-scope.test.mjs's own comment-stripping
// note observed the same tradeoff for a similar guard.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, '');
}

// Each pattern targets the actual violating FORM, not a bare keyword — an import/require of
// the 'three' library (not the word "three" anywhere), a property access on document/window
// (not the bare identifier, which a variable or parameter could legitimately be named), and the
// two impure calls. Checked against comment-stripped source only; string literals are left
// alone (a pure-layer file has no legitimate reason to contain the text of an import statement
// inside a string, so this hasn't been a source of false positives the way comments were).
const FORBIDDEN = [
  { pattern: /\bfrom\s+['"]three['"]|\brequire\(\s*['"]three['"]\s*\)/, label: "an import/require of 'three'" },
  { pattern: /\b(?:document|window)\s*\./, label: 'a property access on document/window' },
  { pattern: /\bDate\.now\(/, label: 'Date.now()' },
  { pattern: /\bMath\.random\(/, label: 'Math.random()' },
];
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
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const { pattern, label } of FORBIDDEN) {
      assert.ok(
        !pattern.test(src),
        `${path.relative(root, file)} contains ${label} — physics/table/rules must stay headless`
      );
    }
  }
});

// Proves the guard both ways, per the standing instruction that a false-positive fix must not
// also blind the check: a comment can freely say "three", "document" or "window" (prose, not
// code); a real import of the library or a real global property access still trips it.
test('purity guard: prose mentioning three/document/window passes, real impurity still fails', () => {
  const proseOnly = `
    // three keyboard nudges land on a document that never touches window.
    /* three, document, window — all just words here, not code. */
    export function pureFn(x) { return x * 2; }
  `;
  const strippedProse = stripComments(proseOnly);
  for (const { pattern } of FORBIDDEN) {
    assert.ok(!pattern.test(strippedProse), `prose-only fixture should not match ${pattern}`);
  }

  const realThreeImport = `import * as THREE from 'three';\nexport const x = 1;`;
  const realDocumentAccess = `export function f() { return document.getElementById('x'); }`;
  const realWindowAccess = `export function f() { return window.innerWidth; }`;
  const realDateNow = `export function f() { return Date.now(); }`;
  const realMathRandom = `export function f() { return Math.random(); }`;

  assert.ok(FORBIDDEN.some(({ pattern }) => pattern.test(stripComments(realThreeImport))), 'a real three import must still be caught');
  assert.ok(FORBIDDEN.some(({ pattern }) => pattern.test(stripComments(realDocumentAccess))), 'a real document.* access must still be caught');
  assert.ok(FORBIDDEN.some(({ pattern }) => pattern.test(stripComments(realWindowAccess))), 'a real window.* access must still be caught');
  assert.ok(FORBIDDEN.some(({ pattern }) => pattern.test(stripComments(realDateNow))), 'a real Date.now() call must still be caught');
  assert.ok(FORBIDDEN.some(({ pattern }) => pattern.test(stripComments(realMathRandom))), 'a real Math.random() call must still be caught');
});
