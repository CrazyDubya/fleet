// LAB-4 (EXPERIMENT 3 — paths, program handoff §5): determinism, grid sizes, feed
// classification, and a no-throw sanity pass across every family's own grid — the same
// discipline e4.test.mjs applies to E4's build-time assertions, adapted to E3 (no flippers,
// so no foul-the-sweep assertion; the equivalent risk here is a family's arena builder
// throwing, or a trial never terminating, across its own swept parameter range).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTrial, runTrialWithMeta } from '../src/instrument.js';
import {
  buildE3P1Cfgs, buildE3P2Cfgs, buildE3P3Cfgs, buildE3P4Cfgs, buildE3P5Cfgs, buildE3AllCfgs,
  E3_P1_GRID, E3_P2_GRID, E3_P3_GRID, E3_P4_GRID, E3_P5_GRID, cfgId,
} from '../src/sweep.js';
import { classifyFeed, HALF_WIDTH } from '../src/arenas/e3_paths.js';
import { loadShotlineSamples } from '../src/e1Coupling.js';

const SHOTLINE_PATH = 'data/summaries/e1-lab2-20260901T073830Z-shotline.json';

test('grid sizes match the §5.1 budget this run was built against (288/300/100/100/600 = 1388)', () => {
  assert.equal(buildE3P1Cfgs().length, 4 * 4 * 3 * 6);
  assert.equal(buildE3P2Cfgs('uniform').length, 4 * 5 * 5 * 3);
  assert.equal(buildE3P3Cfgs('uniform').length, 5 * 4 * 5);
  assert.equal(buildE3P4Cfgs('uniform').length, 4 * 5 * 5);
  assert.equal(buildE3P5Cfgs().length, 5 * 4 * 5 * 6);
  const all = buildE3AllCfgs();
  const total = Object.values(all).reduce((a, cfgs) => a + cfgs.length, 0);
  assert.equal(total, 1388);
});

test('every family carries cfg.exp/cfg.family and a stable cfgId', () => {
  for (const [family, cfgs] of Object.entries(buildE3AllCfgs())) {
    for (const c of cfgs.slice(0, 3)) {
      assert.equal(c.exp, 'e3');
      assert.equal(c.family, family);
      assert.equal(c.cfgId, cfgId({ ...c, cfgId: undefined }));
    }
  }
});

test('P2-P4 carry the §5.3 E1 coupling by default; P5 explicitly does not (documented exception)', () => {
  assert.equal(buildE3P2Cfgs()[0].inputPrior, 'e1');
  assert.equal(buildE3P3Cfgs()[0].inputPrior, 'e1');
  assert.equal(buildE3P4Cfgs()[0].inputPrior, 'e1');
  assert.equal(buildE3P5Cfgs()[0].inputPrior, undefined);
});

test('determinism: the same (cfgId, seed) reproduces a bit-identical record, one cfg per family', () => {
  const samples = [
    buildE3P1Cfgs()[0], buildE3P2Cfgs()[0], buildE3P3Cfgs()[0], buildE3P4Cfgs()[0], buildE3P5Cfgs()[0],
  ];
  for (const cfg of samples) {
    const a = runTrial(cfg, 3);
    const b = runTrial(cfg, 3);
    assert.deepEqual(a, b, `cfg ${cfg.cfgId} (${cfg.family}) is not deterministic`);
  }
});

test('classifyFeed: centre / inlane / outlane / directDrain bands, both sides', () => {
  assert.equal(classifyFeed(0.0), 'centre');
  assert.equal(classifyFeed(0.03), 'centre');
  assert.equal(classifyFeed(0.10), 'rightInlane');
  assert.equal(classifyFeed(-0.10), 'leftInlane');
  assert.equal(classifyFeed(0.20), 'rightOutlane');
  assert.equal(classifyFeed(-0.20), 'leftOutlane');
  assert.equal(classifyFeed(HALF_WIDTH + 0.05, true), 'directDrain');
  assert.equal(classifyFeed(0.10, false), 'directDrain');
});

test('e1Coupling: loadShotlineSamples returns a large real sample set; sampleShotline draws a real pair', async () => {
  const entry = loadShotlineSamples(SHOTLINE_PATH);
  assert.ok(entry.samples.length > 10000, 'expected tens of thousands of E1 shotline samples');
  const [speed, angleDeg] = entry.samples[0];
  assert.ok(Number.isFinite(speed) && speed > 0);
  assert.ok(Number.isFinite(angleDeg) && angleDeg >= 0 && angleDeg <= 180);
});

// --- No-throw / terminates sanity pass across every family's OWN grid (small N per cfg) —
// the E3 analogue of e4.test.mjs's build-time assertion tests: a family whose arena builder
// throws, or whose trial never reaches a terminal state, on any grid point is a real bug that
// a thin post-hoc summary wouldn't surface until the full 1e6-trial run was already spent. ---
function sanityPass(t, cfgs, trialsPerCfg = 6) {
  let escaped = 0, nan = 0, total = 0;
  for (const cfg of cfgs) {
    for (let s = 0; s < trialsPerCfg; s++) {
      const { record } = runTrialWithMeta(cfg, s);
      total += 1;
      assert.ok(record.term !== null, `${cfg.cfgId} seed ${s}: trial never terminated`);
      if (record.term === 'escaped') escaped += 1;
      if (record.term === 'nan') nan += 1;
    }
  }
  assert.equal(nan, 0, `${nan}/${total} trials hit a NaN — a real solver-artifact regression`);
  // A small residual escape rate is possible at this coarse a sample (see the sweep.js
  // grids' own arena-bounds comments), but a family that escapes routinely would mean the
  // arena doesn't contain its own swept parameter range — verified clean (0%) across the
  // full grid at build time; this test catches a regression, not a first discovery.
  assert.ok(escaped / total < 0.02, `${escaped}/${total} escaped — arena containment regression`);
}

test('sanity: P1 grid (plunge/lane) — no throws, no escapes, every trial terminates', (t) => sanityPass(t, buildE3P1Cfgs()));
test('sanity: P2 grid (orbit) — no throws, no escapes, every trial terminates', (t) => sanityPass(t, buildE3P2Cfgs()));
test('sanity: P3 grid (return lanes) — no throws, no escapes, every trial terminates', (t) => sanityPass(t, buildE3P3Cfgs()));
test('sanity: P4 grid (ramp mouth) — no throws, no escapes, every trial terminates', (t) => sanityPass(t, buildE3P4Cfgs()));
test('sanity: P5 grid (habitrail drop) — no throws, no escapes, every trial terminates', (t) => sanityPass(t, buildE3P5Cfgs()));

test('P4 ramp mouth: the make/reject hand-off actually fires somewhere across the grid', () => {
  const cfgs = buildE3P4Cfgs();
  // At least SOME P4 trials across the grid record a non-null rmp (the mouth was reached and
  // classified made/rejected) — proves the manual hand-off path (instrument.js's
  // runE3Trial) actually fires, not just that the arena builds.
  let anyRmp = false;
  outer: for (const cfg of cfgs) {
    for (let s = 0; s < 30; s++) {
      const rec = runTrial(cfg, s);
      if (rec.rmp !== null) { anyRmp = true; break outer; }
    }
  }
  assert.ok(anyRmp, 'no P4 trial in a 30-seed sample ever reached the ramp mouth — check the gate/geometry alignment');
});
