// Class-level guard for the SW_BALL_LOST-class bug: src/main.js is glue outside every purity
// boundary (purity.test.mjs only checks physics/table/rules for *forbidden* patterns, never
// that anything in main.js *resolves*), and no test imports main.js — a plain three.js/DOM
// module that would throw immediately outside a browser. A free identifier referenced in
// main.js but never imported or declared is invisible to node --test and to a plain read, and
// its failure mode is the worst kind: it doesn't throw until the exact runtime path that
// references it executes, at which point requestAnimationFrame(frame) never gets called
// again and the game freezes permanently (see the 2026-09-04 opus2 SW_BALL_LOST finding).
//
// This is a source-text scanner, not a real parser — this repo has no package.json and
// vendors three.js directly (games/pinball/vendor, bare `node --test`), so pulling in a JS
// parser to do this properly would be the first non-vendored dependency in the project,
// against its offline grain. purity.test.mjs and offline.test.mjs already do source-text
// checks over fs.readFileSync; this fits the same idiom. It intentionally does not try to
// handle every valid JS construct in general — it is tuned against what src/main.js actually
// contains, and its property is a floor, not a ceiling: every name it flags is a genuine free
// identifier at the point it's used, verified below against both the file as committed (must
// flag SW_BALL_LOST) and a known-bogus injection (must also flag that).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MAIN_JS = path.join(root, 'src/main.js');

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'function', 'return', 'const', 'let', 'var', 'new',
  'typeof', 'instanceof', 'in', 'of', 'this', 'null', 'true', 'false', 'void', 'delete',
  'class', 'extends', 'super', 'yield', 'async', 'await', 'static', 'get', 'set', 'import',
  'export', 'from', 'as', 'default', 'try', 'catch', 'finally', 'throw', 'switch', 'case',
  'break', 'continue', 'debugger', 'with', 'arguments',
]);

// A small, explicit browser/JS global allowlist — main.js is the one file in this project
// that's allowed to touch these (purity.test.mjs forbids them everywhere else).
const GLOBAL_ALLOWLIST = new Set([
  'Math', 'Date', 'JSON', 'Array', 'Object', 'Number', 'String', 'Boolean', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Promise', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'Symbol', 'Proxy', 'Reflect', 'Infinity', 'NaN', 'undefined', 'isNaN',
  'isFinite', 'parseInt', 'parseFloat', 'globalThis', 'structuredClone', 'ArrayBuffer',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'BigInt',
  'window', 'document', 'console', 'requestAnimationFrame', 'cancelAnimationFrame',
  'performance', 'navigator', 'localStorage', 'sessionStorage', 'fetch', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'alert', 'confirm', 'prompt',
  'CustomEvent', 'AbortController', 'self', 'addEventListener', 'removeEventListener',
  'Image', 'Audio', 'history', 'location',
]);

function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
    } else if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n - 1 && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(j + 2, n);
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, n);
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else if (c === '`') {
      // Template literal: keep ${...} expression contents live (they're real code), mask
      // the literal text around them.
      let j = i + 1;
      let buf = ' ';
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { buf += '  '; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          let inner = '';
          while (k < n && depth > 0) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}') { depth--; if (depth === 0) break; }
            inner += src[k];
            k++;
          }
          buf += '  ' + inner + ' ';
          j = k + 1;
          continue;
        }
        buf += ' ';
        j++;
      }
      buf += j < n ? ' ' : '';
      out += buf;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// `get name(` / `set name(` are accessor keys, not free-variable uses of `name`.
function maskAccessorKeys(src) {
  return src.replace(/\b(get|set)(\s+)([A-Za-z_$][\w$]*)(\s*\()/g, (_m, kw, ws, name, tail) =>
    kw + ws + ' '.repeat(name.length) + tail);
}

// Imports are declarations, not uses — the specifier list (including any pre-`as` name)
// must not be scope-checked as a free-variable reference.
function maskImportStatements(src) {
  return src.replace(/\bimport\b[^;]*;?/g, (m) => m.replace(/[^\n]/g, ' '));
}

function splitTopLevel(str) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Every name a binding target (identifier, `{...}` pattern, or `[...]` pattern) declares. */
function namesFromBindingTarget(target) {
  target = target.trim();
  if (!target) return [];
  if (target.startsWith('...')) target = target.slice(3).trim();
  if (target.startsWith('{')) {
    const inner = target.replace(/^\{/, '').replace(/\}[^}]*$/, '');
    const names = [];
    for (const part of splitTopLevel(inner)) {
      const p = part.trim();
      if (!p) continue;
      // `{ a: b }` destructures property `a` (not a free name) into local `b`.
      names.push(...namesFromBindingTarget(p.includes(':') ? p.slice(p.indexOf(':') + 1) : p));
    }
    return names;
  }
  if (target.startsWith('[')) {
    const inner = target.replace(/^\[/, '').replace(/\][^\]]*$/, '');
    const names = [];
    for (const part of splitTopLevel(inner)) {
      const p = part.trim();
      if (p) names.push(...namesFromBindingTarget(p));
    }
    return names;
  }
  const eqIdx = target.indexOf('=');
  const simple = eqIdx >= 0 ? target.slice(0, eqIdx).trim() : target;
  const m = simple.match(/^[A-Za-z_$][\w$]*$/);
  return m ? [simple] : [];
}

function collectDeclared(src) {
  const declared = new Set();

  for (const m of src.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g)) declared.add(m[1]);
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) declared.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of splitTopLevel(m[1])) {
      const p = part.trim();
      if (!p) continue;
      const asMatch = p.match(/^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/);
      declared.add(asMatch ? asMatch[1] : p);
    }
  }

  for (const m of src.matchAll(/\b(?:const|let|var)\s*(\{[^;=]*\}|\[[^;=]*\]|[A-Za-z_$][\w$]*)\s*=/g)) {
    for (const name of namesFromBindingTarget(m[1])) declared.add(name);
  }
  for (const m of src.matchAll(/\b(?:let|var)\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*;/g)) {
    for (const part of m[1].split(',')) declared.add(part.trim());
  }

  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    declared.add(m[1]);
    for (const part of splitTopLevel(m[2])) for (const n of namesFromBindingTarget(part)) declared.add(n);
  }
  for (const m of src.matchAll(/\bfunction\s*\(([^)]*)\)/g)) {
    for (const part of splitTopLevel(m[1])) for (const n of namesFromBindingTarget(part)) declared.add(n);
  }

  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of splitTopLevel(m[1])) for (const n of namesFromBindingTarget(part)) declared.add(n);
  }
  for (const m of src.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);

  for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s*(\{[^;=)]*\}|\[[^;=)]*\]|[A-Za-z_$][\w$]*)\s+(?:of|in)\s+/g)) {
    for (const n of namesFromBindingTarget(m[1])) declared.add(n);
  }
  for (const m of src.matchAll(/for\s*\(\s*(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);

  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);

  return declared;
}

function findUses(src) {
  const uses = [];
  const idRe = /(?<![\w$])[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = idRe.exec(src))) {
    const name = m[0];
    const start = m.index;
    if (KEYWORDS.has(name)) continue;

    let p = start - 1;
    while (p >= 0 && /\s/.test(src[p])) p--;
    const prevCh = p >= 0 ? src[p] : '';
    if (prevCh === '.') continue; // member access, including optional chaining (?.)

    let q = start + name.length;
    while (q < src.length && /\s/.test(src[q])) q++;
    const nextCh = q < src.length ? src[q] : '';
    if (nextCh === ':' && (prevCh === '{' || prevCh === ',')) continue; // object/destructure key

    uses.push({ name, index: start });
  }
  return uses;
}

/** Every free identifier `src` references, with 1-indexed line numbers, that is neither
 * imported/declared within `src` nor a member of GLOBAL_ALLOWLIST. */
function findFreeIdentifiers(src) {
  let masked = stripCommentsAndStrings(src);
  masked = maskAccessorKeys(masked);
  const declared = collectDeclared(masked);
  const uses = findUses(maskImportStatements(masked));

  const flagged = [];
  const seen = new Set();
  for (const u of uses) {
    if (declared.has(u.name) || GLOBAL_ALLOWLIST.has(u.name)) continue;
    const line = src.slice(0, u.index).split('\n').length;
    const key = `${u.name}@${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flagged.push({ name: u.name, line });
  }
  return flagged;
}

test('glue-scope scanner flags a known-bogus injected identifier (self-check)', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const injected = src.replace(
    'renderer.render(scene, camera);',
    'renderer.render(scene, camera);\n  console.log(totallyBogusUndefinedIdentifier987);'
  );
  assert.notEqual(injected, src, 'expected the injection anchor line to exist in main.js');
  const flagged = findFreeIdentifiers(injected).map((f) => f.name);
  assert.ok(
    flagged.includes('totallyBogusUndefinedIdentifier987'),
    'scanner failed to flag a deliberately injected undefined identifier — the scanner itself is broken, not just quiet'
  );
});

test('every free identifier in src/main.js is imported, declared, or an allowlisted global', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const flagged = findFreeIdentifiers(src);
  assert.deepEqual(
    flagged,
    [],
    `src/main.js references identifier(s) that are neither imported, declared, nor ` +
    `allowlisted — this is exactly the SW_BALL_LOST-class bug (used at runtime, invisible ` +
    `to every other test, freezes the game the first time the code path executes): ` +
    `${JSON.stringify(flagged)}`
  );
});
