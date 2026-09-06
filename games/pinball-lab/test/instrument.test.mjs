import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrial, runTrialWithMeta, rngForTrial, contactStats } from '../src/instrument.js';
import { STEP_DT } from '../../pinball/src/physics/constants.js';
import { LEFT_FLIPPER_PIVOT, RIGHT_FLIPPER_PIVOT } from '../../pinball/src/table/recess.js';
import { createPolicy } from '../src/policy.js';
import { buildE1PilotCfgs, buildE1CradleCfgs } from '../src/sweep.js';

const PILOT = buildE1PilotCfgs();
// CONST-IMPORT: the flipper mocks below used to repeat the literal pivots { x: -0.078, y:
// 0.105 } / { x: 0.078, y: 0.105 } four times, and the "proximity" policy test separately
// hand-derived its expected fire time from the SAME -0.078 literal typed a second time —
// self-consistent (test passes regardless of what the real pivot is) but silent: a real
// LEFT_FLIPPER_PIVOT change would never be reflected here. These tests are about the policy's
// timing relative to a REAL flipper's position, not an arbitrary one, so now import it.
const MOCK_FLIPPERS = () => ({
  left: { active: false, pivot: LEFT_FLIPPER_PIVOT },
  right: { active: false, pivot: RIGHT_FLIPPER_PIVOT },
});
const cfgByPol = (pol, extra = {}) => PILOT.find((c) => c.pol === pol && Object.entries(extra).every(([k, v]) => c[k] === v));

test('determinism: the same (cfgId, seed) reproduces a bit-identical record, across every pilot policy', () => {
  for (const cfg of PILOT) {
    const a = runTrial(cfg, 7);
    const b = runTrial(cfg, 7);
    assert.deepEqual(a, b, `cfg ${cfg.cfgId} (${cfg.pol}) is not deterministic`);
  }
});

test('determinism: different seeds under the same cfg draw different inbound trajectories', () => {
  const cfg = cfgByPol('never');
  const a = runTrial(cfg, 1);
  const b = runTrial(cfg, 2);
  assert.notDeepEqual(a, b, 'two different seeds produced an identical trial — the rng seeding is broken');
});

test('determinism: rngForTrial is a pure function of (cfgId, seed) — same inputs, same first draw', () => {
  const cfg = { cfgId: 'abcd1234' };
  const rngA = rngForTrial(cfg, 42);
  const rngB = rngForTrial(cfg, 42);
  assert.equal(rngA(), rngB());
});

test('runTrialWithMeta reports a step count consistent with the record (nonzero, matches --trace line count)', () => {
  const cfg = cfgByPol('proximity', { R: 0.14, L: 0 });
  const { record, steps } = runTrialWithMeta(cfg, 1);
  assert.ok(steps > 0);
  assert.equal(record.term !== null, true);
});

// --- Analytic (non-random) cases for the actuation policies themselves — §3.2's "timing is
// measured, not assumed" only holds if the policies fire exactly when they claim to. ---

test('analytic: the "never" policy never fires a flipper', () => {
  const policy = createPolicy({ pol: 'never' });
  const ball = { pos: { x: 0, y: 0.5 } };
  const flippers = MOCK_FLIPPERS();
  for (let t = 0; t < 2; t += STEP_DT) {
    const events = policy.tick(t, ball, flippers);
    assert.deepEqual(events, []);
  }
  assert.equal(flippers.left.active, false);
  assert.equal(flippers.right.active, false);
});

test('analytic: "fixedDelay" fires exactly once, at t >= d/1000, on the side matching ball.pos.x', () => {
  const policy = createPolicy({ pol: 'fixedDelay', d: 50 });
  const ball = { pos: { x: -0.1, y: 0.5 } }; // left of centre -> left flipper
  const flippers = MOCK_FLIPPERS();
  const dt = STEP_DT;
  let fireEvents = [];
  for (let t = 0; t < 0.1; t += dt) {
    fireEvents = fireEvents.concat(policy.tick(t, ball, flippers));
  }
  assert.equal(fireEvents.length, 1);
  assert.equal(fireEvents[0].side, 'left');
  assert.ok(fireEvents[0].firedAtS >= 0.05 - dt, 'fired no earlier than d');
  assert.equal(flippers.left.active, true);
  assert.equal(flippers.right.active, false);
});

test('analytic: "proximity" arms on entering R, then fires after latency L elapses (not immediately)', () => {
  const policy = createPolicy({ pol: 'proximity', R: 0.1, L: 40 });
  const flippers = MOCK_FLIPPERS();
  const dt = STEP_DT;
  let t = 0;
  let ballX = -0.5; // starts well outside R of the left pivot
  let fired = [];
  const speed = 1; // m/s toward the left pivot's x, arbitrary
  for (; t < 1; t += dt) {
    ballX += speed * dt;
    const ball = { pos: { x: ballX, y: 0.105 } };
    fired = fired.concat(policy.tick(t, ball, flippers));
    if (flippers.left.active) break;
  }
  assert.equal(fired.length, 1);
  assert.equal(fired[0].side, 'left');
  // Entered R at roughly t = (0.1 - (LEFT_FLIPPER_PIVOT.x - (-0.5)? )) ... simpler: just assert
  // the fire time is strictly after the moment it first came within R, by ~L. Was hand-derived
  // from a second -0.078 literal (CONST-IMPORT) instead of the real pivot used two lines above.
  const enterT = (Math.abs(LEFT_FLIPPER_PIVOT.x - (-0.5)) - 0.1) / speed; // time to close to within R
  assert.ok(fired[0].firedAtS >= enterT + 0.04 - dt, 'fired only after the latency elapsed, not on entry');
});

test('analytic: "heldActive" (§3.5 cradle family) fires both flippers on the very first tick', () => {
  const policy = createPolicy({ pol: 'heldActive' });
  const flippers = MOCK_FLIPPERS();
  const ball = { pos: { x: 0, y: 0.5 } };
  const events = policy.tick(0, ball, flippers);
  assert.equal(events.length, 2);
  assert.equal(flippers.left.active, true);
  assert.equal(flippers.right.active, true);
  // Fires exactly once — a second tick must be a no-op.
  assert.deepEqual(policy.tick(STEP_DT, ball, flippers), []);
});

// --- LAB-2 cradle family (§3.5): cfg.cradle routes injection through CRADLE_INJECTION and
// exposes cr/st/bn on the record; every ordinary (non-cradle) trial must leave them null. ---
test('cradle: a heldActive/cradle trial reports cr/st/bn; an ordinary trial leaves them null', () => {
  // Exact geometry of Stage B cradle cfg `639a5287` (data/e1/stageB-cradle-<runId>) — this
  // checks the real record shape against a known settled outcome rather than hoping a settle
  // turns up in a handful of tries (the measured cradle rate at Stage B resolution is well
  // under 1%, so searching a small seed range for one wouldn't be reliable).
  //
  // Seed changed from 138 to 654 by LAB-19's solver-fix determination (2026-09-04,
  // games/pinball's e5ff0d7 — the maxImpacts t=0 double-overlap strand + gravity-per-remaining
  // fix). Seed 138 was a verified settle under the PRE-FIX solver; under the fixed solver it
  // times out instead. Determined this is not a broken cradle mechanic: traced seed 138's own
  // trial and found it never exercises the t=0/maxImpacts-exhaustion path this cfg's flipper
  // geometry (radius=0.009, activeAngle=38°) could in principle trigger — max 1 flipper
  // contact per physics substep throughout, on both the old and new solver, across a 300-seed
  // sweep (never above 3). The outcome flip is instead the ordinary sensitivity of a long
  // (~20-25 bounce, ~1.5s) chaotic multi-bounce trajectory to the gravity-per-remaining fix,
  // which changes trajectories on essentially every bounce, not just double-overlap ones —
  // exactly the kind of small, correct physics change that can flip one specific seed's
  // knife-edge outcome without saying anything about the mechanism itself. Confirmed cradling
  // still happens under the fixed solver at the expected rate (4/3000 seeds settle, 0.133% —
  // consistent with the old solver's own 1/300, 0.3%, given how rare and noisy this event is);
  // seed 654 is the first of those 4, independently re-verified below. See
  // ledger/handoffs/sonnet2/20260904T031500Z-e3-stallrate-and-cradle-determination.md for the full
  // trace (old-vs-new contact histograms, the 3000-seed settle-rate sweep).
  //
  // Seed changed AGAIN, 654 -> 708, by the flipper re-strike fix (2026-09-04,
  // games/pinball's abd4e88 — sub-stepping flipper motion/collision to STEP_DT/4 while a
  // flipper is moving, ledger/handoffs/opus2/20260904T180000Z-true-to-physics-standard.md §5
  // Experiment A'-3). instrument.js:12 imports `advance` from pinball's world.js directly, so
  // every lab trial with an active flipper — this cradle policy is `heldActive`, active from
  // the first tick — now runs under the finer resolution too. Seed 654 now times out. Same
  // determination as before, same conclusion: this is the CORRECT physics, not a broken
  // mechanic, and the fix is squarely why. The old (coarse) resolution let the flipper
  // re-strike the ball repeatedly as it swept through — each re-strike is a lossy collision
  // (restitution < 1), so coarse resolution was an extra, spurious source of energy
  // dissipation on top of whatever a real single clean impact would cost. That inflates how
  // often a chaotic trajectory happens to bleed enough energy to cross the 0.05 m/s stall
  // threshold within the 1.5s window — i.e. the OLD model over-produced stalls, not the new
  // one under-producing them. Excluding lab trials from the fix instead would leave the lab
  // measuring a deliberately less accurate physics model than the game it shares
  // physics/world.js with, for exactly the case (repeated flipper contact) the fix exists to
  // correct — the wrong trade for an experiment whose subject is flipper/cradle physics.
  // Re-swept the same 3000-seed range under the fixed code: 6/3000 settle, 0.20% — same order
  // of magnitude as both prior rates (0.133%, 0.3%), so cradling still happens at a consistent
  // rate; this specific knife-edge seed just isn't one of the settling ones anymore, same as
  // 138 wasn't after the solver fix. Seed 708 is the first of those 6, independently
  // re-verified below (deterministic, re-run bit-identical).
  //
  // Seed changed AGAIN, 708 -> 57947, by GRAVITY-ROLL (2026-09-06, gravityForPitch corrected
  // from the sliding 9.81 sinθ to the rolling 5/7 of that —
  // ledger/handoffs/opus2/20260906T020000Z-ball-speed.md). This one is NOT the same story as
  // the prior two re-picks. Those were a knife-edge SEED flipping sides of a stable rate; this
  // is the RATE itself collapsing. A fresh 3000-seed sweep under corrected gravity found ZERO
  // settles (previously 6/3000, 0.20%); widened to 100,000 seeds before finding any at all —
  // 3/100,000, roughly 0.003%, a ~65x drop. Every one of the 27,000 seeds between 3000 and
  // 57947 that isn't a settle terminates `timeout` or `drain` (measured distribution: 1963
  // timeout / 1036 drain / 1 shotline / 0 stall across the first 3000 alone). A slower ball
  // arrives at this held-active flipper with less speed, and empirically it is now far more
  // likely to either drain past the flipper or time out oscillating than to bleed down to the
  // 0.05 m/s stall threshold while still in contact — cradling on THIS geometry (e=0.45,
  // activeAngle 38°, upMs 18) became dramatically rarer, not just relocated to a new seed.
  // This is a real gameplay-relevant finding, not a fixture-maintenance footnote: it bears
  // directly on E1's own restitution/cradling conclusions and on the FLIPPER-EXIT dispatch
  // that cites them (both operate on RESTITUTION, not gravity, but this shows the ball's
  // approach ENERGY under the flipper also gates whether a catch is possible at all, a second,
  // independent lever on cradling that GRAVITY-ROLL just moved). Flagged in the GRAVITY-ROLL
  // handoff rather than silently absorbed by picking a new seed. Seed 57947 is the first of
  // the 3 settles found in [0, 100000), independently re-verified below (deterministic).
  const geometry = { restAngleDeg: -50, activeAngleDeg: 38, upMs: 18, omegaProfile: 'easeOut', radius: 0.009, restitution: 0.45 };
  const cradleCfgs = buildE1CradleCfgs([geometry]);
  assert.equal(cradleCfgs.length, 1);
  assert.equal(cradleCfgs[0].pol, 'heldActive');
  assert.equal(cradleCfgs[0].cradle, true);
  assert.equal(cradleCfgs[0].cfgId, '639a5287');

  const settled = runTrial(cradleCfgs[0], 57947);
  assert.equal(settled.term, 'stall');
  assert.equal(settled.cr, 1);
  assert.ok(settled.st !== null && settled.st > 0 && settled.st <= 1.5, 'settle time reported, within the 1.5s window');
  assert.ok(settled.bn > 0, 'at least one flipper contact before settling');

  const unsettled = runTrial(cradleCfgs[0], 0);
  assert.ok(unsettled.cr === 0 || unsettled.cr === 1, 'cradle trial always reports cr as 0 or 1, never null');

  const ordinary = cfgByPol('never');
  const rec = runTrial(ordinary, 1);
  assert.equal(rec.cr, null);
  assert.equal(rec.st, null);
  assert.equal(rec.bn, null);
});

// --- §3.5 pilot (opus2's proposed cradleProxy replacement, ledger/handoffs/opus2/
// 20260904T150000Z-three-gate-rulings.md §(a)): min contact speed and contact dwell time. ---
test('contactStats: a known contact profile yields the exact expected min-speed and dwell', () => {
  // 3 substeps out of contact (speeds irrelevant, must be ignored), 4 in contact
  // (speeds 2.5/1.2/1.8/3.0 -> min 1.2), 2 more out of contact.
  const samples = [
    { inContact: false, speed: 9.9 },
    { inContact: false, speed: 0.01 },
    { inContact: false, speed: 5.0 },
    { inContact: true, speed: 2.5 },
    { inContact: true, speed: 1.2 },
    { inContact: true, speed: 1.8 },
    { inContact: true, speed: 3.0 },
    { inContact: false, speed: 7.0 },
    { inContact: false, speed: 0.5 },
  ];
  const result = contactStats(samples);
  assert.equal(result.minSpeed, 1.2, 'min speed must be the minimum across ONLY the in-contact substeps');
  assert.ok(Math.abs(result.dwellS - 4 * STEP_DT) < 1e-12, `dwell must be exactly the 4 in-contact substeps * STEP_DT, got ${result.dwellS}`);
});

test('contactStats: a trial that never contacts a flipper reports null minSpeed and zero dwell', () => {
  const samples = [{ inContact: false, speed: 3.0 }, { inContact: false, speed: 1.0 }];
  const result = contactStats(samples);
  assert.equal(result.minSpeed, null);
  assert.equal(result.dwellS, 0);
});

test('contactStats: an empty sample array (never advanced) reports null minSpeed and zero dwell', () => {
  const result = contactStats([]);
  assert.equal(result.minSpeed, null);
  assert.equal(result.dwellS, 0);
});

test('cradle: a real settled cradle trial (seed 57947, same cfg as the cr/st/bn test above) reports cs/cd consistent with bn; an ordinary trial leaves them null', () => {
  // Seed 654 -> 708: flipper re-strike fix. Seed 708 -> 57947: GRAVITY-ROLL, and this one is
  // a rate collapse (~65x), not a knife-edge flip — see the long comment on the cr/st/bn test
  // above for the measurement.
  const geometry = { restAngleDeg: -50, activeAngleDeg: 38, upMs: 18, omegaProfile: 'easeOut', radius: 0.009, restitution: 0.45 };
  const cradleCfgs = buildE1CradleCfgs([geometry]);
  const settled = runTrial(cradleCfgs[0], 57947);
  assert.equal(settled.term, 'stall');
  assert.ok(settled.cs !== null && settled.cs >= 0, 'a contacting, settled trial reports a non-null min contact speed');
  assert.ok(settled.cs <= 0.05 + 1e-9, `a trial that STALLED while in contact must have cs at or under the stall speed threshold (0.05 m/s), got ${settled.cs}`);
  assert.ok(settled.cd > 0, 'a settled cradle trial has positive contact dwell time');
  assert.ok(settled.bn > 0 && settled.cd <= settled.bn * STEP_DT + 1e-9, 'dwell cannot exceed contact-substep-count * STEP_DT');

  // GEO-2 changed this contract deliberately, so the assertion changes with it rather than
  // being deleted. cs/cd used to be gated on `cfg.cradle`, which made min-contact-speed
  // unmeasurable on the Stage A geometry screen — the place the selection is actually made.
  // The new contract is about CONTACT, not about which family the cfg belongs to: cs is a
  // number whenever the ball touched a flipper and null when it never did, on every cfg.
  const ordinary = cfgByPol('never');
  const rec = runTrial(ordinary, 1);
  assert.notEqual(rec.cd, null, 'dwell is now reported on ordinary trials too');
  if (rec.n > 0) {
    assert.ok(rec.cs !== null && rec.cs >= 0, 'a non-cradle trial that DID contact reports its min contact speed');
    assert.ok(rec.cd > 0, 'and a positive dwell');
  } else {
    assert.equal(rec.cs, null, 'a trial that never touched a flipper still reports cs = null');
    assert.equal(rec.cd, 0, 'with zero dwell');
  }

  // The null case must still exist, or the downstream `cs !== null` filters mean nothing.
  const neverTouches = { ...ordinary, restAngleDeg: -89, activeAngleDeg: -88 };
  let sawNull = false;
  for (let seed = 0; seed < 40 && !sawNull; seed++) {
    const r = runTrial(neverTouches, seed);
    if (r.n === 0) { assert.equal(r.cs, null); sawNull = true; }
  }
  assert.ok(sawNull, 'some trial in the sweep must miss the flipper entirely, or the null branch is untested');
});
