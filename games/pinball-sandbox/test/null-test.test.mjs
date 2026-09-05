// Tests for runScenarioNullTest — the label-permutation capability (see scenarios.js's own
// doc comment for why: opus2's LAB SENS-1 finding, ledger/handoffs/opus2/
// 20260905T180216Z-sensitivity-axis-measured.md). This file tests the MACHINERY ONLY: that the
// shuffle destroys labels and not data, that it's reproducible under a seed, and that the
// report shape holds. It draws no conclusion about arc-containment or any other real scenario's
// own validity — per SBX-NULL-1, this capability is not applied to anything yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenarioNullTest, formatNullTest } from '../src/scenarios.js';

// A statistic with real, obvious structure: the spread across row (x) means. Using
// arc-containment's maxY (a real physics output, not synthetic) purely as a source of numbers
// to shuffle — this is a test of the null-test engine, not a claim about the channel.
const SPREAD_ACROSS_ROW_MEANS = (matrix) => {
  const rowMeans = matrix.map((row) => row.reduce((s, v) => s + v, 0) / row.length);
  return Math.max(...rowMeans) - Math.min(...rowMeans);
};

test('reports the real (labeled) statistic as `observed`, computed from actual scenario runs, and marks it discriminating', () => {
  const r = runScenarioNullTest('arc-containment', {
    xPath: 'ball.speed', xValues: [1, 3, 6],
    yPath: 'ball.offset', yValues: [-0.005, 0, 0.005],
    extract: (rep) => rep.maxY,
    statistic: SPREAD_ACROSS_ROW_MEANS,
    iterations: 200,
    seed: 7,
  });
  assert.equal(typeof r.observed, 'number');
  assert.ok(Number.isFinite(r.observed));
  // SPREAD_ACROSS_ROW_MEANS is NOT shuffle-invariant (relabeling which cell a maxY value
  // lands in changes which row it contributes to, so its own mean moves) — the null
  // distribution built from it should actually vary, not sit at one repeated value.
  assert.equal(r.discriminating, true, 'a row-mean-spread statistic over varying maxY values must have a null with real spread');
  assert.equal(typeof r.percentile, 'number');
});

test('reproducible: the same scenario + seed gives the same null distribution twice', () => {
  const opts = {
    xPath: 'ball.speed', xValues: [1, 2, 3, 4],
    yPath: 'ball.offset', yValues: [-0.005, 0, 0.005],
    extract: (rep) => rep.maxY,
    statistic: SPREAD_ACROSS_ROW_MEANS,
    iterations: 300,
    seed: 42,
  };
  const r1 = runScenarioNullTest('arc-containment', opts);
  const r2 = runScenarioNullTest('arc-containment', opts);
  assert.equal(r1.observed, r2.observed, 'the real statistic must be identical (same real data both times)');
  assert.equal(r1.discriminating, true);
  assert.equal(r1.nullMin, r2.nullMin);
  assert.equal(r1.nullMax, r2.nullMax);
  assert.equal(r1.nullMean, r2.nullMean);
  assert.equal(r1.percentile, r2.percentile, 'same seed must produce the same null draws, and so the same percentile');
});

test('a different seed can produce a different null draw sequence (not hardcoded to one shuffle)', () => {
  const base = {
    xPath: 'ball.speed', xValues: [1, 2, 3, 4],
    yPath: 'ball.offset', yValues: [-0.005, 0, 0.005],
    extract: (rep) => rep.maxY,
    statistic: SPREAD_ACROSS_ROW_MEANS,
    iterations: 300,
  };
  const r1 = runScenarioNullTest('arc-containment', { ...base, seed: 1 });
  const r2 = runScenarioNullTest('arc-containment', { ...base, seed: 2 });
  assert.equal(r1.observed, r2.observed, 'the real data does not depend on the seed');
  assert.notEqual(r1.nullMean, r2.nullMean, 'two different seeds should not coincidentally draw an identical null mean');
});

test('the shuffle destroys labels only: a shuffle-invariant statistic (sum of all values) proves the multiset survives every draw', () => {
  // sumAll is invariant to WHICH cell each value lands in — the sum of every value in the
  // matrix must be identical for the real matrix and every single null draw. If it were not,
  // the shuffle would be altering data, not just labels, which is exactly the bug this proves
  // absent. This is a genuinely SATURATED statistic by construction (chosen deliberately for
  // that reason, not despite it) — NULL-FIX-1 (haiku-opencode2's review) found the machinery's
  // OWN prior version of this test asserted `percentile >= 99` here, which is the exact failure
  // this technique exists to catch: a percentile of ~100 from a statistic with zero
  // discriminative power reads as the strongest possible signal while meaning nothing. Fixed:
  // this test now asserts the machinery calls it what it is — `discriminating: false`,
  // `percentile: null` — never a percentile a reader could mistake for a real result.
  const sumAll = (matrix) => matrix.reduce((s, row) => s + row.reduce((rs, v) => rs + v, 0), 0);
  const r = runScenarioNullTest('arc-containment', {
    xPath: 'ball.speed', xValues: [1, 2, 3, 4, 5],
    yPath: 'ball.offset', yValues: [-0.005, 0, 0.005],
    extract: (rep) => rep.maxY,
    statistic: sumAll,
    iterations: 500,
    seed: 99,
  });
  // Floating-point addition is not perfectly associative, so a different summation ORDER (the
  // whole point of the shuffle) can differ from the real sum in the last bit or two — checked
  // with a tolerance tight enough to catch a real data-corrupting bug, loose enough to absorb
  // reordering error, never with strict equality.
  const EPS = 1e-9;
  assert.ok(Math.abs(r.nullMin - r.observed) < EPS, 'sum-of-all-values is shuffle-invariant up to float reordering error');
  assert.ok(Math.abs(r.nullMax - r.observed) < EPS);
  assert.ok(Math.abs(r.nullMean - r.observed) < EPS);
  assert.equal(r.discriminating, false, 'a shuffle-invariant statistic must be reported as non-discriminating, not as a percentile');
  assert.equal(r.percentile, null, 'no percentile should be reported when the null cannot discriminate');
});

test('a saturated grid (every cell reports the same value) is also reported as non-discriminating, regardless of statistic', () => {
  // The review's own named risk: "a channel with perfect reachability (all cells
  // contained=true) ... the shuffle changed nothing." Reproduced directly with a real
  // saturated grid (arc-containment's own default speed, which is fully contained everywhere
  // in this offset range — see scenarios.test.mjs's own measured containment grid) and an
  // ordinary, otherwise-discriminating statistic (SPREAD_ACROSS_ROW_MEANS) — it is the DATA
  // that's saturated here, not a specially-chosen invariant statistic, and the machinery must
  // catch it either way.
  const r = runScenarioNullTest('arc-containment', {
    xPath: 'ball.speed', xValues: [6], // a single value: contained=true at every offset below
    yPath: 'ball.offset', yValues: [-0.005, 0, 0.005],
    extract: (rep) => (rep.contained ? 1 : 0),
    statistic: SPREAD_ACROSS_ROW_MEANS,
    iterations: 200,
    seed: 5,
  });
  assert.equal(r.observed, 0, 'every cell contained=true means zero spread in the real data too');
  assert.equal(r.discriminating, false);
  assert.equal(r.percentile, null);
});

test('a cell that fails to run is refused, not silently pooled as a hole', () => {
  assert.throws(
    () => runScenarioNullTest('arc-containment', {
      xPath: 'durationS', xValues: [0, 1.0], // durationS=0 -> 0 physics steps -> a failed cell
      yPath: 'ball.speed', yValues: [3, 6],
      extract: (rep) => rep.maxY,
      statistic: SPREAD_ACROSS_ROW_MEANS,
      iterations: 10,
      seed: 1,
    }),
    /failed to run/
  );
});

test('a non-numeric extract() is refused before any shuffling happens', () => {
  assert.throws(
    () => runScenarioNullTest('arc-containment', {
      xPath: 'ball.speed', xValues: [1, 3],
      yPath: 'ball.offset', yValues: [0],
      extract: (rep) => rep.contained, // boolean, not a number
      statistic: SPREAD_ACROSS_ROW_MEANS,
      iterations: 10,
      seed: 1,
    }),
    /finite number/
  );
});

test('a non-finite statistic() is refused rather than reported as a real percentile', () => {
  assert.throws(
    () => runScenarioNullTest('arc-containment', {
      xPath: 'ball.speed', xValues: [1, 3],
      yPath: 'ball.offset', yValues: [0],
      extract: (rep) => rep.maxY,
      statistic: () => NaN,
      iterations: 10,
      seed: 1,
    }),
    /finite number/
  );
});

test('formatNullTest reports the percentile and the null range, never a pass/fail verdict', () => {
  const r = runScenarioNullTest('arc-containment', {
    xPath: 'ball.speed', xValues: [1, 3, 6],
    yPath: 'ball.offset', yValues: [-0.005, 0, 0.005],
    extract: (rep) => rep.maxY,
    statistic: SPREAD_ACROSS_ROW_MEANS,
    iterations: 200,
    seed: 3,
  });
  const text = formatNullTest(r);
  assert.ok(text.includes('percentile'));
  assert.ok(!/pass|fail|PASS|FAIL/.test(text), 'must report where the observed value sits, not a verdict');
});
