// The sandbox READS games/pinball/** and never writes it — same source-text-scan idiom as
// games/pinball/test/purity.test.mjs and glue-scope.test.mjs. Two properties:
//   1. No file under games/pinball/** ever imports anything from games/pinball-sandbox/** —
//      the dependency arrow points one way only, so a shared physics engine bug fixed in
//      pinball can never regress by way of something the sandbox added.
//   2. The sandbox imports pinball's physics/table modules by relative path (reuse) rather
//      than duplicating them locally under games/pinball-sandbox/src/ (copy) — verified two
//      ways: main.js's own source text references the real ../../pinball/src/... modules,
//      and no local physics/ or table/ directory exists here to have copied them into.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const SANDBOX_ROOT = path.join(import.meta.dirname, '..');
const PINBALL_ROOT = path.join(SANDBOX_ROOT, '..', 'pinball');
const MAIN_JS = path.join(SANDBOX_ROOT, 'src', 'main.js');

function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor' || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkJs(full));
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('no file under games/pinball/** imports anything from games/pinball-sandbox/**', () => {
  const offenders = [];
  for (const file of walkJs(PINBALL_ROOT)) {
    const content = readFileSync(file, 'utf8');
    if (content.includes('pinball-sandbox')) offenders.push(path.relative(PINBALL_ROOT, file));
  }
  assert.deepEqual(
    offenders,
    [],
    `games/pinball/** must never depend on games/pinball-sandbox/** (found reference(s) in: ` +
    `${JSON.stringify(offenders)}) — the sandbox reads pinball, never the reverse`
  );
});

test('main.js imports pinball physics/table modules by relative path, not a copy', () => {
  const src = readFileSync(MAIN_JS, 'utf8');
  const required = [
    '../../pinball/src/render/scene.js',
    '../../pinball/src/physics/world.js',
    '../../pinball/src/physics/flipper.js',
    '../../pinball/src/physics/constants.js',
    '../../pinball/src/table/recess.js',
    '../../pinball/src/table/mechanisms.js',
    '../../pinball/src/ui/input.js',
  ];
  const missing = required.filter((spec) => !src.includes(spec));
  assert.deepEqual(
    missing,
    [],
    `expected src/main.js to import pinball's real modules by relative path; missing: ${JSON.stringify(missing)}`
  );
});

test('no local copy of pinball physics/table code exists under games/pinball-sandbox/src', () => {
  const forbidden = ['physics', 'table', 'rules'];
  const present = forbidden.filter((dir) => existsSync(path.join(SANDBOX_ROOT, 'src', dir)));
  assert.deepEqual(
    present,
    [],
    `games/pinball-sandbox/src must not contain its own copy of pinball's physics/table/rules ` +
    `code (found: ${JSON.stringify(present)}) — import it from ../../pinball/src/ instead`
  );
});
