// Gate item 3 of the §2.2 three-part instrument-change gate: "the profile is exercised by
// at least one lab test." This is that test — it does NOT touch a real trial (the pilot's
// 10k run has no cfg with an omegaProfile set at all, which is gate item 2's byte-identical
// subject); it exercises the hook directly against the game's real updateFlipper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlipper, updateFlipper, setActive } from '../../pinball/src/physics/flipper.js';
import { OMEGA_PROFILES } from '../src/arenas/e1_flippers.js';

const DEG = Math.PI / 180;

// A wider upMs than RECESS's real 14ms — enough physics substeps (≈10, vs ≈3 at 14ms) that
// a profile's shape near u=0 is actually observable, not swallowed by one coarse first step.
const TEST_UP_MS = 40;

function sweepAngles(profileName, upMs = TEST_UP_MS) {
  const flipper = createFlipper({
    pivot: { x: 0, y: 0 }, length: 0.075, restAngleDeg: -50, activeAngleDeg: 32,
    upMs, downMs: 45, restitution: 0.85,
  });
  if (profileName) flipper.omegaProfile = OMEGA_PROFILES[profileName];
  setActive(flipper, true);
  const dt = 1 / 240;
  const angles = [];
  for (let t = 0; t < (upMs / 1000) * 2; t += dt) {
    updateFlipper(flipper, dt);
    angles.push(flipper.angle / DEG);
  }
  return angles;
}

test('every OMEGA_PROFILES entry integrates to ~1 over u in [0,1] (mean-1 normalisation, §2.2)', () => {
  const N = 2000;
  for (const [name, fn] of Object.entries(OMEGA_PROFILES)) {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += fn((i + 0.5) / N);
    const integral = sum / N;
    assert.ok(Math.abs(integral - 1) < 1e-3, `${name} integrates to ${integral}, expected ~1`);
  }
});

test('undefined omegaProfile (the default) is bit-identical to the explicit "constant" profile', () => {
  assert.deepEqual(sweepAngles(undefined), sweepAngles('constant'));
  // And at RECESS's actual live upMs (14ms, ~3 substeps) — the coarse case gate item 2's
  // byte-identical pilot comparison actually runs at.
  assert.deepEqual(sweepAngles(undefined, 14), sweepAngles('constant', 14));
});

test('a real profile (easeOut) reshapes the sweep but still completes it in ~upMs', () => {
  const constantAngles = sweepAngles('constant');
  const easeOutAngles = sweepAngles('easeOut');
  assert.notDeepEqual(easeOutAngles, constantAngles, 'easeOut should move the ball differently than a linear sweep');

  // easeOut is "fast off the stop" — after the first substep it should already have swept
  // further than the constant-rate baseline.
  assert.ok(easeOutAngles[0] > constantAngles[0], 'easeOut moves faster than constant off the rest angle');

  // Both reach the same final target (-50 -> 32, within the ~14ms window this loop covers).
  assert.ok(Math.abs(constantAngles.at(-1) - 32) < 1e-6);
  assert.ok(Math.abs(easeOutAngles.at(-1) - 32) < 1e-6);
});

test('easeIn is "slow off the stop": it moves less than constant on the first substep', () => {
  const constantAngles = sweepAngles('constant');
  const easeInAngles = sweepAngles('easeIn');
  assert.ok(easeInAngles[0] < constantAngles[0], 'easeIn should be slower than constant right off the rest angle');
});

test('sCurve is symmetric slow-fast-slow: slower than constant at the very start, faster near the midpoint', () => {
  const constantAngles = sweepAngles('constant');
  const sAngles = sweepAngles('sCurve');
  assert.ok(sAngles[0] < constantAngles[0], 'sCurve starts slower than constant');
});
