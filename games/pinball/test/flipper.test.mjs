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

// ===========================================================================================
// EXIT SPEED: the design doc's acceptance range is TWO-SIDED — 4.5 to 6.0 m/s — and only the
// FLOOR is enforced. The two assertions above check `>= 4.5` and nothing checks `<= 6.0`, at
// the two contact points that are furthest OVER the ceiling. That is how a 5% breach has sat
// in a green suite: the specification was accurate and half of it was never encoded.
//
// Measured on HEAD (2026-09-04) with this file's own `flipAndMeasure`:
//
//     contact point      peak speed      vs doc range 4.5-6.0
//     1.0x length        6.3123 m/s      OVER by 0.31   <- asserted above, floor only
//     0.9x length        6.1105 m/s      OVER by 0.11
//     0.8x length        6.2661 m/s      OVER by 0.27   <- asserted above, floor only
//     0.7x length        5.2613 m/s      in range
//     0.6x length        4.8162 m/s      in range
//
// Three of five points are over. E_FLIPPER (0.30 -> 0.85) and upMs (30 -> 14) were both moved
// off their doc values during feel passes — see the comments in physics/constants.js, which say
// so — and the speed drifted off the target those changes were made to hit (~4.9 m/s).
//
// -------------------------------------------------------------------------------------------
// READ THIS BEFORE USING ANY NUMBER ABOVE. `flipAndMeasure` returns the MAXIMUM speed over a
// 15-substep window, NOT the speed the ball leaves at. Those are very different here, because
// the ball is struck REPEATEDLY as the flipper sweeps — 13 contacts in 15 substeps at the
// current constants:
//
//     E_FLIPPER   peak in window   speed at separation   contacts
//       0.80         6.7952              3.6877             13
//       0.85         6.3123              3.5113             13     <- current
//       0.90        10.7027              4.8632             18
//       0.92         2.0654              1.9904              4
//
// So the doc's 4.5-6.0 range is being compared against a quantity nobody has defined. If the
// range means separation speed, the machine is BELOW it (3.51), not above. If it means peak,
// it is above (6.31). Both readings cannot be right, and the tests above assert on the peak.
//
// Worse, peak speed is NOT monotonic in E_FLIPPER: it FALLS from 7.39 at e=0.70 to 5.82 at
// e=0.88 — the opposite of v_out = (1+e)*u — then spikes to 10.70 at 0.90 and collapses to 1.29
// at 0.96. That is a multi-contact re-strike regime, not a clean single impact, so "raise
// E_FLIPPER to make the flip snap" was working against itself in this range.
//
// This is characterisation only. Resolving which quantity the spec means, and whether the
// re-strike regime is acceptable, is the open decision — see the true-to-physics ruling at
// ledger/handoffs/opus2/20260904T180000Z-true-to-physics-standard.md.
// -------------------------------------------------------------------------------------------
//
// The constant is an OPEN DECISION: the operator wants browser play to settle it, so nothing
// here changes E_FLIPPER, upMs or any angle. These two tests make the breach impossible to
// overlook without deciding it.
// ===========================================================================================

const DOC_EXIT_MIN = 4.5;   // design doc acceptance range, lower bound
const DOC_EXIT_MAX = 6.0;   // design doc acceptance range, UPPER bound — not enforced, see below

// Characterisation, not specification. It pins what the machine DOES, so that any change to
// E_FLIPPER / upMs / restAngle / activeAngle — deliberate or accidental — fails loudly here
// instead of moving in silence. It asserts nothing about what the value SHOULD be.
// Tolerance is 0.01 m/s: the computation is deterministic (no RNG), so this is far tighter than
// any real constant change (which moves these by 0.1 or more) and loose enough for float noise.
test('CHARACTERISATION: flip peak speed at five contact points (pins current behaviour, decides nothing)', () => {
  const measured = [
    { frac: 1.0, expected: 6.3123 },
    { frac: 0.9, expected: 6.1105 },
    { frac: 0.8, expected: 6.2661 },
    { frac: 0.7, expected: 5.2613 },
    { frac: 0.6, expected: 4.8162 },
  ];
  const over = [];
  for (const { frac, expected } of measured) {
    const speed = flipAndMeasure(makeLowerLeftFlipper(), frac);
    assert.ok(Math.abs(speed - expected) < 0.01,
      `peak speed at ${frac}x length changed: was ${expected} m/s, now ${speed.toFixed(4)} m/s. ` +
      'This test pins current behaviour — if you changed E_FLIPPER, upMs or an angle on purpose, ' +
      're-measure and update the table here (and in the comment block above).');
    if (speed > DOC_EXIT_MAX) over.push(`${frac}x=${speed.toFixed(4)}`);
  }
  // Not a specification — a standing reminder in the passing suite that half the range is unmet.
  assert.equal(over.length, 3,
    `expected the three known ceiling breaches (1.0x, 0.9x, 0.8x) over ${DOC_EXIT_MAX} m/s; got: ${over.join(', ')}`);
});

// The quantity `flipAndMeasure` does NOT report: what the ball actually leaves with, and how many
// times it is struck getting there. Pinned separately because the two diverge by ~2.8 m/s at the
// current constants, and because the contact count is what makes the peak meaningless as a
// single-impact "exit speed". Decides nothing; makes the divergence impossible to lose.
test('CHARACTERISATION: separation speed and contact count differ sharply from peak (pins both)', () => {
  const flipper = makeLowerLeftFlipper();
  const restRad = flipper.restAngle;
  const along = flipper.length;
  const contact = { x: flipper.pivot.x + Math.cos(restRad) * along, y: flipper.pivot.y + Math.sin(restRad) * along };
  const nx = -Math.sin(restRad), ny = Math.cos(restRad);
  const ballRadius = 0.0135;
  const clearance = ballRadius + flipper.radius + 0.0005;
  const ball = { pos: { x: contact.x + nx * clearance, y: contact.y + ny * clearance }, vel: { x: 0, y: 0 }, radius: ballRadius };

  setActive(flipper, true);
  let peak = 0, contacts = 0;
  for (let i = 0; i < 15; i++) {
    updateFlipper(flipper, STEP_DT);
    const events = stepBall(ball, { x: 0, y: -1.11 }, [flipperEntry(flipper)], STEP_DT, { mu: MU, kDrag: K_DRAG, maxImpacts: 8 });
    contacts += events.length;
    peak = Math.max(peak, length(ball.vel));
  }
  const separation = length(ball.vel);

  assert.ok(Math.abs(peak - 6.3123) < 0.01, `peak changed: expected 6.3123, got ${peak.toFixed(4)}`);
  assert.ok(Math.abs(separation - 3.5113) < 0.01,
    `separation speed changed: expected 3.5113 m/s, got ${separation.toFixed(4)}. This is what the ` +
    'ball actually leaves with — the number a player feels — and it is NOT what the tests above assert on.');
  assert.equal(contacts, 13,
    `contact count changed: expected 13 strikes in the 15-substep window, got ${contacts}. A single ` +
    'clean impact would be 1; 13 means the flipper re-strikes the ball repeatedly as it sweeps.');

  // Stated, not asserted: separation speed is BELOW the doc floor while peak is above the ceiling.
  assert.ok(separation < DOC_EXIT_MIN && peak > DOC_EXIT_MAX,
    `the two candidate readings of the doc's ${DOC_EXIT_MIN}-${DOC_EXIT_MAX} m/s range still straddle it ` +
    `(separation ${separation.toFixed(4)} below, peak ${peak.toFixed(4)} above) — if this stops being true, ` +
    'the ambiguity described in the comment block above has been resolved and that block needs updating.');
});

// DISABLED DELIBERATELY — this is the missing half of the spec, written out so it is ready to
// enable the moment the constant is settled. It FAILS today: 6.3123 m/s at the tip and 6.2661
// m/s at 0.8x length, against the design doc's 6.0 m/s ceiling.
//
// It is skipped rather than left unwritten because the breach was invisible precisely because
// nobody had written the other half down. It is skipped rather than `todo` because a failing
// `todo` still prints a "failing tests" block, which reads as a broken suite to anyone else
// working in this repo.
//
// TO ENABLE: delete the `{ skip: … }` option. Do that as part of whatever change settles
// E_FLIPPER / upMs — not before, and not by widening DOC_EXIT_MAX to make it pass.
test('a flipped ball leaves within the design doc\'s 4.5-6.0 m/s range (BOTH bounds)',
  { skip: 'FAILS TODAY: 6.3123 m/s at 1.0x and 6.2661 m/s at 0.8x exceed the doc ceiling of 6.0. ' +
          'E_FLIPPER/upMs are an open decision pending browser play — enable this when they are settled.' },
  () => {
    const flipper = makeLowerLeftFlipper();
    for (const frac of [1.0, 0.8]) {
      const speed = flipAndMeasure(flipper, frac);
      assert.ok(speed >= DOC_EXIT_MIN, `expected >= ${DOC_EXIT_MIN} m/s at ${frac}x length, got ${speed}`);
      assert.ok(speed <= DOC_EXIT_MAX, `expected <= ${DOC_EXIT_MAX} m/s at ${frac}x length, got ${speed}`);
    }
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
