import test from 'node:test';
import assert from 'node:assert/strict';
import { Segment, Arc, Circle } from '../src/physics/shapes.js';
import { sweepCircleSegment, sweepCircleCircle, sweepCircleArc, earliestImpact, stepBall } from '../src/physics/solver.js';
import { makeRng, range } from '../src/physics/rng.js';

test('sweepCircleSegment: ball moving straight into a horizontal wall finds exact TOI', () => {
  const seg = Segment({ x: -1, y: 0 }, { x: 1, y: 0 });
  const r = 0.1;
  const p0 = { x: 0, y: 1 };
  const v = { x: 0, y: -2 }; // 2 m/s down
  const hit = sweepCircleSegment(p0, v, r, seg, 10);
  assert.ok(hit);
  // Ball centre should be at y = r (0.1) at contact -> travelled 0.9 m at 2 m/s -> t = 0.45
  assert.ok(Math.abs(hit.t - 0.45) < 1e-6, `t=${hit.t}`);
  assert.ok(Math.abs(hit.normal.y - 1) < 1e-6);
});

test('sweepCircleSegment: grazing contact at segment endpoint is detected', () => {
  const seg = Segment({ x: 0, y: 0 }, { x: 1, y: 0 });
  const r = 0.1;
  // Ball passes just past the left endpoint, moving down, x slightly left of the segment start.
  const p0 = { x: -0.05, y: 1 };
  const v = { x: 0, y: -1 };
  const hit = sweepCircleSegment(p0, v, r, seg, 10);
  assert.ok(hit, 'expected an endpoint-capsule contact');
  // distance from (-0.05,0) to (0,0) is 0.05 < r=0.1, so it must clip the endpoint cap.
  const dx = hit.point.x - 0;
  const dy = hit.point.y - 0;
  assert.ok(Math.abs(Math.hypot(dx, dy)) < 1e-6, 'contact point should be the endpoint');
});

test('sweepCircleSegment: exact corner contact (perpendicular) resolves at the corner', () => {
  const seg = Segment({ x: 0, y: 0 }, { x: 1, y: 0 });
  const r = 0.1;
  const p0 = { x: 1.2, y: 0.2 };
  const v = { x: -1, y: -1 };
  const hit = sweepCircleSegment(p0, v, r, seg, 10);
  assert.ok(hit);
  assert.ok(hit.t > 0 && hit.t < 10);
});

test('sweepCircleCircle: post collision at exact TOI', () => {
  const post = Circle({ x: 0, y: 0 }, 0.02);
  const r = 0.0135;
  const p0 = { x: -1, y: 0 };
  const v = { x: 1, y: 0 };
  const hit = sweepCircleCircle(p0, v, r, post, 10);
  assert.ok(hit);
  const expectedT = (1 - (0.02 + 0.0135)) / 1;
  assert.ok(Math.abs(hit.t - expectedT) < 1e-6);
});

test('sweepCircleArc: ball outside an arc collides and reports correct angle range gating', () => {
  const arc = Arc({ x: 0, y: 0 }, 0.5, 0, Math.PI); // upper half circle
  const r = 0.02;
  // Approaching from directly above (angle = PI/2, inside range).
  const p0 = { x: 0, y: 2 };
  const v = { x: 0, y: -1 };
  const hit = sweepCircleArc(p0, v, r, arc, 10);
  assert.ok(hit);

  // Approaching from directly below (angle = -PI/2 == 3PI/2, outside [0, PI]) — should miss.
  const p1 = { x: 0, y: -2 };
  const v1 = { x: 0, y: 1 };
  const miss = sweepCircleArc(p1, v1, r, arc, 10);
  assert.equal(miss, null);
});

test('earliestImpact picks the nearer of two candidate walls', () => {
  const near = Segment({ x: -1, y: 0.5 }, { x: 1, y: 0.5 });
  const far = Segment({ x: -1, y: 0 }, { x: 1, y: 0 });
  const r = 0.05;
  const p0 = { x: 0, y: 2 };
  const v = { x: 0, y: -1 };
  const hit = earliestImpact(p0, v, r, [{ shape: far }, { shape: near }], 10);
  assert.equal(hit.primitive.shape, near);
});

test('stepBall: a ball dropped onto a floor settles without tunneling through it', () => {
  const floor = Segment({ x: -1, y: 0 }, { x: 1, y: 0 }, 0.3);
  const primitives = [{ shape: floor }];
  const ball = { pos: { x: 0, y: 0.5 }, vel: { x: 0, y: 0 }, radius: 0.02 };
  const gravity = { x: 0, y: -9.81 };
  const dt = 1 / 240;
  const tuning = { mu: 0.06, kDrag: 0.12, maxImpacts: 8 };

  for (let i = 0; i < 240 * 5; i++) {
    stepBall(ball, gravity, primitives, dt, tuning);
    assert.ok(ball.pos.y >= 0.02 - 1e-4, `tunneled at step ${i}, y=${ball.pos.y}`);
  }
});

test('anti-tunneling property: a fast ball fired at a wall from many angles never ends up outside', () => {
  const rng = makeRng(42);
  const halfW = 0.257;
  const halfH = 0.5335;
  const walls = [
    Segment({ x: -halfW, y: 0 }, { x: halfW, y: 0 }),
    Segment({ x: halfW, y: 0 }, { x: halfW, y: halfH * 2 }),
    Segment({ x: halfW, y: halfH * 2 }, { x: -halfW, y: halfH * 2 }),
    Segment({ x: -halfW, y: halfH * 2 }, { x: -halfW, y: 0 }),
  ].map((shape) => ({ shape }));

  const r = 0.0135;
  const tuning = { mu: 0.06, kDrag: 0.0, maxImpacts: 8 };
  const dt = 1 / 240;

  for (let trial = 0; trial < 10000; trial++) {
    const angle = range(rng, 0, Math.PI * 2);
    const speed = 20; // m/s, far above realistic in-game speeds
    const ball = {
      pos: { x: range(rng, -halfW + 0.05, halfW - 0.05), y: range(rng, 0.05, halfH * 2 - 0.05) },
      vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      radius: r,
    };
    // A handful of fixed steps is enough for a 20 m/s ball to reach a wall from centre.
    for (let i = 0; i < 6; i++) {
      stepBall(ball, { x: 0, y: 0 }, walls, dt, tuning);
    }
    assert.ok(
      ball.pos.x >= -halfW - 1e-3 && ball.pos.x <= halfW + 1e-3 &&
      ball.pos.y >= -1e-3 && ball.pos.y <= halfH * 2 + 1e-3,
      `trial ${trial}: ball escaped to (${ball.pos.x}, ${ball.pos.y}) at angle ${angle}`
    );
  }
});
