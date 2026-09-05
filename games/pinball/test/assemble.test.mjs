// table/assemble.js is the single source of truth for the playfield's primitives/zones/
// capture-zones/ramps, extracted from what was inline in main.js (2026-09-04) so
// the sandbox project's own main.js can call the identical function instead of re-listing
// builders by hand and falling behind (see table/assemble.js's header comment — that's
// exactly what happened: the sandbox never called buildSwingSetPosts or buildSpinners,
// caught by grep, not by its own parity test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/physics/world.js';
import { buildTable, wireTable } from '../src/table/assemble.js';
import * as recess from '../src/table/recess.js';
import * as mech from '../src/table/mechanisms.js';
import * as ramps from '../src/table/ramps.js';

test('buildTable assembles every known playfield contributor, with the right counts', () => {
  const table = buildTable();

  const expectedPrimitiveCount =
    recess.buildWalls().length +
    mech.buildPopBumpers().length +
    mech.buildSlingshots().left.length +
    mech.buildSlingshots().right.length +
    mech.buildHopscotchBank().targets.length +
    mech.buildSandBank().targets.length +
    1 + // treehouse
    mech.buildSwingSetPosts().length +
    1; // kickback
  assert.equal(table.primitives.length, expectedPrimitiveCount);

  const expectedZoneCount =
    mech.buildFunLanes().length +
    2 + // tetherball + pinwheel spinners
    3 + // slide/monkeyBars/tunnel gates
    1; // diverter gate
  assert.equal(table.zones.length, expectedZoneCount);

  assert.equal(table.captureZones.length, 2); // sandbox + merry-go-round
  assert.equal(table.rampTracks.length, 3); // slide/monkeyBars/tunnel

  // Every primitive/zone shape is a real physics shape (segment or circle), not a stray
  // undefined slipped in by a bad spread.
  for (const p of table.primitives) assert.ok(['segment', 'circle'].includes(p.shape.kind), p.shape.kind);
  for (const z of table.zones) assert.equal(z.kind, 'zone');
  for (const c of table.captureZones) assert.ok(typeof c.radius === 'number' && c.centre);
});

test('wireTable puts exactly buildTable()\'s lists onto the world\'s playfield layer', () => {
  const world = createWorld();
  const table = buildTable();
  wireTable(world, table);
  assert.deepEqual(world.layers.get('playfield'), table.primitives);
  assert.deepEqual(world.zones.get('playfield'), table.zones);
  assert.deepEqual(world.captureZones.get('playfield'), table.captureZones);
  assert.equal(world.ramps.size, 3);
  for (const ramp of table.rampTracks) assert.equal(world.ramps.get(ramp.id), ramp);
});

test('buildTable is pure: two calls produce structurally identical (deep-equal), independently-built data', () => {
  const a = buildTable();
  const b = buildTable();
  assert.deepEqual(a.primitives, b.primitives);
  assert.deepEqual(a.zones, b.zones);
  assert.deepEqual(a.captureZones, b.captureZones);
});
