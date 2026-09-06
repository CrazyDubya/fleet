// Tests for the guarded cut (CUT-1/CUT-1B). Specification:
// ledger/handoffs/opus2/20260905T134019Z-guarded-cut-spec.md, amended by Part A of
// ledger/handoffs/opus2/20260905T135010Z-guarded-dominance.md. Library only — no writer is
// exercised here, per src/selectTopN.js's own top-of-file note that rewiring the fourteen
// callers is a separate dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTopN, ANALYTIC, mean, median, meanOf01, p95Minusp5 } from '../src/selectTopN.js';

// Deterministic pseudo-noise generator (same trick used in the lab's own worked examples) so
// every fixture below is reproducible without a real RNG import.
function mkNoisy(base, spread, count, seedOffset) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    const t = Math.sin((i + seedOffset) * 12.9898) * 43758.5453;
    const frac = t - Math.floor(t);
    arr.push(base + (frac - 0.5) * spread);
  }
  return arr;
}

// --- refusal: contract violations throw, and only contract violations throw ------------

test('selectTopN: throws when samples is omitted entirely (no analytic path by omission)', () => {
  assert.throws(
    () => selectTopN({ rows: [{ id: 'a' }], estimator: median, n: 1, key: (r) => r.id }),
    /samples is required/,
  );
});

test('selectTopN: throws on a non-function, non-ANALYTIC samples (no way to hand it a number)', () => {
  assert.throws(
    () => selectTopN({ rows: [{ id: 'a' }], samples: 42, estimator: median, n: 1, key: (r) => r.id }),
    /samples must be a \(row\) => number\[\] function/,
  );
});

test('selectTopN: throws naming the row when samples(row) is empty', () => {
  const rows = [{ id: 'a', s: [] }, { id: 'b', s: [1, 2, 3] }];
  assert.throws(
    () => selectTopN({ rows, samples: (r) => r.s, estimator: median, n: 1, key: (r) => r.id }),
    /key "a".*empty array/s,
  );
});

test('selectTopN: throws naming the row and index when samples(row) contains a non-finite value', () => {
  const rows = [{ id: 'a', s: [1, NaN, 3] }, { id: 'b', s: [4, 5, 6] }];
  assert.throws(
    () => selectTopN({ rows, samples: (r) => r.s, estimator: median, n: 1, key: (r) => r.id }),
    /key "a".*index 1.*NaN/s,
  );
});

test('selectTopN: rejects non-finite samples before the estimator sees them, so corruption cannot inflate a row toward the cut', () => {
  // CUT-1B Part A1: percentile() treats NaN as larger than every real value, biasing a
  // corrupted row upward. This must never reach percentile() at all.
  const rows = [
    { id: 'corrupt', s: [1, 2, 3, NaN] }, // would rank highest under median-of-NaN-as-+Inf
    { id: 'a', s: [10, 11, 12] },
    { id: 'b', s: [8, 9, 10] },
  ];
  assert.throws(() => selectTopN({ rows, samples: (r) => r.s, estimator: median, n: 1, key: (r) => r.id }));
});

test('selectTopN: throws when key is not a function (no bare-identifier-string arrays)', () => {
  const rows = [{ id: 'a', s: [1, 2, 3] }];
  assert.throws(
    () => selectTopN({ rows, samples: (r) => r.s, estimator: median, n: 1 }),
    /key must be a \(row\) => string function/,
  );
});

test('selectTopN: throws when n is out of [1, rows.length]', () => {
  const rows = [{ id: 'a', s: [1, 2] }, { id: 'b', s: [3, 4] }];
  assert.throws(() => selectTopN({ rows, samples: (r) => r.s, estimator: median, n: 0, key: (r) => r.id }), /n must be an integer/);
  assert.throws(() => selectTopN({ rows, samples: (r) => r.s, estimator: median, n: 3, key: (r) => r.id }), /n must be an integer/);
  assert.throws(() => selectTopN({ rows, samples: (r) => r.s, estimator: median, n: 1.5, key: (r) => r.id }), /n must be an integer/);
});

test('selectTopN: throws on an empty rows array (no ruling on zero rows)', () => {
  assert.throws(() => selectTopN({ rows: [], samples: (r) => r.s, estimator: median, n: 1, key: (r) => r.id }));
});

test('selectTopN: throws when support is supplied with a non-rate estimator', () => {
  const rows = [{ id: 'a', s: [1, 2, 3] }, { id: 'b', s: [4, 5, 6] }];
  assert.throws(
    () => selectTopN({ rows, samples: (r) => r.s, estimator: median, n: 1, key: (r) => r.id, support: () => 10 }),
    /not a rate estimator/,
  );
});

test('selectTopN: throws when support is supplied alongside ANALYTIC (no per-trial denominator)', () => {
  const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
  assert.throws(
    () => selectTopN({ rows, samples: ANALYTIC, estimator: (r) => r.v, n: 1, key: (r) => r.id, support: () => 10 }),
    /support has no meaning with samples: ANALYTIC/,
  );
});

test('selectTopN: throws when a caller-supplied custom estimator produces a non-finite value from finite qualifying input (V4 discipline)', () => {
  // A custom estimator only has to declare minSamples to pass the entry contract check — it
  // does not go through makeEstimator's own totality guard, so selectTopN itself must catch
  // a silent NaN/Infinity here (CUT-1B Part A2 clause 2), the same way it does for the
  // built-in estimators.
  const rows = [{ id: 'a', s: [1, 2, 3] }, { id: 'b', s: [4, 5, 6] }];
  const misbehaving = (xs) => NaN;
  misbehaving.minSamples = 1;
  assert.throws(
    () => selectTopN({ rows, samples: (r) => r.s, estimator: misbehaving, n: 1, key: (r) => r.id }),
    /non-finite/,
  );
});

// --- built-in estimator totality (CUT-1B Part A2) ---------------------------------------

test('p95Minusp5 declares minSamples=20 and rows below it are refused, not scored', () => {
  const rows = [
    { id: 'plenty', s: Array.from({ length: 20 }, (_, i) => i) },
    { id: 'few', s: [1, 2] },
  ];
  const r = selectTopN({ rows, samples: (r) => r.s, estimator: p95Minusp5, n: 1, key: (r) => r.id });
  const few = r.population.find((p) => p.key === 'few');
  assert.equal(few.value, null);
  assert.match(few.refusedReason, /only 2 sample\(s\), below estimator 'p95Minusp5''s minimum of 20/);
});

// --- ANALYTIC path: a positive declaration, and the operation still computes the value -----

test('selectTopN: ANALYTIC path accepts a (row) => number estimator and produces a ranked result', () => {
  const rows = [
    { id: 'a', v: 1 }, { id: 'b', v: 5 }, { id: 'c', v: 3 }, { id: 'd', v: 4 }, { id: 'e', v: 2 },
  ];
  const r = selectTopN({ rows, samples: ANALYTIC, estimator: (row) => row.v, n: 2, key: (row) => row.id });
  assert.equal(r.kind, 'ranked');
  assert.deepEqual(r.cut.map((c) => c.key), ['b', 'd']);
  assert.deepEqual(r.stability, { kind: 'not-applicable', why: 'analytic' });
});

test('selectTopN: ANALYTIC path throws if the row-level estimator returns non-finite', () => {
  const rows = [{ id: 'a', v: 1 }, { id: 'b', v: NaN }, { id: 'c', v: 3 }, { id: 'd', v: 4 }, { id: 'e', v: 5 }];
  assert.throws(
    () => selectTopN({ rows, samples: ANALYTIC, estimator: (row) => row.v, n: 1, key: (row) => row.id }),
    /non-finite/,
  );
});

// --- demotion: the E1-shaped case, coarse survives where fine cannot --------------------
//
// Two well-separated four-row clusters (median ~10 vs median ~2), each cluster internally
// noisy enough that the four members within it cannot be stably ordered against one another.
// A request for the full n=8 ranking must NOT resolve; a 2-way split (top cluster vs bottom
// cluster) must be near-perfectly stable. This is the shape opus2's E1 result described:
// "which twelve is unresolvable, top-half/bottom-half holds at 78%."

function clusteredRows() {
  return [
    { id: 'A', s: mkNoisy(10, 6, 40, 1) },
    { id: 'B', s: mkNoisy(10.2, 6, 40, 2) },
    { id: 'C', s: mkNoisy(9.8, 6, 40, 5) },
    { id: 'E', s: mkNoisy(10.1, 6, 40, 6) },
    { id: 'D', s: mkNoisy(2, 1, 40, 3) },
    { id: 'F', s: mkNoisy(1.8, 1, 40, 4) },
    { id: 'G', s: mkNoisy(2.1, 1, 40, 7) },
    { id: 'H', s: mkNoisy(1.9, 1, 40, 8) },
  ];
}

test('selectTopN: demotes to banded when the requested n is not resolvable but a coarser split is stable', () => {
  const rows = clusteredRows();
  const r = selectTopN({ rows, samples: (row) => row.s, estimator: median, n: rows.length, key: (row) => row.id });
  assert.equal(r.kind, 'banded');
  assert.ok(r.bandCount < rows.length, 'must not silently produce a full ranking when full n does not survive resampling');
  assert.equal(r.requestedN, rows.length);
  assert.equal(r.population.length, rows.length, 'population always carries every row, even on a demotion');
  // The 2-way split (top cluster vs bottom cluster) is near-perfectly stable in this fixture.
  const kTwo = r.stability.curve.find((p) => p.k === 2);
  assert.ok(kTwo.withinOne >= 0.95 && kTwo.exactAgreement > 0.5, 'the coarse 2-way split must be the one that survives');
  assert.equal(r.cut, undefined, 'a banded result must have no cut field to publish (anti-V2)');
});

test('selectTopN: a banded result groups the two noisy clusters correctly at k=2 evaluation, even though the chosen band count is finer', () => {
  const rows = clusteredRows();
  const r = selectTopN({ rows, samples: (row) => row.s, estimator: median, n: rows.length, key: (row) => row.id });
  // Whatever k was chosen, the first band's rows must all come from the high cluster and the
  // last band's rows from the low cluster — the demotion should never interleave the clusters.
  const highIds = new Set(['A', 'B', 'C', 'E']);
  const firstBandIds = r.bands[0].map((b) => b.key);
  const lastBandIds = r.bands[r.bands.length - 1].map((b) => b.key);
  assert.ok(firstBandIds.every((id) => highIds.has(id)));
  assert.ok(lastBandIds.every((id) => !highIds.has(id)));
});

test('selectTopN: demotes all the way to unordered when not even a 2-way split is stable', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ id: `R${i}`, s: mkNoisy(5, 40, 40, i * 3 + 1) });
  const r = selectTopN({ rows, samples: (row) => row.s, estimator: median, n: rows.length, key: (row) => row.id });
  assert.equal(r.kind, 'unordered');
  assert.equal(r.structural.ok, true, 'this refusal is a stability failure, not a structural one — distinct values exist, they just cannot be ordered stably');
  assert.match(r.reason, /not even a 2-way split survives/);
  assert.equal(r.population.length, rows.length, 'population survives even total demotion');
  assert.equal(r.cut, undefined);
  assert.equal(r.bands, undefined);
});

test('selectTopN: unordered when the structural gate fails outright (too few distinct values)', () => {
  const rows = [
    { id: 'a', s: [1, 1, 1] }, { id: 'b', s: [1, 1, 1] },
    { id: 'c', s: [2, 2, 2] }, { id: 'd', s: [2, 2, 2] },
  ];
  const r = selectTopN({ rows, samples: (row) => row.s, estimator: median, n: 2, key: (row) => row.id });
  assert.equal(r.kind, 'unordered');
  assert.equal(r.stability.kind, 'not-computed', 'structural failure must short-circuit before any resampling is attempted');
  assert.match(r.reason, /distinct value/);
});

// --- success: a genuinely resolvable cut ------------------------------------------------

test('selectTopN: returns ranked with a stable cut when the requested n is actually resolvable', () => {
  const rows = clusteredRows();
  // Only the top-2 (well inside the stable high cluster) is being asked for.
  const r = selectTopN({ rows, samples: (row) => row.s, estimator: median, n: 2, key: (row) => row.id });
  assert.equal(r.kind, 'ranked');
  assert.equal(r.cut.length, 2);
  assert.deepEqual(new Set(r.cut.map((c) => c.key)), new Set(['E', 'B']));
  assert.ok(r.stability.exactAgreement >= 0.95);
  assert.ok(r.stability.withinOne >= 0.95);
  assert.equal(typeof r.stability.seed, 'number');
  assert.equal(r.population.length, rows.length);
});

test('selectTopN: ranked result is reproducible — same inputs, same seed, same stability numbers', () => {
  const rows = clusteredRows();
  const r1 = selectTopN({ rows, samples: (row) => row.s, estimator: median, n: 2, key: (row) => row.id });
  const r2 = selectTopN({ rows, samples: (row) => row.s, estimator: median, n: 2, key: (row) => row.id });
  assert.deepEqual(r1, r2);
});

// --- n=1 CUT SIZE (a top-1 request), as distinct from n=1 SAMPLE per row above -----------
//
// GUARD-MIGRATE: found migrating the first real top-1 caller (lab2Report.js's best-geometry
// pick). `for (let k = 2; k <= n; k++)` never executes when the requested cut size n is 1, so
// `curve` was empty and the final `unordered` branch's `curve[0].withinOne` threw — for EVERY
// top-1 request against a population with real per-row samples, not an edge case. Fixed by
// evaluating at least the k=2 diagnostic regardless of n.

test('selectTopN: a top-1 cut (n=1) over a genuinely resolvable population returns ranked, not a crash', () => {
  const rows = clusteredRows();
  const r = selectTopN({ rows, samples: (row) => row.s, estimator: median, n: 1, key: (row) => row.id });
  assert.equal(r.kind, 'ranked');
  assert.equal(r.cut.length, 1);
  assert.ok(['A', 'B', 'C', 'E'].includes(r.cut[0].key), 'the single winner must come from the high cluster');
  assert.ok(r.stability.withinOne >= 0.95, 'a resolvable top-1 must report the k=2 diagnostic it was evaluated against, not a fabricated number');
});

test('selectTopN: a top-1 cut (n=1) over an unresolvable population demotes to unordered instead of throwing', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ id: `R${i}`, s: mkNoisy(5, 40, 40, i * 3 + 1) });
  const r = selectTopN({ rows, samples: (row) => row.s, estimator: median, n: 1, key: (row) => row.id });
  assert.equal(r.kind, 'unordered');
  assert.equal(r.cut, undefined);
  assert.match(r.reason, /not even a 2-way split survives/);
});

test('selectTopN: n=1-per-row populations report stability as indeterminate rather than fabricating a resampling result', () => {
  const rows = [
    { id: 'a', s: [5] }, { id: 'b', s: [4] }, { id: 'c', s: [3] }, { id: 'd', s: [2] }, { id: 'e', s: [1] },
  ];
  const r = selectTopN({ rows, samples: (row) => row.s, estimator: mean, n: 2, key: (row) => row.id });
  assert.equal(r.kind, 'ranked');
  assert.deepEqual(r.stability, { kind: 'indeterminate', why: 'n=1 per row' });
});

test('selectTopN: rate estimator (meanOf01) with support runs the full check', () => {
  const rows = [
    { id: 'a', o: Array(50).fill(1) },
    { id: 'b', o: [...Array(45).fill(1), ...Array(5).fill(0)] },
    { id: 'c', o: [...Array(10).fill(1), ...Array(40).fill(0)] },
    { id: 'd', o: [...Array(5).fill(1), ...Array(45).fill(0)] },
    { id: 'e', o: Array(50).fill(0) },
    { id: 'f', o: [...Array(25).fill(1), ...Array(25).fill(0)] },
  ];
  const r = selectTopN({
    rows, samples: (row) => row.o, estimator: meanOf01, n: 2, key: (row) => row.id,
    support: (row) => row.o.length,
  });
  assert.ok(r.kind === 'ranked' || r.kind === 'banded' || r.kind === 'unordered');
  assert.equal(r.population.length, rows.length);
});
