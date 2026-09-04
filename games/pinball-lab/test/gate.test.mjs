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

// --- LAB-21: raw-event support ----------------------------------------------------------
// The restored floor/ceiling catch a metric with no spread. They cannot catch a metric that has
// spread but no SUPPORT: 3,888 rows with plenty of distinct values, every one of them a rate
// estimated from one or two raw events. `0.010101` alone is unreadable — it could be 1/99 or
// 10/990 — so the check needs the denominator, supplied as an optional per-row `support` array.
//
// The September cradleProxy is exactly this case once the tie mass is set aside: its entire
// nonzero population is 16 rows at k=1 and one at k=2, over ~99-108 trials each. Reuses the
// LAB-20 fixture above; this is the per-row denominator that goes with it, in the same order.
function septemberSupport() {
  return [...Array(3871).fill(108), ...Array(12).fill(99), ...Array(4).fill(108), 108];
}

test('LAB-21: a top-N whose selected rows rest on 1-2 raw events fails on support', () => {
  const values = septemberCradleProxy();
  const support = septemberSupport();
  const r = rankingValidityResult(values, { topN: 12, support });
  assert.equal(r.ok, false);
  assert.match(r.reason, /raw event/i);
  assert.equal(r.minSelectedSupport, 1, 'the weakest selected row rests on a single event');
});

test('LAB-21: the same array WITHOUT support degrades to today\'s behaviour, never silently passes', () => {
  const values = septemberCradleProxy();
  const withSupport = rankingValidityResult(values, { topN: 12, support: septemberSupport() });
  const without = rankingValidityResult(values, { topN: 12 });
  // both must fail here (the tie ceiling alone already condemns this array), but the point is
  // that omitting `support` must not INVENT a pass, and must not claim a support verdict.
  assert.equal(without.ok, false);
  assert.equal(without.minSelectedSupport, null, 'no support supplied -> no support verdict');
  assert.doesNotMatch(without.reason, /raw event/i);
  assert.match(withSupport.reason, /raw event/i);
});

test('LAB-21: a well-supported top-N passes (no false positive on real rates)', () => {
  // E4 Stage B's shape: rates near 1.0 measured over ~730 trials each.
  const values = Array.from({ length: 540 }, (_, i) => 1 - i / 2000);
  const support = Array(540).fill(730);
  const r = rankingValidityResult(values, { topN: 20, support });
  assert.equal(r.ok, true);
  assert.ok(r.minSelectedSupport >= 700, 'selected rows rest on hundreds of events');
});

// This is the test that justifies the condition existing at all. On today's data the support
// check changes no verdict anywhere — `cradleProxy`, the case it was designed for, is already
// failed by the restored tie ceiling (99.6% > 50%). So the condition is only worth its weight if
// it catches something the other three cannot. It does, and this is that shape: good spread
// (200 distinct values), low tie mass (well under 50%), an unambiguous cut — and every selected
// row resting on a single raw event. All of LAB-16/17/20 pass it; only support fails it.
test('LAB-21: catches spread-without-support, which no other condition sees', () => {
  // 200 distinct rates, each 1/n for a different n — no ties at the cut, no tie mass.
  const values = Array.from({ length: 200 }, (_, i) => 1 / (300 + i));
  const support = Array.from({ length: 200 }, (_, i) => 300 + i);   // every row is k=1
  const withoutSupport = rankingValidityResult(values, { topN: 12 });
  assert.equal(withoutSupport.ok, true, 'passes every pre-LAB-21 check: spread, low ties, clean cut');
  const withSupport = rankingValidityResult(values, { topN: 12, support });
  assert.equal(withSupport.ok, false, 'but every selected row rests on one event');
  assert.equal(withSupport.minSelectedSupport, 1);
  assert.match(withSupport.reason, /raw event/i);
});

test('LAB-21: support of the wrong length is a wiring error, not a silent skip', () => {
  assert.throws(() => rankingValidityResult([0.1, 0.2, 0.3], { topN: 2, support: [10, 10] }),
    /support/i);
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
