// LAB-2's cradle-family per-geometry summary, pulled out of lab2Report.js's streaming loop as
// a pure function specifically so it can be tested here without a real run (lab2Report.js is a
// CLI script — main() runs unconditionally at import time, same category as every other report
// writer in this project — importing it with no --stageB/--cradle/--out argv just hits its own
// early usage check and returns, so the named exports are safe to import directly).
//
// Per 1a06d2729705d936: min-contact-speed (`cs`, instrument.js) wired in as `csMedianMps`,
// reported alongside `cradleRate`, not used to select anything — Stage A selection is
// unchanged pending opus2's ranking-validity guard fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cradleRowStats } from '../src/lab2Report.js';

// Importing lab2Report.js runs its module-scope main() with this test file's own argv, which
// (correctly) hits main()'s own "usage:" early-return and sets process.exitCode = 1 as a side
// effect — that would otherwise fail the whole test file regardless of what the actual test()
// assertions below find. Reset it before any test() runs; nothing past this point sets it again.
process.exitCode = 0;

test('cradleRowStats: a known record set yields the exact expected cradleRate/settleTime/bounces/csMedian', () => {
  const records = [
    // Settled (cr=1, st within the 1.5s window): st=0.4, bn=3, cs=0.20
    { cr: 1, st: 0.4, bn: 3, cs: 0.20 },
    // Settled: st=0.8, bn=5, cs=0.30
    { cr: 1, st: 0.8, bn: 5, cs: 0.30 },
    // cr=1 but st beyond the 1.5s window — NOT counted as settled (matches the existing
    // `r.st <= CRADLE_SETTLE_WINDOW_S` condition lab2Report.js already applied).
    { cr: 1, st: 2.0, bn: 9, cs: 0.15 },
    // cr=0 (contacted, never settled) — contributes to csVals (contacting), not to settled.
    { cr: 0, st: null, bn: 4, cs: 0.50 },
    // Never contacted a flipper at all — cs is null, contributes to neither.
    { cr: 0, st: null, bn: 0, cs: null },
  ];
  const result = cradleRowStats(records);
  assert.equal(result.trials, 5);
  assert.equal(result.settled, 2, 'only the two cr=1 records with st <= 1.5s count as settled');
  assert.equal(result.cradleRate, 2 / 5);
  assert.equal(result.settleTimeMeanS, (0.4 + 0.8) / 2);
  assert.equal(result.bouncesMean, (3 + 5) / 2, 'bouncesMean is over SETTLED trials only, matching the pre-existing behaviour');
  // csVals = [0.20, 0.30, 0.15, 0.50] (every contacting trial, settled or not; null excluded)
  // sorted: [0.15, 0.20, 0.30, 0.50] -> median of 4 values = mean(0.20, 0.30) = 0.25
  assert.equal(result.csMedianMps, 0.25);
});

test('cradleRowStats: no contacting trials at all reports null csMedianMps and a measured zero cradleRate', () => {
  const records = [{ cr: 0, st: null, bn: 0, cs: null }, { cr: 0, st: null, bn: 0, cs: null }];
  const result = cradleRowStats(records);
  assert.equal(result.trials, 2);
  assert.equal(result.settled, 0);
  assert.equal(result.cradleRate, 0, 'two real trials, zero settled, is a genuinely measured 0% — distinct from the empty-array case below');
  assert.equal(result.csMedianMps, null);
});

// LAB-28 (V4, cross-family review 2026-09-05): `trials > 0 ? settled / trials : 0` used to
// report `cradleRate: 0` for zero trials too — identical to the two-real-trials-zero-settled
// case above, with no way for a reader of the published summary to tell "measured, genuinely
// zero" apart from "never measured at all". `null` is this project's existing sentinel for "not
// measured" (see `settleTimeMeanS`/`bouncesMean`/`csMedianMps` right below it in the same
// return, and `fmtPct` in lab2Report.js which renders it as `—`, not `0.0`).
test('cradleRowStats: an empty record array reports null cradleRate (unmeasured), not a measured-zero 0', () => {
  const result = cradleRowStats([]);
  assert.equal(result.trials, 0);
  assert.equal(result.settled, 0);
  assert.equal(result.cradleRate, null, 'zero trials carries no statistical power — must not read as a passing/clean measured rate');
  assert.equal(result.settleTimeMeanS, null);
  assert.equal(result.bouncesMean, null);
  assert.equal(result.csMedianMps, null);
});
