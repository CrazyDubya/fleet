// EXPERIMENT 2 (bumpers) — program handoff §4. Covers the grid arithmetic (§4.2's area
// fraction arithmetic is the whole point, same spirit as sweep.test.mjs's E1 coverage), the
// §7.1 P0 lesson ("no injection may overlap a primitive", enforced by a test rather than
// trusted at runtime), and a regression test for the real ESCAPED bug found while building
// this: a ball launched near-horizontally could free-fall through the open bottom edge
// without ever satisfying a naive "must have risen above the exit line first" crossing check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrial, runTrialWithMeta, rngForTrial } from '../src/instrument.js';
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

// PREFIX-FIX (opus2, PREFIX-SWEEP §2): `eg[]` used to keep the FIRST 12 per-hit energy ratios,
// a prefix ordered by bumper-hit index — and the ratio falls with hit index on chains that
// matter, so the prefix reported a declining series' HIGH end as if it were the whole thing.
// Now a reservoir. Two properties matter: it stays exactly reproducible (same as the prefix
// it replaced), and on a long chain it is genuinely NOT the first 12 — the defect this
// replaces, reintroduced by a future edit, would make this second assertion fail.
test('eg[]: reservoir-sampled, not a prefix — reproducible, capped, and not just "the first 12" on a long chain', () => {
  const cfgs = buildE2SeriesBCfgs();
  const cfg = cfgs.find((c) => c.cfgId === 'd97982e0');
  assert.ok(cfg, 'fixture cfg not found — Series B cfg construction changed');
  // GRAVITY-ROLL: seed 2 gave ch=9 under the corrected (5/7) gravity term — was 2 only ever
  // reproducibly > 12 under the old, too-fast sliding-point-mass gravity. Same cfg, re-picked
  // seed (measured: ch=49 here, comfortable margin over the property's own >12 requirement).
  const seed = 4;

  const r1 = runTrial(cfg, seed);
  const r2 = runTrial(cfg, seed);
  assert.ok(r1.ch > 12, `fixture (${cfg.cfgId}, seed ${seed}) should have a chain > 12, got ${r1.ch} — pick a new fixture if sweep.js's cfg construction changed`);
  assert.equal(r1.eg.length, 12);
  // Reproducibility: same (cfg, seed) draws the same twelve hits, same order.
  assert.deepEqual(r1.eg, r2.eg, 'eg[] must be reproducible for the same (cfg, seed) — a re-run is not a re-sample');

  // Reconstruct the TRUE uncapped ratio sequence via onStep — the same preVel/postVel-around-a-
  // bumper-event computation runE2Trial does internally, traced from the outside so this test
  // has no dependency on instrument.js's own (now-fixed) bookkeeping.
  const trueRatios = [];
  let preVel = null;
  runTrialWithMeta(cfg, seed, {
    onStep: ({ vel, contacts }) => {
      if (preVel && contacts > 0) {
        const preSpeed = Math.hypot(preVel.x, preVel.y);
        const postSpeed = Math.hypot(vel.x, vel.y);
        if (preSpeed > 0) trueRatios.push(postSpeed / preSpeed);
      }
      preVel = vel;
    },
  });
  assert.equal(trueRatios.length, r1.ch, 'reconstructed uncapped ratio count should match the reported chain length');

  // The old defect: eg was always trueRatios.slice(0, 12). Assert it no longer is.
  assert.notDeepEqual(r1.eg, trueRatios.slice(0, 12), 'eg[] must not be the first 12 hits of a chain this long — that is the prefix defect this reservoir replaces');
  // But every retained value really did come from this trial's true stream (a reservoir can
  // only hold what it was offered).
  for (const v of r1.eg) {
    assert.ok(trueRatios.some((t) => Math.abs(t - v) < 1e-12), `eg value ${v} not found in the reconstructed true stream`);
  }
});
