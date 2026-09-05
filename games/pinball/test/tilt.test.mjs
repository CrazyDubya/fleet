// TILT — TEACHER'S WATCHING (design §4.4). Tests the bob (rules/tilt.js) directly: pure,
// deterministic, no THREE/DOM. Every cadence figure asserted here was measured against this
// real module with a probe script during tuning, not picked to make a test pass — see
// rules/tilt.js's own TUNING comment for the same numbers restated with their reasoning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiltBob, resetTiltBob, nudgeTiltBob, tickTiltBob } from '../src/rules/tilt.js';

const FRAME_DT = 1 / 60;

/** Advances the bob by exactly `seconds` of decay (no nudges), in FRAME_DT-sized steps —
 * mirrors how main.js actually calls tickTiltBob once per rendered frame. */
function decay(bob, seconds) {
  let t = 0;
  const results = [];
  while (t < seconds) {
    const step = Math.min(FRAME_DT, seconds - t);
    const r = tickTiltBob(bob, step);
    if (r) results.push(r);
    t += step;
  }
  return results;
}

test('a single isolated keyboard-style nudge never warns', () => {
  const bob = createTiltBob();
  const r = nudgeTiltBob(bob, { x: 0, y: 1 });
  assert.equal(r, null);
  assert.equal(decay(bob, 3).length, 0, 'decaying alone must never produce a warning');
  assert.equal(bob.warnings, 0);
});

test('measured: two 1-unit nudges <=116ms apart warn on the second; >=117ms apart, never', () => {
  function secondNudgeResult(gapS) {
    const bob = createTiltBob();
    nudgeTiltBob(bob, { x: 0, y: 1 });
    decay(bob, gapS);
    return nudgeTiltBob(bob, { x: 0, y: 1 });
  }
  assert.equal(secondNudgeResult(0.116), 'warning');
  assert.equal(secondNudgeResult(0.117), null);
  // And staying well spaced never accumulates, however many times it's repeated.
  const bob = createTiltBob();
  for (let i = 0; i < 10; i++) {
    const r = nudgeTiltBob(bob, { x: 0, y: 1 });
    assert.equal(r, null, `nudge ${i}, well-spaced, must not warn`);
    decay(bob, 1.5);
  }
  assert.equal(bob.warnings, 0);
});

test('measured: sustained 1-unit nudging every 80ms escalates warning, warning, tilt by the 9th nudge', () => {
  const bob = createTiltBob();
  const events = [];
  for (let n = 0; n < 40 && !bob.tilted; n++) {
    if (n > 0) decay(bob, 0.08);
    const r = nudgeTiltBob(bob, { x: 0, y: 1 });
    if (r) events.push({ nudge: n, event: r });
  }
  assert.deepEqual(events, [
    { nudge: 1, event: 'warning' },
    { nudge: 2, event: 'warning' },
    { nudge: 9, event: 'tilt' },
  ]);
  assert.equal(bob.tilted, true);
  assert.equal(bob.warnings, 3);
});

test('measured: sustained 1-unit nudging every 100ms plateaus at exactly 2 warnings (never a 3rd in 300 nudges)', () => {
  const bob = createTiltBob();
  let warnings = 0;
  for (let n = 0; n < 300; n++) {
    if (n > 0) decay(bob, 0.1);
    const r = nudgeTiltBob(bob, { x: 0, y: 1 });
    if (r) warnings++;
  }
  assert.equal(warnings, 2);
  assert.equal(bob.tilted, false);
});

test('measured: sustained 1-unit nudging every 115ms plateaus at exactly 1 warning (never a 2nd in 300 nudges)', () => {
  const bob = createTiltBob();
  let warnings = 0;
  for (let n = 0; n < 300; n++) {
    if (n > 0) decay(bob, 0.115);
    const r = nudgeTiltBob(bob, { x: 0, y: 1 });
    if (r) warnings++;
  }
  assert.equal(warnings, 1);
  assert.equal(bob.tilted, false);
});

test('measured: sustained 1-unit nudging every 120ms never warns at all', () => {
  const bob = createTiltBob();
  let warnings = 0;
  for (let n = 0; n < 300; n++) {
    if (n > 0) decay(bob, 0.12);
    const r = nudgeTiltBob(bob, { x: 0, y: 1 });
    if (r) warnings++;
  }
  assert.equal(warnings, 0);
});

test('a bare-minimum touch swipe (40px) reads as about one nudge-unit, same as a keypress', () => {
  const bob = createTiltBob();
  const r = nudgeTiltBob(bob, { x: 0, y: 40 });
  assert.equal(r, null, 'the smallest swipe input.js allows must not itself warn');
  assert.ok(Math.abs(bob.vel.y - 4) < 1e-9, 'a 40px swipe should impart ~the same bob velocity as a keyboard nudge');
});

test('measured: a touch swipe needs to reach ~300-320px before it alone slam-tilts', () => {
  assert.notEqual(nudgeTiltBob(createTiltBob(), { x: 0, y: 300 }), 'slam');
  assert.equal(nudgeTiltBob(createTiltBob(), { x: 0, y: 320 }), 'slam');
});

test('a slam sets bob.tilted and further nudges/ticks are inert', () => {
  const bob = createTiltBob();
  const r = nudgeTiltBob(bob, { x: 0, y: 1000 });
  assert.equal(r, 'slam');
  assert.equal(bob.tilted, true);
  assert.equal(nudgeTiltBob(bob, { x: 0, y: 1 }), null);
  assert.equal(tickTiltBob(bob, 1), null);
});

test('resetTiltBob clears warnings, tilted state and residual motion for a new ball', () => {
  const bob = createTiltBob();
  for (let n = 0; n < 18; n++) {
    if (n > 0) decay(bob, 0.08);
    nudgeTiltBob(bob, { x: 0, y: 1 });
  }
  assert.equal(bob.tilted, true);
  resetTiltBob(bob);
  assert.equal(bob.tilted, false);
  assert.equal(bob.warnings, 0);
  assert.deepEqual(bob.vel, { x: 0, y: 0 });
  assert.deepEqual(bob.pos, { x: 0, y: 0 });
  // Fully functional again after reset.
  const events = [];
  for (let n = 0; n < 18 && !bob.tilted; n++) {
    if (n > 0) decay(bob, 0.08);
    const r = nudgeTiltBob(bob, { x: 0, y: 1 });
    if (r) events.push(r);
  }
  assert.equal(bob.tilted, true, 'the same cadence that tilted before reset must tilt again after it');
});

test('a warning taken on one ball does not carry into the next', () => {
  // Ball 1: one real warning (a fast pair of nudges), then the ball ends WITHOUT tilting.
  const bob = createTiltBob();
  nudgeTiltBob(bob, { x: 0, y: 1 });
  decay(bob, 0.1); // <=116ms — see the measured boundary test above
  const firstBallWarning = nudgeTiltBob(bob, { x: 0, y: 1 });
  assert.equal(firstBallWarning, 'warning');
  assert.equal(bob.warnings, 1);
  assert.equal(bob.tilted, false);

  // Ball 2 (main.js calls this on every real 'ballServed' — see rules/tilt.js's own doc
  // comment and main.js's applyDisplayEvents): must start completely fresh, not at warnings=1.
  resetTiltBob(bob);
  assert.equal(bob.warnings, 0, 'ball 2 must not inherit ball 1\'s warning count');

  // Prove it behaviourally, not just by reading the field: the SAME 100ms cadence that plateaus
  // at exactly 2 warnings on a fresh bob (measured above) must still take 2 full warnings to
  // reach — if ball 1's warning had carried over, a single additional warning would already
  // read as 2 starting from n=0, or worse, an inherited count near 2 would tilt on what should
  // be only the 2nd real warning of ball 2.
  let warningsThisBall = 0;
  for (let n = 0; n < 300; n++) {
    if (n > 0) decay(bob, 0.1);
    const r = nudgeTiltBob(bob, { x: 0, y: 1 });
    if (r) warningsThisBall++;
  }
  assert.equal(warningsThisBall, 2, 'ball 2 must reach the same fresh-bob plateau as any new ball, not one warning short of tilting');
  assert.equal(bob.tilted, false, 'ball 2 must not tilt from a combined ball-1 + ball-2 warning count');
});

test('tickTiltBob is frame-rate independent: coarse and fine frame steps agree on the same cadence', () => {
  function tiltsAt(cadenceS, frameDt) {
    const bob = createTiltBob();
    let t = 0;
    for (let n = 0; n < 40 && !bob.tilted; n++) {
      const targetT = n * cadenceS;
      while (t < targetT) {
        const step = Math.min(frameDt, targetT - t);
        tickTiltBob(bob, step);
        t += step;
      }
      nudgeTiltBob(bob, { x: 0, y: 1 });
    }
    return bob.tilted;
  }
  // A slow (~12.5fps) and a fast (240Hz) frame clock must reach the same tilt/no-tilt verdict
  // for the same real-time cadence — the entire point of stepping the bob at a fixed internal
  // rate (rules/tilt.js's own doc comment) rather than integrating at the caller's raw dt.
  assert.equal(tiltsAt(0.08, 1 / 12.5), tiltsAt(0.08, 1 / 240));
  assert.equal(tiltsAt(0.5, 1 / 12.5), tiltsAt(0.5, 1 / 240));
});
