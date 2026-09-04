// The permanent version of the supplementary sweep that caught a real dead pocket tonight:
// table.test.mjs's own drain-sweep test (see its "a resting ball dropped anywhere in the
// lower third always reaches the drain within 3s") builds its world from
// recess.buildWalls() ONLY — it never includes anything from table/mechanisms.js, so it
// structurally cannot see a regression caused by a mechanism's collider (e.g. the swing-set
// posts added tonight). This test closes that gap: same seed, same sweep, but with the
// swing-set posts' colliders included, so a mechanism that creates a dead pocket fails a test
// instead of only ever showing up as a ball someone notices got stuck.
//
// This is deliberately NOT folded into table.test.mjs's own sweep — that test is about the
// TABLE (walls) being drain-complete on its own, with its own 3s budget for that (unchanged);
// this one is about mechanisms added on top of it not breaking that property, and needs its
// own budget because the table's own budget was measured before any mechanism collider
// existed in the lower third. Extend the primitive list here as more mechanisms gain physics,
// rather than widening table.test.mjs's scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, addBall, addFlipper, advance } from '../src/physics/world.js';
import { createFlipper } from '../src/physics/flipper.js';
import { BALL_RADIUS, STEP_DT } from '../src/physics/constants.js';
import * as recess from '../src/table/recess.js';
import * as mech from '../src/table/mechanisms.js';

// Measured 2026-09-04, this exact sweep (seed 12345, same primitive set as below), against
// the swing-set side-post colliders: the slowest of the 20 seeded points took 3.8417s to
// drain — (x=-0.019111065337434414, y=0.35490524882217866), nowhere near any post at rest,
// just delayed by a graze en route. The table-only sweep's 3s budget (table.test.mjs) predates
// any mechanism collider existing in the lower third — it was never measured against this.
// DRAIN_BUDGET_S is that measured max * 1.25, rounded up to the nearest 0.5s: 3.8417 * 1.25 =
// 4.802s -> 5.0s. A future collider that pushes some point's drain time past 5.0s fails this
// test loudly, with the same point/time evidence this comment records for the current one.
const DRAIN_BUDGET_S = 5.0;

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('a resting ball dropped anywhere in the lower third always reaches the drain within DRAIN_BUDGET_S, with mechanism colliders present', () => {
  const rand = mulberry32(12345);
  const walls = recess.buildWalls();
  const swingSetPosts = mech.buildSwingSetPosts();
  const primitives = [
    ...walls.map((shape) => ({ shape })),
    ...swingSetPosts.map((p) => ({ shape: p.shape })),
  ];
  const margin = BALL_RADIUS + 0.005;

  function tooClose(x, y) {
    for (const seg of walls) {
      const abx = seg.b.x - seg.a.x, aby = seg.b.y - seg.a.y;
      const len2 = abx * abx + aby * aby || 1;
      let t = ((x - seg.a.x) * abx + (y - seg.a.y) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = seg.a.x + t * abx, py = seg.a.y + t * aby;
      if (Math.hypot(x - px, y - py) < margin) return true;
    }
    for (const p of swingSetPosts) {
      if (Math.hypot(x - p.centre.x, y - p.centre.y) < mech.SWING_SET_POST_RADIUS + margin) return true;
    }
    return false;
  }

  const failures = [];
  for (let i = 0; i < 20; i++) {
    let x, y, attempts = 0;
    do {
      x = (rand() * 2 - 1) * (recess.HALF_WIDTH - margin);
      y = margin + rand() * (recess.HEIGHT / 3);
      attempts++;
    } while (tooClose(x, y) && attempts < 50);

    const world = createWorld();
    setLayerPrimitives(world, 'playfield', primitives);
    for (const cfg of recess.buildFlipperConfigs()) addFlipper(world, createFlipper(cfg));
    const ball = addBall(world, { id: 'b0', pos: { x, y }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS });

    let drained = false;
    for (let t = 0; t < Math.round(240 * DRAIN_BUDGET_S) && !drained; t++) {
      advance(world, STEP_DT);
      if (recess.isDrained(ball)) drained = true;
    }
    if (!drained) failures.push({ x, y, final: { ...ball.pos } });
  }
  assert.equal(failures.length, 0, `points that never drained within DRAIN_BUDGET_S (${DRAIN_BUDGET_S}s) with mechanism colliders present: ${JSON.stringify(failures)}`);
});
