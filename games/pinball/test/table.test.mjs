import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, addBall, addFlipper, advance } from '../src/physics/world.js';
import { createFlipper } from '../src/physics/flipper.js';
import { BALL_RADIUS, PLUNGER_MAX_SPEED, STEP_DT } from '../src/physics/constants.js';
import * as recess from '../src/table/recess.js';

function makeGame() {
  const world = createWorld();
  setLayerPrimitives(world, 'playfield', recess.buildWalls().map((shape) => ({ shape })));
  for (const cfg of recess.buildFlipperConfigs()) addFlipper(world, createFlipper(cfg));
  const ball = addBall(world, { id: 'b0', pos: { ...recess.LAUNCH_POSITION }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS });
  return { world, ball };
}

test('a full plunge escapes the launch lane into the main field', () => {
  const { world, ball } = makeGame();
  ball.vel = { x: 0, y: PLUNGER_MAX_SPEED };

  let enteredField = false;
  for (let i = 0; i < 600; i++) {
    advance(world, STEP_DT);
    if (ball.pos.x < recess.LANE_INNER_X - 0.001) {
      enteredField = true;
      break;
    }
  }
  assert.ok(enteredField, 'ball never crossed from the launch lane into the main field');
});

test('the ball never escapes the table bounds while orbiting after a plunge, until it drains', () => {
  // There is no bottom wall (T3b) — the ball is expected to eventually fall through the
  // open drain (y < 0). This test only bounds it while it's still on the playfield.
  const { world, ball } = makeGame();
  ball.vel = { x: 0, y: PLUNGER_MAX_SPEED };

  for (let i = 0; i < 240 * 8; i++) {
    advance(world, STEP_DT);
    if (recess.isDrained(ball)) break;
    assert.ok(
      ball.pos.x >= -recess.HALF_WIDTH - 1e-3 && ball.pos.x <= recess.LANE_OUTER_X + 1e-3 &&
      ball.pos.y <= recess.HEIGHT + 1e-3,
      `ball escaped table bounds at (${ball.pos.x}, ${ball.pos.y}), step ${i}`
    );
  }
});

test('a ball falling straight through the open drain is detected as drained', () => {
  // No flippers here — this isolates geometric drain detection from flipper-miss timing,
  // which is a gameplay concern, not a table-wiring one. There is no bottom wall at all
  // (T3b), so the full wall set already leaves the drain open.
  const world = createWorld();
  setLayerPrimitives(world, 'playfield', recess.buildWalls().map((shape) => ({ shape })));
  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: 0.2 }, vel: { x: 0, y: -6 }, radius: BALL_RADIUS });

  let drained = false;
  for (let i = 0; i < 240 * 2 && !drained; i++) {
    advance(world, STEP_DT);
    if (recess.isDrained(ball)) drained = true;
  }
  assert.ok(drained, 'ball aimed straight down the middle was never detected as drained');
});

test('a resting ball dropped anywhere in the lower third always reaches the drain within 3s', () => {
  // Regression test for the T3 checkpoint failure: a flat bottom wall with a drain gap let
  // a ball come to rest in a corner forever. The T3b fix replaces it with apron walls that
  // converge toward the centre with no horizontal segments, so nothing can rest below the
  // flippers. Sweep 20 seeded points across the lower third at zero velocity (flippers at
  // rest, untouched) and assert every one drains within 3 simulated seconds.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(12345);
  const walls = recess.buildWalls();
  const margin = BALL_RADIUS + 0.005;

  function tooCloseToAWall(x, y) {
    for (const seg of walls) {
      const abx = seg.b.x - seg.a.x, aby = seg.b.y - seg.a.y;
      const len2 = abx * abx + aby * aby || 1;
      let t = ((x - seg.a.x) * abx + (y - seg.a.y) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = seg.a.x + t * abx, py = seg.a.y + t * aby;
      if (Math.hypot(x - px, y - py) < margin) return true;
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
    } while (tooCloseToAWall(x, y) && attempts < 50);

    const { world, ball } = (() => {
      const w = createWorld();
      setLayerPrimitives(w, 'playfield', walls.map((shape) => ({ shape })));
      for (const cfg of recess.buildFlipperConfigs()) addFlipper(w, createFlipper(cfg));
      const b = addBall(w, { id: 'b0', pos: { x, y }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS });
      return { world: w, ball: b };
    })();

    let drained = false;
    for (let t = 0; t < 240 * 3 && !drained; t++) {
      advance(world, STEP_DT);
      if (recess.isDrained(ball)) drained = true;
    }
    if (!drained) failures.push({ x, y, final: { ...ball.pos } });
  }
  assert.equal(failures.length, 0, `points that never drained within 3s: ${JSON.stringify(failures)}`);
});

test('after draining, a fresh ball served back into the launch lane is no longer drained', () => {
  const ball = { pos: { x: 0, y: -0.01 }, vel: { x: 0, y: -1 }, radius: BALL_RADIUS };
  assert.ok(recess.isDrained(ball));

  ball.pos = { ...recess.LAUNCH_POSITION };
  ball.vel = { x: 0, y: 0 };
  assert.ok(!recess.isDrained(ball));
  assert.ok(ball.pos.x > recess.LANE_INNER_X, 'served ball should be back in the launch lane');
});
