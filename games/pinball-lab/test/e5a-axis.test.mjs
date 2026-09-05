// LAB-27: give E5a an axis that can carry its question.
//
// LAB-25 gated E5a's verdict to INDETERMINATE because `hsSPredicted` degenerates: 9 of 15
// assemblies at exactly 0.0000. The cause is two compounding artifacts in code, not a property
// of the geometry:
//
//   1. `predictHsS` ends with `Math.max(0, Math.min(1, t / FLIPPER_LENGTH))`. That clamp exists
//      to match `classifySettle`'s MEASURED hsS range, which is right for the measured quantity
//      and wrong for a predictor being used as an ordering axis. Across the 1,080 feasible
//      assemblies the unclamped projection spans [-0.3811, +0.2546] with 450 distinct values;
//      clamped, 62.4% of them collapse onto exactly 0.
//   2. `buildE5aAssemblies` then QUANTILE-bins on the clamped value, so most of its 16 bins land
//      inside that mass point.
//
// The fix is both halves: expose the unclamped projection, and sample RANGE-uniformly on it
// rather than by quantile. The justification for range-uniform is the question itself — E5a asks
// "does shot rate rise with hsS", which is a question about the axis, so the sample should be
// even in the axis. Quantile binning answers "what does a typical geometry do" and spends its
// budget where geometries are dense, which is exactly where shot rate is flat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildE5aAssemblies, predictHsSRaw, E4_W1_GRID, E4_RADII, E5A_ACTIVE_ANGLES, expandGrid } from '../src/sweep.js';
import { rankingValidityResult } from '../src/gate.js';

test('LAB-27: the unclamped projection resolves where the clamped one collapses', () => {
  const raws = [];
  for (const g of expandGrid(E4_W1_GRID)) {
    for (const radius of E4_RADII) {
      for (const activeAngleDeg of E5A_ACTIVE_ANGLES) {
        const v = predictHsSRaw({ ...g, activeAngleDeg, radius });
        if (v !== null) raws.push(v);
      }
    }
  }
  const clamped = raws.map((v) => Math.max(0, Math.min(1, v)));
  const zeroFrac = clamped.filter((v) => v === 0).length / clamped.length;
  assert.ok(zeroFrac > 0.6, `the clamp should be collapsing most of the space, got ${zeroFrac}`);
  assert.ok(new Set(raws).size > 5 * new Set(clamped).size / 2,
    'the unclamped axis must carry substantially more distinct values');
  assert.ok(Math.min(...raws) < -0.3, 'the negative half the clamp destroys is real and large');
});

test('LAB-27: the sampled assembly axis passes the same guard that failed the old one', () => {
  const assemblies = buildE5aAssemblies();
  const axis = assemblies.map((a) => a.hsSRaw);
  const g = rankingValidityResult(axis);
  assert.equal(g.ok, true, `the axis E5a is analysed on must be able to carry an ordering: ${g.reason}`);
  assert.equal(g.distinctCount, axis.length, 'every sampled assembly should sit at its own hsS');
});

test('LAB-27: the sample reaches the region where shot rate is actually nonzero', () => {
  // The measured transition begins around hsS 0.13 and the feasible range stops at 0.2546. The
  // old quantile design put TWO assemblies above 0.10 out of fifteen, which is why the verdict
  // rested on two rows. A design that cannot sample the phenomenon cannot answer the question.
  const assemblies = buildE5aAssemblies();
  const above = assemblies.filter((a) => a.hsSRaw >= 0.10);
  assert.ok(above.length >= 4,
    `need real coverage above 0.10 to see the transition, got ${above.length} of ${assemblies.length}`);
});

test('LAB-27: the clamped value is still carried, so the measured-hsS comparison is not lost', () => {
  const assemblies = buildE5aAssemblies();
  for (const a of assemblies) {
    assert.equal(a.hsSPredicted, Math.max(0, Math.min(1, a.hsSRaw)));
  }
});
