import test from 'node:test';
import assert from 'node:assert/strict';
import { Segment, Arc, Circle } from '../src/physics/shapes.js';
import { sweepCircleSegment, sweepCircleCircle, sweepCircleArc, earliestImpact, stepBall } from '../src/physics/solver.js';
import { makeRng, range } from '../src/physics/rng.js';
import { createFlipper, flipperEntry } from '../src/physics/flipper.js';
import { FLIPPER, E_FLIPPER, BALL_RADIUS, MAX_IMPACTS, MU, K_DRAG, STEP_DT, gravityForPitch } from '../src/physics/constants.js';
import { LEFT_FLIPPER_PIVOT, RIGHT_FLIPPER_PIVOT, HALF_WIDTH, HEIGHT } from '../src/table/recess.js';

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
  // CONST-IMPORT: was the literal 0.0135, a silent copy of BALL_RADIUS — this is pure sweep
  // geometry (any radius would exercise the same math) but there's no reason for it to drift
  // from the real ball's radius when nothing here needs it to, so it now imports the constant
  // rather than shadowing it. expectedT is derived from `r` itself, not a second copy of the
  // number, so it re-pins automatically if BALL_RADIUS ever changes.
  const r = BALL_RADIUS;
  const p0 = { x: -1, y: 0 };
  const v = { x: 1, y: 0 };
  const hit = sweepCircleCircle(p0, v, r, post, 10);
  assert.ok(hit);
  const expectedT = (1 - (0.02 + r)) / 1;
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
  // CONST-IMPORT: -9.81 is deliberately NOT gravityForPitch() — this is a generic, unpitched
  // floor-settling stress test, independent of the table's own tilt, and a bare 1g is a
  // HARDER fall (more energy into each contact) than the shallow pitched table ever produces,
  // so it doesn't need to track whatever the real pitched value happens to be. mu/kDrag/
  // maxImpacts below WERE silent copies of MU/K_DRAG/MAX_IMPACTS with no reason to differ —
  // those import the real constants now.
  const gravity = { x: 0, y: -9.81 };
  const dt = STEP_DT;
  const tuning = { mu: MU, kDrag: K_DRAG, maxImpacts: MAX_IMPACTS };

  for (let i = 0; i < 240 * 5; i++) {
    stepBall(ball, gravity, primitives, dt, tuning);
    assert.ok(ball.pos.y >= 0.02 - 1e-4, `tunneled at step ${i}, y=${ball.pos.y}`);
  }
});

test('anti-tunneling property: a fast ball fired at a wall from many angles never ends up outside', () => {
  const rng = makeRng(42);
  // CONST-IMPORT: were the literals 0.257 and 0.5335 (= HEIGHT/2) — silent copies of the real
  // table's own HALF_WIDTH/HEIGHT rather than an arbitrary box. The containment property this
  // test checks holds at any box size, so a stale copy wouldn't have broken anything silently
  // — but there's no reason to pretend this box is unrelated to the real table when it isn't,
  // so it now imports the real dimensions instead of shadowing them.
  const halfW = HALF_WIDTH;
  const halfH = HEIGHT / 2;
  const walls = [
    Segment({ x: -halfW, y: 0 }, { x: halfW, y: 0 }),
    Segment({ x: halfW, y: 0 }, { x: halfW, y: halfH * 2 }),
    Segment({ x: halfW, y: halfH * 2 }, { x: -halfW, y: halfH * 2 }),
    Segment({ x: -halfW, y: halfH * 2 }, { x: -halfW, y: 0 }),
  ].map((shape) => ({ shape }));

  const r = BALL_RADIUS;
  // mu was a silent copy of MU with no reason to differ, now imported. kDrag is deliberately
  // 0, NOT K_DRAG — this test wants the ball to hold its full 20 m/s stress speed across all 6
  // fixed substeps of every trial; real drag would bleed speed step over step, quietly
  // weakening the stress test on later substeps instead of hitting the wall at the same
  // extreme speed throughout. That's why this one stays a literal.
  const tuning = { mu: MU, kDrag: 0, maxImpacts: MAX_IMPACTS };
  const dt = STEP_DT;

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

// stepBall's maxImpacts loop, exercised only by containment-only tests above (0 gravity or
// 20 m/s free flight in an open box — never more than 2 impacts/step, per the opus2 solver
// audit's own histogram over the anti-tunneling test's exact 60,000 stepBall calls). None of
// that catches under-advance: both sweep routines return { t: 0 } on immediate overlap, so
// `remaining -= hit.t` subtracts nothing and the loop can burn every iteration of maxImpacts
// without the clock moving at all — only the fixed 1mm pushout per iteration changes anything.
// The real-game trigger is two flippers raised at once: tip gap 0.0288m against a required
// 2*(flipper.radius+BALL_RADIUS)=0.0510m (see constants.js's own note on this same 51mm
// number, recorded for the *rest* angle — the active/raised angle was never checked against
// it), so a centred ball penetrates each capsule by 11.1mm and the two pushout normals
// oppose. This is a real, reachable state (a player holding both flippers up), not synthetic.
function raisedFlipperPrimitives() {
  const left = createFlipper({
    pivot: LEFT_FLIPPER_PIVOT, length: FLIPPER.lower.length,
    restAngleDeg: FLIPPER.lower.restAngle, activeAngleDeg: FLIPPER.lower.activeAngle,
    upMs: FLIPPER.lower.upMs, downMs: FLIPPER.lower.downMs, restitution: E_FLIPPER, tag: 'flipper-left',
  });
  const right = createFlipper({
    pivot: RIGHT_FLIPPER_PIVOT, length: FLIPPER.lower.length,
    restAngleDeg: 180 - FLIPPER.lower.restAngle, activeAngleDeg: 180 - FLIPPER.lower.activeAngle,
    upMs: FLIPPER.lower.upMs, downMs: FLIPPER.lower.downMs, restitution: E_FLIPPER, tag: 'flipper-right',
  });
  // Both fully up and held (angularVel 0, not mid-sweep) — a player trapping the ball, which
  // is the *harder* case: mid-sweep surface velocity can eventually kick a trapped ball clear
  // (opus2 measured an ~8-substep/33ms escape that way), but a held, stationary wedge has no
  // such rescue, so if the t=0 bug is present the ball never leaves at all.
  left.angle = left.activeAngle;
  right.angle = right.activeAngle;
  return { left, right, primitives: [flipperEntry(left), flipperEntry(right)] };
}

test('stepBall never returns with unconsumed time: held two-raised-flipper double-overlap wedge, real gravity and drag', () => {
  const { left, primitives } = raisedFlipperPrimitives();
  const gravity = gravityForPitch();
  const tuning = { mu: MU, kDrag: K_DRAG, maxImpacts: MAX_IMPACTS };
  const dt = STEP_DT; // CONST-IMPORT: was the literal 1/240, a silent copy of STEP_DT

  // Centred between the two raised tips (y = tip height), falling — the exact wedge opus2
  // measured against the current solver.
  const wedgeY = LEFT_FLIPPER_PIVOT.y + Math.sin(left.activeAngle) * FLIPPER.lower.length;
  const ball = { pos: { x: 0, y: wedgeY }, vel: { x: 0, y: -0.9 }, radius: BALL_RADIUS };

  for (let i = 0; i < 600; i++) {
    const events = stepBall(ball, gravity, primitives, dt, tuning);
    // The actual property: no time left unconsumed by the call. (events.length ===
    // maxImpacts was the original proxy for this, and still a fair health-check, but a fix
    // that resolves several overlapping primitives in one loop iteration can legitimately
    // push more than one event per iteration, so it's no longer 1:1 with "hit the cap".)
    assert.ok(
      Math.abs(events.remaining) < 1e-9,
      `substep ${i}: stepBall returned with ${events.remaining}s of dt unconsumed (${events.length} events)`
    );
  }
});

test('stepBall never returns with unconsumed time: a parameterised set of double-overlap starting offsets in the same wedge', () => {
  const gravity = gravityForPitch();
  const tuning = { mu: MU, kDrag: K_DRAG, maxImpacts: MAX_IMPACTS };
  const dt = STEP_DT; // CONST-IMPORT: was the literal 1/240, a silent copy of STEP_DT

  // Small starting offsets and fall speeds around the wedge centre — real variation in where
  // and how fast a ball enters a double-flipper trap, not just the single symmetric case.
  const offsets = [-0.006, -0.003, 0, 0.003, 0.006];
  const speeds = [0.3, 0.9, 1.6];

  for (const dx of offsets) {
    for (const speed of speeds) {
      const { left, primitives } = raisedFlipperPrimitives();
      const wedgeY = LEFT_FLIPPER_PIVOT.y + Math.sin(left.activeAngle) * FLIPPER.lower.length;
      const ball = { pos: { x: dx, y: wedgeY }, vel: { x: 0, y: -speed }, radius: BALL_RADIUS };

      for (let i = 0; i < 200; i++) {
        const events = stepBall(ball, gravity, primitives, dt, tuning);
        assert.ok(
          Math.abs(events.remaining) < 1e-9,
          `dx=${dx}, speed=${speed}, substep ${i}: stepBall returned with ${events.remaining}s ` +
          `of dt unconsumed (${events.length} events) — unconsumed time stranded in this double-overlap config`
        );
      }
    }
  }
});
