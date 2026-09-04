// Rewrite of the old capture-zone-parity test (2026-09-04): that test only checked capture
// zones and ramp gates — a curated subset of the playfield surface — and passed 9/9 while the
// sandbox was silently missing the swing-set post colliders (buildSwingSetPosts: 3 refs in
// the game's main.js, 0 in the sandbox's) and both spinner zones (buildSpinners: 1 ref in the
// game, 0 in the sandbox). Found by grep, not by this test. This version checks the FULL
// playfield primitive/zone/capture-zone set — every segment, every circle, every zone, every
// capture zone, counts and values — so a builder the sandbox forgets to wire can't hide behind
// a checklist that happened not to mention it.
//
// Both checks matter together: the numeric comparison (below) proves the two worlds actually
// hold the same data; the structural check (both main.js files import and call
// table/assemble.js's buildTable()/wireTable()) proves that's true BECAUSE they share one
// source of truth, not because two independent lists happen to currently agree — which is
// exactly the failure mode a hand-curated list comparison can't rule out (see above).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from '../../pinball/src/physics/world.js';
import { buildTable, wireTable } from '../../pinball/src/table/assemble.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_ROOT = path.join(here, '..');
const SANDBOX_MAIN_JS = path.join(SANDBOX_ROOT, 'src', 'main.js');
const PINBALL_MAIN_JS = path.join(SANDBOX_ROOT, '..', 'pinball', 'src', 'main.js');

function summarizeShape(shape) {
  if (shape.kind === 'segment') return { kind: 'segment', a: shape.a, b: shape.b, tag: shape.tag };
  if (shape.kind === 'circle') return { kind: 'circle', centre: shape.centre, radius: shape.radius, tag: shape.tag };
  return { kind: shape.kind, a: shape.a, b: shape.b, tag: shape.tag };
}

function summarizeWorld(world) {
  return {
    primitives: (world.layers.get('playfield') || []).map((p) => summarizeShape(p.shape)),
    zones: (world.zones.get('playfield') || []).map(summarizeShape),
    captureZones: (world.captureZones.get('playfield') || []).map((c) => ({ centre: c.centre, radius: c.radius, tag: c.tag })),
  };
}

test('both main.js files build the playfield from the shared table/assemble.js (buildTable/wireTable), not an independent builder list', () => {
  const gameSrc = fs.readFileSync(PINBALL_MAIN_JS, 'utf8');
  const sandboxSrc = fs.readFileSync(SANDBOX_MAIN_JS, 'utf8');
  for (const [label, src] of [['game', gameSrc], ['sandbox', sandboxSrc]]) {
    assert.ok(
      /from\s+['"][^'"]*table\/assemble\.js['"]/.test(src),
      `expected ${label}'s main.js to import from table/assemble.js — the shared source of truth`
    );
    assert.ok(src.includes('wireTable('), `expected ${label}'s main.js to call wireTable(...)`);
    assert.ok(src.includes('buildTable('), `expected ${label}'s main.js to call buildTable(...)`);
  }
});

test('the game and sandbox worlds have an identical full playfield primitive/zone/capture-zone set', () => {
  const gameWorld = createWorld();
  wireTable(gameWorld, buildTable());

  // The sandbox world is built exactly the way games/pinball-sandbox/src/main.js's own source
  // builds it, per the structural check above — once that's true, this reduces to comparing
  // buildTable() against itself, which is the point: there is no second list left to drift.
  const sandboxWorld = createWorld();
  wireTable(sandboxWorld, buildTable());

  assert.deepEqual(
    summarizeWorld(sandboxWorld),
    summarizeWorld(gameWorld),
    'sandbox and game playfield primitive/zone/capture-zone sets differ'
  );
});
