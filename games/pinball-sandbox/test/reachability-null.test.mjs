// Applies the label-permutation null test (SBX-NULL-1, scenarios.js) to the three
// ramp-reachability scenarios (SBX-PORT-1/2), per SBX-NULL-2: does the contact/mid-bat count
// respond to the flipper state a trial belongs to, or would relabeling which of the 81 trials
// belongs to which flipper state produce something similar?
//
// Grouping: the null is built over the SAME 81 trials the aggregate scenario already runs
// (see scenarios.js's `singleTrial` mode — same pos/dir/speed/side computation, same
// rampReachabilityTrial call, decoded from the identical posOffsets x angleOffsetsDeg x
// speedOffsets arrays), grouped by flipper state label (3 groups of 27) — the label under
// test, exactly as the LAB finding grouped by delay bin.
//
// No scenario was changed to get a particular result here (SBX-NULL-2's own rule). Both
// findings below are reported as measured, including the one that isn't interesting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenarioNullTest, formatNullTest } from '../src/scenarios.js';

const FLIPPER_STATE_LABELS = ['rest', 'active', 'flip-at-arrival'];
const COMBO_INDICES = Array.from({ length: 27 }, (_, i) => i);

/** Spread across the 3 flipper-state group means — the between-group signal a real,
 * geometry-driven effect would produce, exactly what a random relabeling should NOT reliably
 * reproduce if flipper state genuinely matters. */
const SPREAD_ACROSS_FLIPPER_STATE_MEANS = (matrix) => {
  const groupMeans = matrix.map((row) => row.reduce((s, v) => s + v, 0) / row.length);
  return Math.max(...groupMeans) - Math.min(...groupMeans);
};

function nullTestFor(scenarioName, extractField) {
  return runScenarioNullTest(scenarioName, {
    xPath: 'singleTrial.flipperStateLabel', xValues: FLIPPER_STATE_LABELS,
    yPath: 'singleTrial.comboIndex', yValues: COMBO_INDICES,
    extract: (r) => (r[extractField] ? 1 : 0),
    statistic: SPREAD_ACROSS_FLIPPER_STATE_MEANS,
    iterations: 2000,
    seed: 1,
  });
}

test('orbit-reachability-right: contact is saturated (81/81) — the null test has no variance to redistribute, degenerate not confirmatory', () => {
  // Every one of the 81 trials hits, in every relabeling, so the spread-across-groups
  // statistic is identically 0 on the real data AND on every null draw. percentile=100 here is
  // a mathematical certainty of a constant statistic, not evidence that flipper state matters
  // — reported for what it actually is, not glossed as "cleared comfortably."
  const r = nullTestFor('orbit-reachability-right', 'hit');
  assert.equal(r.observed, 0, 'contact is saturated: the real spread across flipper-state hit-rates is 0');
  assert.equal(r.nullMin, 0);
  assert.equal(r.nullMax, 0, 'a fully-saturated statistic has zero variance under ANY relabeling — degenerate, not a real null');
});

test("orbit-reachability-right: mid-bat (46/81) is the one with room to be noise, and it is NOT noise — flip-at-arrival's 27/27 vs. rest/active's ~1/3 sits above every one of 2000 relabelings", () => {
  // Real per-flipper-state mid-bat rates, measured directly: rest 9/27 (0.333), active 10/27
  // (0.370), flip-at-arrival 27/27 (1.0) — spread 0.667. That is a real, large difference by
  // flipper state, physically consistent with flip-at-arrival being a genuine mid-swing catch
  // (see d901cbf's own alongBat measurements). The permutation test confirms it is not an
  // artifact of which 46 of 81 trials happened to hit: relabeling flipper state at random,
  // 2000 times, never produced a spread this large — observed sits at the 100th percentile of
  // its own null (ties the null's own max of 0.667, exceeds every other draw).
  const r = nullTestFor('orbit-reachability-right', 'midBat');
  assert.ok(Math.abs(r.observed - (2 / 3)) < 1e-9, `expected spread 2/3, got ${r.observed}`);
  assert.equal(r.percentile, 100, `expected the observed spread to sit at the top of its own null — got percentile ${r.percentile}`);
});

test('slide-reachability-left: both contact (81/81) and mid-bat (81/81) are fully saturated — no variance for the null test to redistribute either way', () => {
  const contactR = nullTestFor('slide-reachability-left', 'hit');
  assert.equal(contactR.observed, 0);
  assert.equal(contactR.nullMax, 0);
  const midBatR = nullTestFor('slide-reachability-left', 'midBat');
  assert.equal(midBatR.observed, 0);
  assert.equal(midBatR.nullMax, 0);
});

test("monkeybars-reachability-upperLeft: both contact (81/81) and mid-bat (81/81) are fully saturated — same degenerate case", () => {
  const contactR = nullTestFor('monkeybars-reachability-upperLeft', 'hit');
  assert.equal(contactR.observed, 0);
  assert.equal(contactR.nullMax, 0);
  const midBatR = nullTestFor('monkeybars-reachability-upperLeft', 'midBat');
  assert.equal(midBatR.observed, 0);
  assert.equal(midBatR.nullMax, 0);
});

test('formatNullTest reports the percentile for the mid-bat finding, not a verdict', () => {
  const text = formatNullTest(nullTestFor('orbit-reachability-right', 'midBat'));
  assert.ok(text.includes('percentile 100.0'));
  assert.ok(!/pass|fail/i.test(text));
});
