import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlipper, setActive, updateFlipper, flipperEntry, isFlipperMoving, FLIPPER_SUBSTEPS } from '../src/physics/flipper.js';
import { stepBall } from '../src/physics/solver.js';
import { length } from '../src/physics/vec2.js';
import { E_FLIPPER, FLIPPER, MU, K_DRAG, STEP_DT, MAX_IMPACTS, BALL_RADIUS, gravityForPitch } from '../src/physics/constants.js';
import { LEFT_FLIPPER_PIVOT } from '../src/table/recess.js';

// GRAVITY-ROLL audit (operator, FLIPPER-EXIT-ADDENDUM): this file held its own copy of gravity
// (`{ x: 0, y: -1.11 }`, the OLD sliding-point-mass value) at three sites instead of importing
// gravityForPitch — meaning every test below ran pre-GRAVITY-ROLL physics regardless of what
// shipped in constants.js, and passed anyway, which is how the suite stayed green through a
// 29% gravity change here specifically. Fixed: one real import, used at all three sites.
const GRAVITY = gravityForPitch();

function makeLowerLeftFlipper(eFlipper = E_FLIPPER, upMs = FLIPPER.lower.upMs) {
  return createFlipper({
    // CONST-IMPORT: was the literal { x: -0.078, y: 0.105 }, a silent copy of the real
    // LEFT_FLIPPER_PIVOT — pivot position drives every exit-speed measurement in this file, so
    // a stale copy here would have quietly kept characterising a flipper that no longer exists.
    pivot: LEFT_FLIPPER_PIVOT,
    length: FLIPPER.lower.length,
    radius: 0.012,
    restAngleDeg: FLIPPER.lower.restAngle,
    activeAngleDeg: FLIPPER.lower.activeAngle,
    upMs,
    downMs: FLIPPER.lower.downMs,
    restitution: eFlipper,
  });
}

// Sub-steps the flipper/collision resolution while the flipper is moving — the same fix
// world.js's real `advance()` applies (physics/world.js, physics/flipper.js's FLIPPER_SUBSTEPS/
// isFlipperMoving), reproduced here because this harness hand-rolls its own loop rather than
// going through world.js. Same total simulated span as before (15 * STEP_DT = 62.5ms), just
// resolved at STEP_DT/FLIPPER_SUBSTEPS while the flipper hasn't yet reached its target angle.
// `substepOverride` lets tests below demonstrate the difference between the shipped resolution
// and the earlier, rejected one (see the comment block).
function flipAndMeasure(flipper, alongLengthFraction, substepOverride = FLIPPER_SUBSTEPS) {
  const restRad = (flipper.restAngle);
  const along = alongLengthFraction * flipper.length;
  const contact = {
    x: flipper.pivot.x + Math.cos(restRad) * along,
    y: flipper.pivot.y + Math.sin(restRad) * along,
  };
  // Outward normal at this point on the shaft (perpendicular to the flipper's length).
  const nx = -Math.sin(restRad);
  const ny = Math.cos(restRad);
  const ballRadius = BALL_RADIUS; // CONST-IMPORT: was the literal 0.0135
  const clearance = ballRadius + flipper.radius + 0.0005;
  const ball = { pos: { x: contact.x + nx * clearance, y: contact.y + ny * clearance }, vel: { x: 0, y: 0 }, radius: ballRadius };
  const tuning = { mu: MU, kDrag: K_DRAG, maxImpacts: MAX_IMPACTS };

  setActive(flipper, true);
  let maxSpeed = 0;
  for (let i = 0; i < 15; i++) {
    const substeps = isFlipperMoving(flipper) ? substepOverride : 1;
    const subDt = STEP_DT / substeps;
    for (let s = 0; s < substeps; s++) {
      updateFlipper(flipper, subDt);
      stepBall(ball, GRAVITY, [flipperEntry(flipper)], subDt, tuning);
      maxSpeed = Math.max(maxSpeed, length(ball.vel));
    }
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

// ===========================================================================================
// SUBSTEP FIX — TWO PASSES. First pass (2026-09-04, ledger/handoffs/opus2/20260904T180000Z-
// true-to-physics-standard.md, operator 1a06e365c6d60fcd) shipped FLIPPER_SUBSTEPS=4. ROOT
// CAUSE it addressed: the lower flipper sweeps 82 degrees in 14ms while the world resolved
// collisions at STEP_DT=1/240s — 3.36 substeps for the whole stroke, 31.9mm of tip travel per
// substep against a 27mm ball, so the tip swept clean through the ball's position and
// re-struck it every substep until the stroke ended (13 contacts at the tip, peak exit speed
// non-monotonic in E_FLIPPER as a result).
//
// SECOND PASS (2026-09-04, ledger/handoffs/opus2/20260904T215500Z-experiment-a-run.md, operator
// 1a06e5f2e6854a70): N=4 was WRONG, not just insufficient. Running Experiment A properly (fit
// v_out against v_in with the solver's full event list, not the summary) found N=4 still
// resolves 3-6 contacts depending on e, each a deterministic composite of the single-impact
// algebra (exit speed after k applications of resolve() has slope e^k, not e) — and that
// composite happens to be monotonic, but in the WRONG DIRECTION: peak speed FALLS as E_FLIPPER
// RISES, and has NO relation to contact radius along the bat. Both are physically backwards (a
// bouncier bat must throw a faster ball; a strike further from the pivot, at higher surface
// speed, must throw a faster ball too). The TWO PHYSICALLY OBLIGATORY criteria — peak rises
// with e, peak rises with contact radius — first hold at N=24 (tip travel 1.33mm/substep),
// where every stroke resolves as one genuine impact (k=1) at every e and every contact point
// tested. STEP_DT itself, upMs, every angle and every restitution remain UNCHANGED throughout
// both passes — only FLIPPER_SUBSTEPS moved, from the (wrong) monotonicity criterion to the
// (right) rises-with-e / rises-with-radius criteria.
//
//   1. CONTACTS PER FLIP, at the tip, E_FLIPPER=0.85 (current):
//        BEFORE (STEP_DT only, N=1): 13
//        N=4  (first, rejected):      4
//        N=24 (shipped):               1   <- the genuine single-impact regime
//
//   2. PEAK EXIT SPEED vs E_FLIPPER, tip contact:
//        E_FLIPPER   peak N=1(BEFORE)   peak N=4(rejected)   peak N=24(shipped)   analytic (1+e)*u
//          0.70          7.3852              7.0393               13.0315            13.0339
//          0.80          6.7952              6.7389               13.7981            13.8006
//          0.85          6.3123              6.3874               14.1814            14.1839  <- current
//          0.88          5.8242              6.1970               14.4113                 -
//          0.90         10.7027              6.0201               14.5647            14.5673
//          0.92          2.0654              5.8517               14.7180                 -
//          0.96          1.2936              5.3802               15.0246            15.0273
//      N=1: not monotonic at all. N=4: monotonic DECREASING — the wrong direction; a bouncier
//      bat throwing a SLOWER ball is not physical. N=24: monotonic INCREASING, matching the
//      analytic single-impact answer (1+e)*u to within 0.02% at every sampled e. THIS is the
//      criterion that matters, not "monotonic" alone in either direction.
//
//   3. PEAK RISES WITH CONTACT RADIUS (E_FLIPPER=0.85) — untested at N=4 the first time, and
//      the second criterion Experiment A found fails there:
//        contact point   peak N=4(rejected)   peak N=24(shipped)   analytic (1+e)*omega*r
//          0.6x length        8.8620               8.5962                 8.5104
//          0.7x length        7.4622              10.0143                 9.9287
//          0.8x length        9.1791              11.4325                11.3471
//          0.9x length        8.2648              12.8506                12.7655
//          1.0x length        6.3874              14.1814                14.1839
//      N=4: no relation to radius (a player striking further out sometimes gets a SLOWER ball —
//      compare 0.7x's 7.46 against 0.6x's 8.86). N=24: rises with radius at every step,
//      matching (1+e)*omega*r within ~1%.
//
//   4. PEAK vs SEPARATION at N=24 — still not identical (drag/gravity act over the substeps
//      after the single impact), but both readings agree the exit speed is far above the doc's
//      6.0 m/s ceiling, so which one the doc's range means no longer changes the conclusion the
//      way it did when they were 1.8x apart under N=1.
//
// COST, MEASURED (not asserted by a test — this was a one-time decision, recorded here): one
// full flip stroke, real fully-assembled table, 3 balls on the table, JIT-warm — median 0.057ms
// at N=4, 0.347ms at N=24. Even at N=24 that is under 2.1% of a single 60fps (16.67ms) frame
// budget, and the cost is spread across the stroke's ~4 STEP_DT ticks (its 14ms duration divided
// by 1/240s), not paid in one frame. Affordable; N=24 shipped without a fallback.
//
// WHAT NEITHER PASS FIXES: the doc's 4.5-6.0 m/s ceiling. At N=24 it is breached further than
// at N=4 (0.7x length is now 10.01 m/s, not 7.46) — the fix reveals the ball's real exit speed
// rather than an artifact of under-resolution, and that real speed is well above the doc's
// range at every measured point. Whether E_FLIPPER/upMs need retuning to hit that range remains
// the operator's open decision; nothing here changes either.
// ===========================================================================================

const DOC_EXIT_MIN = 4.5;   // design doc acceptance range, lower bound
const DOC_EXIT_MAX = 6.0;   // design doc acceptance range, UPPER bound — still breached, see above

// Characterisation, not specification. It pins what the machine DOES, so that any change to
// E_FLIPPER / upMs / restAngle / activeAngle / FLIPPER_SUBSTEPS — deliberate or accidental —
// fails loudly here instead of moving in silence. It asserts nothing about what the value
// SHOULD be. Tolerance is 0.01 m/s: the computation is deterministic (no RNG), so this is far
// tighter than any real constant change (which moves these by 0.1 or more) and loose enough for
// float noise.
test('CHARACTERISATION: flip peak speed at five contact points, single-impact regime (pins current behaviour, decides nothing)', () => {
  // FLIPPER-EXIT (2026-09-06): re-measured after upMs 14 -> 34 (E_FLIPPER unchanged at 0.85 —
  // see constants.js's own comment on why restitution wasn't the lever). Historical upMs=14
  // values (14.1814/12.8506/11.4325/10.0143/8.5962) are preserved in the comment block above,
  // not deleted — this table pins CURRENT behaviour only.
  const measured = [
    { frac: 1.0, expected: 5.8402 },
    { frac: 0.9, expected: 5.2855 },
    { frac: 0.8, expected: 4.7015 },
    { frac: 0.7, expected: 4.1175 },
    { frac: 0.6, expected: 3.5336 },
  ];
  const outsideRange = [];
  for (const { frac, expected } of measured) {
    const speed = flipAndMeasure(makeLowerLeftFlipper(), frac);
    assert.ok(Math.abs(speed - expected) < 0.01,
      `peak speed at ${frac}x length changed: was ${expected} m/s, now ${speed.toFixed(4)} m/s. ` +
      'This test pins current behaviour — if you changed E_FLIPPER, upMs, an angle, or ' +
      'FLIPPER_SUBSTEPS on purpose, re-measure and update the table here (and in the comment ' +
      'block above).');
    if (speed > DOC_EXIT_MAX || speed < DOC_EXIT_MIN) outsideRange.push(`${frac}x=${speed.toFixed(4)}`);
  }
  // Not a specification — a standing reminder in the passing suite of exactly which contact
  // points the doc's range now covers. FLIPPER-EXIT brought the two contract points this file
  // actually tests (1.0x, 0.8x — see the two tests above) inside [4.5, 6.0]; it was never aimed
  // at covering EVERY contact point along the bat, and 0.6x/0.7x (short, weak strikes) now fall
  // BELOW the floor rather than above the ceiling — a real, expected consequence of a slower
  // stroke, not a regression: a player striking closer to the pivot gets less bat speed, always
  // did, and now that shows up as "under 4.5" instead of "still over 6.0 anyway."
  assert.deepEqual(outsideRange, ['0.7x=4.1175', '0.6x=3.5336'],
    `expected exactly 0.6x/0.7x outside [${DOC_EXIT_MIN}, ${DOC_EXIT_MAX}] (below the floor); got: ${outsideRange.join(', ') || 'none'}`);
});

// The quantity `flipAndMeasure` does NOT report: what the ball actually leaves with, and how
// many DISTINCT SUBSTEPS carry a collision (not raw event count — multiple events within one
// substep are the solver resolving a single overlap thoroughly, not separate strikes over
// time). At N=24 this should be exactly 1 — the single-impact regime's whole point.
test('CHARACTERISATION: separation speed and contact count in the single-impact regime (contacts=1)', () => {
  const flipper = makeLowerLeftFlipper();
  const restRad = flipper.restAngle;
  const along = flipper.length;
  const contact = { x: flipper.pivot.x + Math.cos(restRad) * along, y: flipper.pivot.y + Math.sin(restRad) * along };
  const nx = -Math.sin(restRad), ny = Math.cos(restRad);
  const ballRadius = BALL_RADIUS; // CONST-IMPORT: was the literal 0.0135
  const clearance = ballRadius + flipper.radius + 0.0005;
  const ball = { pos: { x: contact.x + nx * clearance, y: contact.y + ny * clearance }, vel: { x: 0, y: 0 }, radius: ballRadius };
  const tuning = { mu: MU, kDrag: K_DRAG, maxImpacts: MAX_IMPACTS };

  setActive(flipper, true);
  let peak = 0, contacts = 0;
  for (let i = 0; i < 15; i++) {
    const substeps = isFlipperMoving(flipper) ? FLIPPER_SUBSTEPS : 1;
    const subDt = STEP_DT / substeps;
    for (let s = 0; s < substeps; s++) {
      updateFlipper(flipper, subDt);
      const events = stepBall(ball, GRAVITY, [flipperEntry(flipper)], subDt, tuning);
      if (events.length > 0) contacts += 1;
      peak = Math.max(peak, length(ball.vel));
    }
  }
  const separation = length(ball.vel);

  // FLIPPER-EXIT (2026-09-06): re-measured after upMs 14 -> 34. Was 14.1814 / ~14.0315.
  assert.ok(Math.abs(peak - 5.8402) < 0.01, `peak changed: expected 5.8402, got ${peak.toFixed(4)}`);
  assert.ok(Math.abs(separation - 5.7652) < 0.02,
    `separation speed changed: expected ~5.7652 m/s, got ${separation.toFixed(4)}. This is what ` +
    'the ball actually leaves with — the number a player feels.');
  assert.equal(contacts, 1,
    `contact count changed: expected exactly 1 distinct substep with a collision (the single-` +
    `impact regime this resolution exists to reach), got ${contacts}.`);
});

// The two criteria Experiment A found are physically obligatory, and the reason N=4 was
// rejected: peak exit speed must RISE with E_FLIPPER (a bouncier bat throws a faster ball) and
// must RISE with contact radius (a strike further from the pivot, at higher surface speed,
// throws a faster ball). Both hold at the shipped N=24 and both FAIL at the rejected N=4 —
// demonstrated together, not just narrated, so a future regression to N=4-like behaviour (any
// resolution too coarse to reach a single impact) fails here regardless of which specific
// constant caused it.
test('CHARACTERISATION: peak exit speed rises with E_FLIPPER at N=24, and does NOT at the rejected N=4', () => {
  // FLIPPER-EXIT (2026-09-06) slowed the shipped stroke (upMs 14 -> 34) enough that even N=4
  // now resolves a single clean impact here — a slower tip travels less per substep, so the
  // under-resolution N=4 was rejected for no longer shows up at THIS upMs. That does not mean
  // N=4 is safe in general: it was rejected for being inadequate at a FAST stroke, and remains
  // so. Pinned at upMs=14 (the historical fast-stroke reference this test has always meant,
  // now explicit rather than "whatever upMs currently ships") so this demonstration keeps
  // demonstrating the failure mode it exists to catch, independent of future upMs tuning.
  const REJECTED_N4_REFERENCE_UPMS = 14;
  const eSweep = [0.70, 0.80, 0.85, 0.88, 0.90, 0.92, 0.96];
  const peaksAtShipped = eSweep.map((e) => flipAndMeasure(makeLowerLeftFlipper(e), 1.0));
  const peaksAtRejectedN4 = eSweep.map((e) => flipAndMeasure(makeLowerLeftFlipper(e, REJECTED_N4_REFERENCE_UPMS), 1.0, 4));

  for (let i = 1; i < peaksAtShipped.length; i++) {
    assert.ok(peaksAtShipped[i] > peaksAtShipped[i - 1],
      `peak speed is not monotonic INCREASING at e=${eSweep[i]} (N=${FLIPPER_SUBSTEPS}): ` +
      `${peaksAtShipped[i - 1].toFixed(4)} -> ${peaksAtShipped[i].toFixed(4)}. Full table: ` +
      eSweep.map((e, j) => `${e}=${peaksAtShipped[j].toFixed(4)}`).join(', '));
  }

  // Confirms the rejected resolution actually fails this — if it stopped failing, N=4 might be
  // affordable again and the historical record above would need re-checking, not just this
  // assertion loosened.
  const risesAtN4 = peaksAtRejectedN4.every((p, i) => i === 0 || p > peaksAtRejectedN4[i - 1]);
  assert.equal(risesAtN4, false,
    `N=4 no longer fails the rises-with-e criterion (${eSweep.map((e, j) => `${e}=${peaksAtRejectedN4[j].toFixed(4)}`).join(', ')}) ` +
    '— if this is now true, the historical account in the comment block above needs revisiting, not just this assertion.');
});

test('CHARACTERISATION: peak exit speed rises with contact radius at N=24, and does NOT at the rejected N=4', () => {
  // Same reference-speed pinning as the E_FLIPPER version of this test above — see its comment.
  const REJECTED_N4_REFERENCE_UPMS = 14;
  const fracSweep = [0.6, 0.7, 0.8, 0.9, 1.0];
  const peaksAtShipped = fracSweep.map((f) => flipAndMeasure(makeLowerLeftFlipper(0.85), f));
  const peaksAtRejectedN4 = fracSweep.map((f) => flipAndMeasure(makeLowerLeftFlipper(0.85, REJECTED_N4_REFERENCE_UPMS), f, 4));

  for (let i = 1; i < peaksAtShipped.length; i++) {
    assert.ok(peaksAtShipped[i] > peaksAtShipped[i - 1],
      `peak speed is not monotonic INCREASING with contact radius at ${fracSweep[i]}x (N=${FLIPPER_SUBSTEPS}): ` +
      `${peaksAtShipped[i - 1].toFixed(4)} -> ${peaksAtShipped[i].toFixed(4)}. Full table: ` +
      fracSweep.map((f, j) => `${f}x=${peaksAtShipped[j].toFixed(4)}`).join(', '));
  }

  const risesAtN4 = peaksAtRejectedN4.every((p, i) => i === 0 || p > peaksAtRejectedN4[i - 1]);
  assert.equal(risesAtN4, false,
    `N=4 no longer fails the rises-with-radius criterion (${fracSweep.map((f, j) => `${f}x=${peaksAtRejectedN4[j].toFixed(4)}`).join(', ')}) ` +
    '— if this is now true, the historical account in the comment block above needs revisiting, not just this assertion.');
});

// DISABLED DELIBERATELY — this is the missing half of the spec, written out so it is ready to
// enable the moment the constant is settled. It FAILS today, in the single-impact regime, at
// EVERY sampled point, by more than it did under either earlier resolution — see the block above.
//
// It is skipped rather than left unwritten because the breach was invisible precisely because
// nobody had written the other half down. It is skipped rather than `todo` because a failing
// `todo` still prints a "failing tests" block, which reads as a broken suite to anyone else
// working in this repo.
//
// ENABLED (FLIPPER-EXIT, 2026-09-06): upMs 14 -> 34 settles this, per the sweep in
// constants.js's own FLIPPER comment. E_FLIPPER stayed at 0.85 — it was never the lever (even
// e=0 at the old upMs=14 still exceeded the ceiling; see the same comment).
test('a flipped ball leaves within the design doc\'s 4.5-6.0 m/s range (BOTH bounds)',
  () => {
    // A fresh flipper per fraction — enabling this surfaced a real bug in this loop shape: a
    // shared flipper object is already active/at-rest after the first flipAndMeasure() call,
    // so the second call's setActive() is a no-op and the ball never gets struck (measured:
    // ~0.05 m/s, gravity alone over the loop). Masked before because both fractions failed the
    // ceiling anyway; the floor check this enable adds is what caught it.
    for (const frac of [1.0, 0.8]) {
      const speed = flipAndMeasure(makeLowerLeftFlipper(), frac);
      assert.ok(speed >= DOC_EXIT_MIN, `expected >= ${DOC_EXIT_MIN} m/s at ${frac}x length, got ${speed}`);
      assert.ok(speed <= DOC_EXIT_MAX, `expected <= ${DOC_EXIT_MAX} m/s at ${frac}x length, got ${speed}`);
    }
  });

test('a ball cannot pass through a flipper mid-sweep at high approach speed', () => {
  const flipper = makeLowerLeftFlipper();
  setActive(flipper, false);
  const tuning = { mu: MU, kDrag: 0, maxImpacts: MAX_IMPACTS };

  // Ball fired straight down through where the flipper capsule sits, at high speed,
  // while the flipper is mid-sweep (activating).
  setActive(flipper, true);
  const ball = { pos: { x: flipper.pivot.x + 0.03, y: flipper.pivot.y + 0.2 }, vel: { x: 0, y: -15 }, radius: BALL_RADIUS /* CONST-IMPORT: was 0.0135 */ };

  let below = false;
  for (let i = 0; i < 60; i++) {
    updateFlipper(flipper, STEP_DT);
    const primitives = [flipperEntry(flipper)];
    stepBall(ball, GRAVITY, primitives, STEP_DT, tuning);
    // The flipper capsule spans from pivot (y=0.105) to at most length above it;
    // the ball should never end up more than a hair below the pivot's y once it has
    // been below the flipper line, i.e. it must have bounced, not tunneled.
    if (ball.pos.y < flipper.pivot.y - 0.05) below = true;
  }
  // With a flipper in the way, the ball should bounce back up, not end up far below the pivot.
  assert.equal(below, false, `ball tunneled past the flipper: final y=${ball.pos.y}`);
});
