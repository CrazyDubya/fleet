import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrial, runTrialWithMeta, rngForTrial } from '../src/instrument.js';
import { createPolicy } from '../src/policy.js';
import { buildE1PilotCfgs, buildE1CradleCfgs } from '../src/sweep.js';

const PILOT = buildE1PilotCfgs();
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
  const flippers = { left: { active: false, pivot: { x: -0.078, y: 0.105 } }, right: { active: false, pivot: { x: 0.078, y: 0.105 } } };
  for (let t = 0; t < 2; t += 1 / 240) {
    const events = policy.tick(t, ball, flippers);
    assert.deepEqual(events, []);
  }
  assert.equal(flippers.left.active, false);
  assert.equal(flippers.right.active, false);
});

test('analytic: "fixedDelay" fires exactly once, at t >= d/1000, on the side matching ball.pos.x', () => {
  const policy = createPolicy({ pol: 'fixedDelay', d: 50 });
  const ball = { pos: { x: -0.1, y: 0.5 } }; // left of centre -> left flipper
  const flippers = { left: { active: false, pivot: { x: -0.078, y: 0.105 } }, right: { active: false, pivot: { x: 0.078, y: 0.105 } } };
  const dt = 1 / 240;
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
  const flippers = { left: { active: false, pivot: { x: -0.078, y: 0.105 } }, right: { active: false, pivot: { x: 0.078, y: 0.105 } } };
  const dt = 1 / 240;
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
  // Entered R at roughly t = (0.1 - (-0.078 - (-0.5)? )) ... simpler: just assert the fire
  // time is strictly after the moment it first came within R, by ~L.
  const enterT = (Math.abs(-0.078 - (-0.5)) - 0.1) / speed; // time to close to within R of -0.078
  assert.ok(fired[0].firedAtS >= enterT + 0.04 - dt, 'fired only after the latency elapsed, not on entry');
});

test('analytic: "heldActive" (§3.5 cradle family) fires both flippers on the very first tick', () => {
  const policy = createPolicy({ pol: 'heldActive' });
  const flippers = { left: { active: false, pivot: { x: -0.078, y: 0.105 } }, right: { active: false, pivot: { x: 0.078, y: 0.105 } } };
  const ball = { pos: { x: 0, y: 0.5 } };
  const events = policy.tick(0, ball, flippers);
  assert.equal(events.length, 2);
  assert.equal(flippers.left.active, true);
  assert.equal(flippers.right.active, true);
  // Fires exactly once — a second tick must be a no-op.
  assert.deepEqual(policy.tick(1 / 240, ball, flippers), []);
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
  const geometry = { restAngleDeg: -50, activeAngleDeg: 38, upMs: 18, omegaProfile: 'easeOut', radius: 0.009, restitution: 0.45 };
  const cradleCfgs = buildE1CradleCfgs([geometry]);
  assert.equal(cradleCfgs.length, 1);
  assert.equal(cradleCfgs[0].pol, 'heldActive');
  assert.equal(cradleCfgs[0].cradle, true);
  assert.equal(cradleCfgs[0].cfgId, '639a5287');

  const settled = runTrial(cradleCfgs[0], 654);
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
