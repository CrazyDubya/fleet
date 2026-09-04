// LAB-23: what IMPACTS_EXHAUSTED actually measures, pinned so it cannot be relitigated.
//
// E4 Stage A2 refuses §2.7's gate at 21.783% flagged-excl-STALLED, with IMPACTS_EXHAUSTED at
// 21.634% over its non-stalled trials, while Stage A1 sits at 0.002%. The obvious reading —
// A2's extra contact surfaces genuinely saturate the solver — is wrong. The flag is a stale
// proxy, and these tests pin the mechanism.
//
// HOW THE FLAG IS SET (instrument.js, four sites):  stepEvents.length >= MAX_IMPACTS
// where `stepEvents` is what world.js's advance() returns for a whole STEP_DT: summed over
// every sub-step, every solver iteration, and every primitive resolved in each iteration,
// plus zone-crossing and capture events.
//
// WHAT THE SOLVER'S CAP ACTUALLY IS:  `maxImpacts` bounds the impact loop PER BALL, PER
// SUB-STEP. Since FLIPPER_SUBSTEPS is 24, one STEP_DT with a moving flipper runs 24 sub-steps,
// so the flag compares a 24-sub-step total against a 1-sub-step budget. That is a unit error,
// the same shape as summing both endpoints of a segment and reporting the total as one
// distance.
//
// solver.js says so itself, in the comment on the line that exposes the real signal:
//   "so a test can assert the actual property that matters — 'no unconsumed time' — directly,
//    instead of through the `events.length === maxImpacts` proxy that only worked before this
//    fix (which can now emit more than one event per iteration when several primitives
//    overlap at once)."
// The correct signal is `events.remaining`. world.js's advance() flattens the per-ball arrays
// into one and drops it, which is why the lab cannot currently see it.
//
// MEASURED on real A2 trajectories (1,022 trials, 3,778s simulated, every flagged step
// replayed through stepBall to read `remaining`):
//     trials flagged by today's metric      57.73%
//     trials that actually stranded time     0.49%
//     flagged steps that really stranded     5 of 89,192  (0.01%)
//     total stranded time            1.951e-3 s of 3,778 s  (5.2e-5 %)
// and the solver's budget is not close to binding: final positions are bit-identical in
// 718/720 trials between maxImpacts 8 and 128, and converge at maxImpacts = 4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepBall } from '../../pinball/src/physics/solver.js';
import { Segment } from '../../pinball/src/physics/shapes.js';
import { STEP_DT, BALL_RADIUS, MAX_IMPACTS, MU, K_DRAG } from '../../pinball/src/physics/constants.js';
import { FLIPPER_SUBSTEPS } from '../../pinball/src/physics/flipper.js';

const TUNING = { mu: MU, kDrag: K_DRAG, maxImpacts: MAX_IMPACTS };
const GRAVITY = { x: 0, y: -1.11 };

/** A ball already overlapping `n` surfaces — the rest state a pocket produces by design. */
function restingOn(n) {
  const prims = [{ shape: Segment({ x: -0.1, y: 0 }, { x: 0.1, y: 0 }, 0.45, 'floor') }];
  if (n >= 2) prims.push({ shape: Segment({ x: 0, y: -0.1 }, { x: 0, y: 0.1 }, 0.45, 'wall') });
  const d = 0.001;
  const ball = { pos: { x: BALL_RADIUS - d, y: BALL_RADIUS - d }, vel: { x: -0.05, y: -0.05 }, radius: BALL_RADIUS };
  return { prims, ball };
}

test('LAB-23: a two-surface rest contact trips IMPACTS_EXHAUSTED while stranding NO time', () => {
  const { prims, ball } = restingOn(2);
  const evs = stepBall(ball, GRAVITY, prims, STEP_DT, TUNING);

  // The flag's own condition, as instrument.js applies it.
  assert.ok(evs.length >= MAX_IMPACTS,
    `expected the flag to fire: ${evs.length} events vs threshold ${MAX_IMPACTS}`);

  // The property the flag is NAMED for. This is the whole finding.
  assert.equal(evs.remaining, 0,
    'the solver consumed the entire sub-step — no time was stranded, so nothing was exhausted');

  // And the count is not "many distinct collisions": it is a handful of surfaces resolved
  // repeatedly. 4 is solver.js's private ZERO_T_ESCAPE_AFTER — the backstop that exits the
  // zero-t loop AND sets remaining = 0, which is exactly why no time is lost.
  const perPrimitive = {};
  for (const e of evs) {
    const tag = (e.primitive.shape ?? e.primitive).tag;
    perPrimitive[tag] = (perPrimitive[tag] ?? 0) + 1;
  }
  assert.deepEqual(perPrimitive, { floor: 4, wall: 4 },
    'events = surfaces x the zero-t backstop, not distinct collisions');
});

test('LAB-23: the same contact on ONE surface stays under the threshold — this is A1 vs A2', () => {
  // Stage A1 configures only `guide`; A2 adds feed (124/217 cfgs), post (161/217) and
  // outlaneW (132/217). A ball at rest in A1 touches one surface, in A2's pocket it touches
  // two. Measured over real trials, A1's events-per-step histogram tops out at exactly 4 in
  // 537,674 steps and never once reaches 8; A2 spikes at exactly 8 (static flipper: 1 sub-step
  // x 2 surfaces x 4) and again at 179-192 (moving flipper: 24 sub-steps x ~8).
  // So the difference between the two stages is not solver quality — it is one surface versus
  // two, multiplied by a backstop constant, against a threshold that happens to sit at 8.
  const { prims, ball } = restingOn(1);
  const evs = stepBall(ball, GRAVITY, prims, STEP_DT, TUNING);
  assert.ok(evs.length < MAX_IMPACTS,
    `one surface should stay under the flag: got ${evs.length} events`);
  assert.equal(evs.remaining, 0);
});

test('LAB-23: the flag compares a whole-step total against a per-sub-step budget', () => {
  // A unit error, and its size is FLIPPER_SUBSTEPS. Pinned so that if anyone changes the
  // sub-step count again the inflation factor is re-read rather than assumed.
  assert.ok(FLIPPER_SUBSTEPS > 1,
    'while a flipper moves, advance() runs this many sub-steps and sums their events');
  assert.equal(MAX_IMPACTS, 8, "the solver's per-ball, per-sub-step iteration cap");
  // The flag would need a threshold of at least MAX_IMPACTS * FLIPPER_SUBSTEPS to be
  // comparing like with like — and even that is not sufficient, because one iteration can
  // emit one event per simultaneously-overlapping primitive. There is no correct threshold
  // on this quantity; the fix is to read `remaining`, not to re-tune a number.
  assert.ok(MAX_IMPACTS * FLIPPER_SUBSTEPS > MAX_IMPACTS);
});

test('LAB-23: advance() drops the signal the flag should be using', () => {
  // stepBall exposes it; world.js's advance() flattens the per-ball arrays into one and the
  // property does not survive. Documented here because it is the reason the corrected flag
  // cannot be built inside pinball-lab alone.
  const { prims, ball } = restingOn(2);
  const evs = stepBall(ball, GRAVITY, prims, STEP_DT, TUNING);
  assert.notEqual(evs.remaining, undefined, 'stepBall exposes `remaining`');
  const flattened = [...evs];
  assert.equal(flattened.remaining, undefined,
    'spreading into a new array loses it — exactly what advance() does to every ball\'s events');
});
