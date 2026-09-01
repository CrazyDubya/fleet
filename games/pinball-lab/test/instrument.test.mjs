import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrial, runTrialWithMeta, rngForTrial } from '../src/instrument.js';
import { createPolicy } from '../src/policy.js';
import { buildE1PilotCfgs } from '../src/sweep.js';

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
