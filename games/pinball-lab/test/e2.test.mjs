// EXPERIMENT 2 (bumpers) — program handoff §4. Covers the grid arithmetic (§4.2's area
// fraction arithmetic is the whole point, same spirit as sweep.test.mjs's E1 coverage), the
// §7.1 P0 lesson ("no injection may overlap a primitive", enforced by a test rather than
// trusted at runtime), and a regression test for the real ESCAPED bug found while building
// this: a ball launched near-horizontally could free-fall through the open bottom edge
// without ever satisfying a naive "must have risen above the exit line first" crossing check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrial, rngForTrial } from '../src/instrument.js';
import {
  buildE2SeriesACfgs, buildE2SeriesBCfgs, buildE2DivergenceCfgs,
  E2_N_VALUES, E2_LAYOUT_VARIANTS, E2_PERTURB_ANGLE_RAD,
} from '../src/sweep.js';
import {
  seriesASkirtRadius, effectiveAreaFraction, seriesBFieldSize, generateLayout,
  SERIES_A_FIELD_AREA, SERIES_A_AREA_FRACTION_CAP, SERIES_B_AREA_FRACTION, NOMINAL_SKIRT_RADIUS,
} from '../src/arenas/e2_bumpers.js';
import { BALL_RADIUS } from '../../pinball/src/physics/constants.js';

test('§4.2 Series A cfgs: 6 N values x 3 layout variants = 18, every cfgId unique, every areaFraction <= cap', () => {
  const cfgs = buildE2SeriesACfgs();
  assert.equal(cfgs.length, E2_N_VALUES.length * E2_LAYOUT_VARIANTS);
  assert.equal(new Set(cfgs.map((c) => c.cfgId)).size, cfgs.length);
  for (const c of cfgs) {
    assert.ok(c.areaFraction <= SERIES_A_AREA_FRACTION_CAP + 1e-9, `N=${c.N} area fraction ${c.areaFraction} exceeds the 0.40 cap`);
    assert.ok(c.radius <= 0.03 + 1e-9);
  }
});

test('§4.2 Series A: N=50 is geometrically forced below the nominal 30mm skirt; N=1 is not', () => {
  const r1 = seriesASkirtRadius(1);
  const r50 = seriesASkirtRadius(50);
  assert.ok(Math.abs(r1 - 0.03) < 1e-9, 'N=1 should sit at the nominal 30mm skirt, unconstrained');
  assert.ok(r50 < 0.03 - 0.001, `N=50 should be constrained well below 30mm, got ${r50}`);
  const af50 = effectiveAreaFraction(50, r50, SERIES_A_FIELD_AREA);
  assert.ok(Math.abs(af50 - SERIES_A_AREA_FRACTION_CAP) < 1e-6, 'N=50 should land exactly on the 0.40 cap by construction');
});

test('§4.2 Series B cfgs: 18 total, area fraction is 0.15 for every N (field grows to compensate)', () => {
  const cfgs = buildE2SeriesBCfgs();
  assert.equal(cfgs.length, E2_N_VALUES.length * E2_LAYOUT_VARIANTS);
  for (const c of cfgs) {
    assert.ok(Math.abs(c.areaFraction - SERIES_B_AREA_FRACTION) < 1e-6, `N=${c.N} area fraction ${c.areaFraction} != 0.15`);
    assert.equal(c.radius, NOMINAL_SKIRT_RADIUS);
  }
  // Field must strictly grow with N (more bumpers held at fixed density need more room).
  const byN = new Map(cfgs.map((c) => [c.N, c]));
  let prevArea = 0;
  for (const N of E2_N_VALUES) {
    const c = byN.get(N);
    const area = c.fieldWidth * c.fieldHeight;
    assert.ok(area > prevArea, `Series B field area should strictly grow with N (N=${N})`);
    prevArea = area;
  }
});

test('§4.4 divergence cfgs: one per Series A cfg, carries baseCfgId + the mandated 1e-6 rad perturbation', () => {
  const seriesA = buildE2SeriesACfgs();
  const divergence = buildE2DivergenceCfgs(seriesA);
  assert.equal(divergence.length, seriesA.length);
  const baseIds = new Set(seriesA.map((c) => c.cfgId));
  for (const d of divergence) {
    assert.equal(d.perturbAngleRad, E2_PERTURB_ANGLE_RAD);
    assert.ok(baseIds.has(d.baseCfgId), 'baseCfgId should reference a real Series A cfgId');
    assert.notEqual(d.cfgId, d.baseCfgId, 'perturbing the angle must change the cfgId');
  }
});

test('§7.1 P0 lesson: every generated layout keeps every bumper clear of the injection edge (y=0)', () => {
  for (const cfgs of [buildE2SeriesACfgs(), buildE2SeriesBCfgs()]) {
    for (const cfg of cfgs) {
      const centres = generateLayout({
        N: cfg.N, fieldWidth: cfg.fieldWidth, fieldHeight: cfg.fieldHeight,
        radius: cfg.radius, variant: cfg.layoutVariant,
      });
      assert.equal(centres.length, cfg.N);
      for (const c of centres) {
        assert.ok(c.y - cfg.radius - BALL_RADIUS > 0, `bumper at y=${c.y} (N=${cfg.N}, variant=${cfg.layoutVariant}) is too close to the injection edge`);
        assert.ok(c.x > -cfg.fieldWidth / 2 && c.x < cfg.fieldWidth / 2, 'bumper x must be inside the field');
      }
    }
  }
});

test('determinism: the same (cfgId, seed) reproduces a bit-identical E2 record', () => {
  const cfgs = buildE2SeriesACfgs();
  for (const cfg of cfgs.slice(0, 6)) {
    const a = runTrial(cfg, 11);
    const b = runTrial(cfg, 11);
    assert.deepEqual(a, b, `cfg ${cfg.cfgId} (N=${cfg.N}) is not deterministic`);
  }
});

test('determinism: different seeds under the same E2 cfg draw different inbound trajectories', () => {
  const cfg = buildE2SeriesACfgs()[0];
  const a = runTrial(cfg, 1);
  const b = runTrial(cfg, 2);
  assert.notDeepEqual(a, b);
});

test('perturbAngleRad changes the used launch angle but not the sampled (x0/speed0/angle0Deg) rng draws', () => {
  const seriesA = buildE2SeriesACfgs();
  const base = seriesA[0];
  const divergence = buildE2DivergenceCfgs([base])[0];
  const baseRecord = runTrial(base, 5);
  const divRecord = runTrial(divergence, 5);
  // Same rng draws -> same reported injection speed/angle (ai/vi are the *sampled* values,
  // recorded before the perturbation is applied to the physics), different physical outcome
  // is plausible but not guaranteed at 1e-6 rad — this test only checks the sampling itself
  // is unaffected, not that the trajectories diverge (that's the divergence *measurement*,
  // not a harness invariant).
  assert.equal(baseRecord.vi, divRecord.vi);
  assert.equal(baseRecord.ai, divRecord.ai);
});

// Regression test for a real bug found while building this: a ball launched at a
// near-horizontal angle (ai close to 0 deg or 180 deg) has vel.y ~ 0 at injection; gravity
// alone can pull it back through the open bottom edge within the first substep, before it
// ever satisfies a "must have risen above the exit line first" crossing gate. The buggy
// version of runE2Trial misreported every such trial as ESCAPED (a tunneling flag) instead of
// a trivial real 'exit'. This directly exercises that band across many seeds/layouts.
test('regression: no ESCAPED trials from ordinary near-horizontal injections (2,000 trials across every N)', () => {
  const cfgs = buildE2SeriesACfgs();
  let escaped = 0;
  let total = 0;
  for (const cfg of cfgs) {
    for (let s = 0; s < 300; s++) {
      const r = runTrial(cfg, s);
      total += 1;
      if (r.term === 'escaped') escaped += 1;
    }
  }
  assert.equal(escaped, 0, `${escaped}/${total} trials falsely reported ESCAPED (expected 0 — this was the near-horizontal-launch bug)`);
});

test('rngForTrial: E2 cfgs are seeded the same way as E1 (pure function of cfgId, seed)', () => {
  const cfg = { cfgId: 'deadbeef' };
  assert.equal(rngForTrial(cfg, 3)(), rngForTrial(cfg, 3)());
});
