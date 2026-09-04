// LAB-11/P0-1: the shared §2.7 validity gate — one pure implementation now reused by every
// stage runner instead of "computed but never compared" (code review 20260902T130928Z).
import test from 'node:test';
import assert from 'node:assert/strict';
import { flagGateResult, FLAG_GATE_FRACTION, rankingValidityResult } from '../src/gate.js';

test('flagGateResult: at or under 1% passes', () => {
  assert.equal(flagGateResult({ trials: 100000, flagged: 1000 }).ok, true); // exactly 1%
  assert.equal(flagGateResult({ trials: 100000, flagged: 999 }).ok, true);
});

test('flagGateResult: over 1% fails', () => {
  const r = flagGateResult({ trials: 100000, flagged: 1001 });
  assert.equal(r.ok, false);
  assert.ok(Math.abs(r.fraction - 0.01001) < 1e-9);
});

test('flagGateResult: zero trials does not divide by zero', () => {
  const r = flagGateResult({ trials: 0, flagged: 0 });
  assert.equal(r.fraction, 0);
  assert.equal(r.ok, true);
});

test('flagGateResult: honours a custom gateFraction (E4-style exclusion is the caller\'s job)', () => {
  const r = flagGateResult({ trials: 1000, flagged: 50, gateFraction: 0.1 });
  assert.equal(r.ok, true);
  assert.equal(FLAG_GATE_FRACTION, 0.01);
});

// --- LAB-20: the topN early-return bug --------------------------------------------------
// `rankingValidityResult`'s `topN` branch computed distinctCount and maxTieFraction and then
// returned WITHOUT comparing either against minDistinct/maxTieBlockFraction — those two checks
// existed only in the fall-through path. Supplying a topN therefore silently disabled both
// population checks and left boundary ambiguity as the sole test.
//
// That is how E1's September `cradleProxy` shipped a "top 12" drawn from a metric with 4
// distinct values across 3,888 rows: the identical array fails without topN and passed with it.
// It is not, as first diagnosed, luck of where the cut fell — the guard already contained the
// check that would have caught it.
//
// Fixture is the real pre-fix distribution (data/e1/stageA-20260901T073830Z/ranking.json, a
// gitignored run dir, so reproduced inline): 3871 zeros, 12 at 1/99, 4 at 1/108, 1 at 2/108.
function septemberCradleProxy() {
  return [
    ...Array(3871).fill(0),
    ...Array(12).fill(1 / 99),
    ...Array(4).fill(1 / 108),
    2 / 108,
  ];
}

test('rankingValidityResult: topN path still applies the distinct-count floor (LAB-20)', () => {
  const values = septemberCradleProxy();
  assert.equal(values.length, 3888);
  const withoutTopN = rankingValidityResult(values);
  const withTopN = rankingValidityResult(values, { topN: 12 });
  assert.equal(withoutTopN.ok, false, 'sanity: the same array fails without topN');
  assert.equal(withTopN.ok, false, 'topN must not disable the distinct-count floor');
  assert.match(withTopN.reason, /distinct value\(s\)/);
});

test('rankingValidityResult: topN path still applies the tie-fraction ceiling (LAB-20)', () => {
  const r = rankingValidityResult(septemberCradleProxy(), { topN: 12 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tied at one value/);
});

test('rankingValidityResult: topN path reports boundary ambiguity alongside the restored checks', () => {
  const r = rankingValidityResult(septemberCradleProxy(), { topN: 12 });
  // The boundary test was never wrong — 1.09x is a real and benign number for this array. It
  // stays reported; it just no longer stands alone as the whole verdict.
  assert.ok(Math.abs(r.boundaryAmbiguity - 12 / 11) < 1e-9);
  assert.equal(r.distinctCount, 4);
});

test('rankingValidityResult: a well-resolved metric still passes with topN (no false positive)', () => {
  // E1's fanWidthXa shape: 3888 rows, every value distinct.
  const values = Array.from({ length: 3888 }, (_, i) => i * 0.01);
  const r = rankingValidityResult(values, { topN: 12 });
  assert.equal(r.ok, true, 'full-resolution metric must still pass');
  assert.equal(r.reason, null);
});

test('rankingValidityResult: a ceiling-saturated top-N still fails on boundary ambiguity', () => {
  // E4 Stage B's shape: good resolution across the population, but the selection region is
  // saturated — 101 rows tied at the maximum, 20 slots. Distinct from cradleProxy's floor
  // case, and already caught by the boundary test; asserted so the two stay distinguishable.
  const values = [...Array(101).fill(1), ...Array.from({ length: 439 }, (_, i) => i / 1000)];
  const r = rankingValidityResult(values, { topN: 20 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cut lands inside a 101-way tie/);
});
