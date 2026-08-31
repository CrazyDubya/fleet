import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlipper, setActive, updateFlipper, flipperEntry } from '../src/physics/flipper.js';
import { stepBall } from '../src/physics/solver.js';
import { length } from '../src/physics/vec2.js';
import { E_FLIPPER, FLIPPER, MU, K_DRAG, STEP_DT } from '../src/physics/constants.js';

function makeLowerLeftFlipper() {
  return createFlipper({
    pivot: { x: -0.078, y: 0.105 },
    length: FLIPPER.lower.length,
    radius: 0.012,
    restAngleDeg: FLIPPER.lower.restAngle,
    activeAngleDeg: FLIPPER.lower.activeAngle,
    upMs: FLIPPER.lower.upMs,
    downMs: FLIPPER.lower.downMs,
    restitution: E_FLIPPER,
  });
}

function flipAndMeasure(flipper, alongLengthFraction) {
  const restRad = (flipper.restAngle);
  const along = alongLengthFraction * flipper.length;
  const contact = {
    x: flipper.pivot.x + Math.cos(restRad) * along,
    y: flipper.pivot.y + Math.sin(restRad) * along,
  };
  // Outward normal at this point on the shaft (perpendicular to the flipper's length).
  const nx = -Math.sin(restRad);
  const ny = Math.cos(restRad);
  const ballRadius = 0.0135;
  const clearance = ballRadius + flipper.radius + 0.0005;
  const ball = { pos: { x: contact.x + nx * clearance, y: contact.y + ny * clearance }, vel: { x: 0, y: 0 }, radius: ballRadius };
  const tuning = { mu: MU, kDrag: K_DRAG, maxImpacts: 8 };

  setActive(flipper, true);
  let maxSpeed = 0;
  for (let i = 0; i < 15; i++) {
    updateFlipper(flipper, STEP_DT);
    stepBall(ball, { x: 0, y: -1.11 }, [flipperEntry(flipper)], STEP_DT, tuning);
    maxSpeed = Math.max(maxSpeed, length(ball.vel));
  }
  return maxSpeed;
}

test('a resting ball touching the flipper tip is launched at >= 4.5 m/s when flipped', () => {
  const flipper = makeLowerLeftFlipper();
  const speed = flipAndMeasure(flipper, 1.0);
  assert.ok(speed >= 4.5, `expected >= 4.5 m/s at the tip, got ${speed}`);
});

test('a resting ball touching the flipper at 0.8x length is also launched at >= 4.5 m/s', () => {
  // Matches the operator's own live-browser measurement point, not just the exact tip.
  const flipper = makeLowerLeftFlipper();
  const speed = flipAndMeasure(flipper, 0.8);
  assert.ok(speed >= 4.5, `expected >= 4.5 m/s at 0.8x length, got ${speed}`);
});

test('a ball cannot pass through a flipper mid-sweep at high approach speed', () => {
  const flipper = makeLowerLeftFlipper();
  setActive(flipper, false);
  const tuning = { mu: MU, kDrag: 0, maxImpacts: 8 };

  // Ball fired straight down through where the flipper capsule sits, at high speed,
  // while the flipper is mid-sweep (activating).
  setActive(flipper, true);
  const ball = { pos: { x: flipper.pivot.x + 0.03, y: flipper.pivot.y + 0.2 }, vel: { x: 0, y: -15 }, radius: 0.0135 };

  let below = false;
  for (let i = 0; i < 60; i++) {
    updateFlipper(flipper, STEP_DT);
    const primitives = [flipperEntry(flipper)];
    stepBall(ball, { x: 0, y: -1.11 }, primitives, STEP_DT, tuning);
    // The flipper capsule spans from pivot (y=0.105) to at most length above it;
    // the ball should never end up more than a hair below the pivot's y once it has
    // been below the flipper line, i.e. it must have bounced, not tunneled.
    if (ball.pos.y < flipper.pivot.y - 0.05) below = true;
  }
  // With a flipper in the way, the ball should bounce back up, not end up far below the pivot.
  assert.equal(below, false, `ball tunneled past the flipper: final y=${ball.pos.y}`);
});
