// LAB-23 follow-up: advance() must surface the solver's unconsumed-time budget.
//
// `stepBall` already exposes `events.remaining` — the seconds of the sub-step it could not
// consume, which is the ONLY signal that means "the impact loop ran out of iterations". Its
// own comment says so, and says why the older `events.length === maxImpacts` proxy no longer
// works: one iteration can now emit one event per simultaneously-overlapping primitive.
//
// advance() flattened every ball's array into one and dropped `remaining`, so its callers had
// no way to read the real thing and pinball-lab's IMPACTS_EXHAUSTED was set from the flattened
// COUNT instead. That compares a whole-step, all-ball, all-sub-step, all-primitive total
// against a per-ball per-sub-step budget — a unit error whose size is FLIPPER_SUBSTEPS.
//
// These tests pin the distinction itself: a flattened count crossing the cap while no budget
// was actually exhausted must NOT read as exhaustion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, addBall, advance } from '../src/physics/world.js';
import { stepBall } from '../src/physics/solver.js';
import { Segment } from '../src/physics/shapes.js';
import { STEP_DT, BALL_RADIUS, MAX_IMPACTS, MU, K_DRAG } from '../src/physics/constants.js';

const FLOOR = Segment({ x: -0.1, y: 0 }, { x: 0.1, y: 0 }, 0.45, 'floor');
const WALL = Segment({ x: 0, y: -0.1 }, { x: 0, y: 0.1 }, 0.45, 'wall');

/** A ball seeded already overlapping two surfaces — the rest state a pocket produces. */
function twoSurfaceWorld() {
  const world = createWorld();
  setLayerPrimitives(world, 'playfield', [FLOOR, WALL]);
  const d = 0.001;
  const ball = addBall(world, {
    id: 'b', pos: { x: BALL_RADIUS - d, y: BALL_RADIUS - d },
    vel: { x: -0.05, y: -0.05 }, radius: BALL_RADIUS,
  });
  return { world, ball };
}

test('advance() exposes `remaining`, the unconsumed-time budget stepBall already reported', () => {
  const { world } = twoSurfaceWorld();
  const events = advance(world, STEP_DT);
  assert.notEqual(events.remaining, undefined,
    'advance() must surface the solver signal, not only the event list');
  assert.equal(typeof events.remaining, 'number');
});

test('THE UNIT DISTINCTION: a flattened count over the cap with no budget exhausted must not read as exhaustion', () => {
  // This is the exact configuration that made E4 Stage A2 refuse §2.7 at 21.6%.
  const { world } = twoSurfaceWorld();
  const events = advance(world, STEP_DT);

  // The old proxy fires...
  assert.ok(events.length >= MAX_IMPACTS,
    `the flattened count crosses the cap: ${events.length} events vs ${MAX_IMPACTS}`);

  // ...while nothing was actually exhausted. Both must hold, or the test proves nothing.
  assert.equal(events.remaining, 0,
    'no sub-step left time unconsumed, so no impact budget was exhausted');
});

test('advance() sums `remaining` across balls and sub-steps rather than reporting one of them', () => {
  const world = createWorld();
  setLayerPrimitives(world, 'playfield', [FLOOR, WALL]);
  const d = 0.001;
  for (const id of ['a', 'b', 'c']) {
    addBall(world, { id, pos: { x: BALL_RADIUS - d, y: BALL_RADIUS - d }, vel: { x: -0.05, y: -0.05 }, radius: BALL_RADIUS });
  }
  const events = advance(world, STEP_DT);
  // Three identical balls in the same corner: the count triples, the budget stays consumed.
  assert.ok(events.length >= 3 * MAX_IMPACTS, `expected ~3x the events, got ${events.length}`);
  assert.equal(events.remaining, 0);
});

test('advance() reports a REAL exhaustion — a starved impact budget leaves time unconsumed', () => {
  // Drive maxImpacts down until the loop genuinely cannot finish. This is the case the flag is
  // named for, and it must still be detected once the metric is switched over.
  const world = createWorld({ tuning: { maxImpacts: 1 } });
  setLayerPrimitives(world, 'playfield', [FLOOR, WALL]);
  const d = 0.001;
  addBall(world, { id: 'b', pos: { x: BALL_RADIUS - d, y: BALL_RADIUS - d }, vel: { x: -0.05, y: -0.05 }, radius: BALL_RADIUS });
  const events = advance(world, STEP_DT);
  assert.ok(events.remaining > 0,
    `a 1-impact budget in a two-surface corner must strand time, got remaining=${events.remaining}`);
});

test('advance() agrees with stepBall on the same single-ball step', () => {
  // Guards the accumulation itself: no double-counting, no dropped ball.
  const { world, ball } = twoSurfaceWorld();
  const solo = { pos: { ...ball.pos }, vel: { ...ball.vel }, radius: ball.radius };
  const direct = stepBall(solo, world.gravity, [{ shape: FLOOR }, { shape: WALL }], STEP_DT,
    { mu: MU, kDrag: K_DRAG, maxImpacts: MAX_IMPACTS });
  const events = advance(world, STEP_DT);
  assert.equal(events.remaining, direct.remaining);
});
