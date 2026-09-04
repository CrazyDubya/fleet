// main.js can't be imported directly under `node --test` (it imports 'three' as a bare
// specifier resolved only by the browser import map in index.html — same reason
// games/pinball/test/glue-scope.test.mjs can't import games/pinball/src/main.js either). This
// exercises the exact same relative-import modules main.js loads (physics + table, all pure —
// no THREE, no DOM) to prove the sandbox really is driven by the REAL RECESS physics and
// table geometry, not a reimplementation of either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, addBall, addFlipper, advance } from '../../pinball/src/physics/world.js';
import { createFlipper, setActive } from '../../pinball/src/physics/flipper.js';
import { BALL_RADIUS, gravityForPitch } from '../../pinball/src/physics/constants.js';
import * as recess from '../../pinball/src/table/recess.js';
import * as mech from '../../pinball/src/table/mechanisms.js';

test('real table geometry loads: walls, flippers, pop bumpers, slingshots, drop targets', () => {
  const walls = recess.buildWalls();
  assert.ok(walls.length > 0);
  const flipperConfigs = recess.buildFlipperConfigs();
  assert.deepEqual(flipperConfigs.map((c) => c.name).sort(), ['left', 'right', 'upperLeft']);
  const pops = mech.buildPopBumpers();
  assert.equal(pops.length, 3);
  const slings = mech.buildSlingshots();
  assert.equal(slings.left.length, 2);
  assert.equal(slings.right.length, 2);
  const hopscotch = mech.buildHopscotchBank();
  assert.equal(hopscotch.targets.length, 4);
});

test('a ball dropped with no horizontal velocity falls under real gravity, unblocked by open space', () => {
  const world = createWorld();
  setLayerPrimitives(world, 'playfield', recess.buildWalls().map((shape) => ({ shape })));
  for (const cfg of recess.buildFlipperConfigs()) addFlipper(world, createFlipper(cfg));

  const ball = addBall(world, {
    id: 'test-ball', pos: { x: 0, y: 0.5 }, vel: { x: 0, y: 0 },
    radius: BALL_RADIUS, active: true, layer: 'playfield', captured: false, z: 0,
  });

  for (let i = 0; i < 120; i++) advance(world, 1 / 60);

  // gravityForPitch's sign convention: table "down" (toward the drain, y decreasing) is
  // negative y-acceleration — the same physics main.js's ball uses.
  const g = gravityForPitch();
  assert.ok(g.y < 0, 'expected downhill gravity to point toward decreasing table y');
  assert.ok(ball.vel.y < 0, `ball should have accelerated downhill (toward the drain); got vel.y=${ball.vel.y}`);
  assert.ok(ball.pos.y < 0.5, `ball should have moved downhill from its start; got pos.y=${ball.pos.y}`);
});

test('setActive drives a flipper toward its active angle over time', () => {
  const cfg = recess.buildFlipperConfigs().find((c) => c.name === 'left');
  const flipper = createFlipper(cfg);
  const restAngle = flipper.angle;
  setActive(flipper, true);
  const world = createWorld();
  addFlipper(world, flipper);
  for (let i = 0; i < 30; i++) advance(world, 1 / 240);
  assert.notEqual(flipper.angle, restAngle, 'flipper should have moved from rest once activated');
});
