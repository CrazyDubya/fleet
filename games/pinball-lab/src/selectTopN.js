// CUT-1/CUT-1B: the guarded cut. Specification: opus2's
// `ledger/handoffs/opus2/20260905T134019Z-guarded-cut-spec.md`, amended by Part A of
// `ledger/handoffs/opus2/20260905T135010Z-guarded-dominance.md`. This is the operation LAB-28's
// review found five ways around (V1-V5, `ledger/handoffs/haiku-opencode2/20260905-writer-review.
// md`); building it is what makes most of that class of bug structurally impossible rather than
// merely fixed at five call sites. See §CHOICES at the bottom of this file for the two points
// where the specification left something open and what was decided here — nothing else was
// improvised.
//
// This dispatch implements the library ONLY. No existing writer is rewired to call it — that is
// a separate, later job (fourteen callers, per the spec's §7), and mixing "build the operation"
// with "rewire the callers" in one dispatch would make a bad result in either half impossible to
// attribute to the right half.
import { mean as arrMean, percentile } from './metrics.js';
import { rankingValidityResult } from './gate.js';

/** The positive declaration that a quantity has no sampling error (§2/§3 of the spec: "not
 * checked must never read as passed" — a caller cannot get the analytic path by omission, only
 * by explicitly passing this sentinel as the whole `samples` option). */
export const ANALYTIC = Symbol('selectTopN.ANALYTIC');

const DEFAULT_RESAMPLES = 25;

// --- estimators -----------------------------------------------------------------------
//
// Every built-in estimator here is TOTAL on finite input that meets its own declared
// `minSamples` floor (CUT-1B Part A2, clause 2): it either returns a finite number or throws,
// never a silent NaN/Infinity. `p95Minusp5.minSamples = 20` per CUT-1B Part A2 clause 4 — below
// that the statistic is not measuring a percentile difference, it is min-to-max with the ends
// shaved (CUT-1B's own worked example: at n=4 it interpolates 15% in from each extreme).

function makeEstimator(name, fn, { minSamples = 1, rate = false } = {}) {
  const estimator = (samples) => {
    const v = fn(samples);
    if (!Number.isFinite(v)) {
      throw new Error(
        `selectTopN: estimator '${name}' produced a non-finite value (${v}) from ${samples.length} ` +
        `finite input(s) meeting its own minSamples floor (${minSamples}) — an estimator must be ` +
        'total on qualifying finite input, never return a silent NaN/Infinity (CUT-1B Part A2).'
      );
    }
    return v;
  };
  estimator.minSamples = minSamples;
  estimator.rate = rate;
  estimator.estimatorName = name;
  return estimator;
}

export const mean = makeEstimator('mean', arrMean, { minSamples: 1 });
export const median = makeEstimator('median', (xs) => percentile(xs, 50), { minSamples: 1 });
/** A rate: mean of a per-trial 0/1 array. Declares `rate: true` so `support` may be supplied
 * alongside it (§4: support with a non-rate estimator throws). */
export const meanOf01 = makeEstimator('meanOf01', arrMean, { minSamples: 1, rate: true });
/** CUT-1B Part A2: min 20, not the ~4-8 the fan-width caller was actually running with. */
export const p95Minusp5 = makeEstimator('p95Minusp5', (xs) => percentile(xs, 95) - percentile(xs, 5), { minSamples: 20 });

// --- deterministic PRNG -----------------------------------------------------------------
//
// Seed derived from the DATA (a hash of the ordered key/value pairs), never passed in — spec
// §6: "so the result is reproducible without adding a caller argument, and re-running cannot
// shop for a seed." mulberry32 for the generator itself: small, well-known, no dependency.

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- banding --------------------------------------------------------------------------
//
// Rows already sorted best-first by value are split into `k` contiguous, as-equal-as-possible
// bands. Used both to measure split-half stability (band each half's own ranking, compare band
// index per row) and to report `bands` on a `banded` verdict.
function bandIndices(len, k) {
  const idx = new Array(len);
  for (let i = 0; i < len; i++) idx[i] = Math.floor((i * k) / len);
  return idx; // 0-based, best band first
}

// --- the operation ----------------------------------------------------------------------

export function selectTopN({ rows, samples, estimator, n, key, direction = 'desc', support, bandRule, resamples = DEFAULT_RESAMPLES }) {
  // --- contract checks: throw, never degrade (spec §4: offline batch analysis, no partial
  // result is better than stopping) ---
  if (!Array.isArray(rows) || rows.length < 1) {
    throw new Error(`selectTopN: rows must be a non-empty array, got ${Array.isArray(rows) ? `an array of length ${rows.length}` : typeof rows}`);
  }
  if (typeof key !== 'function') throw new Error('selectTopN: key must be a (row) => string function — required so a result can carry identity, not bare strings');
  const analytic = samples === ANALYTIC;
  if (samples === undefined) {
    throw new Error('selectTopN: samples is required — pass a (row) => number[] function, or the ANALYTIC sentinel if this quantity has no sampling error. There is no way to hand this operation a pre-computed number.');
  }
  // In ANALYTIC mode `estimator` is a (row) => number function (§CHOICES #1) and has no
  // per-column minSamples floor to declare — there is no samples array for a floor to apply
  // to. Off the analytic path, estimator must be one of this module's (samples) => number
  // estimators, which always declare minSamples.
  if (typeof estimator !== 'function' || (!analytic && typeof estimator.minSamples !== 'number')) {
    throw new Error(analytic
      ? 'selectTopN: with samples: ANALYTIC, estimator must be a (row) => number function'
      : "selectTopN: estimator must be one of this module's estimator functions (mean/median/meanOf01/p95Minusp5) or built the same way — it must declare minSamples");
  }
  if (!Number.isInteger(n) || n < 1 || n > rows.length) {
    throw new Error(`selectTopN: n must be an integer in [1, ${rows.length}], got ${JSON.stringify(n)}`);
  }
  if (direction !== 'asc' && direction !== 'desc') throw new Error(`selectTopN: direction must be 'asc' or 'desc', got ${JSON.stringify(direction)}`);
  if (!analytic && typeof samples !== 'function') {
    throw new Error("selectTopN: samples must be a (row) => number[] function, or exactly the ANALYTIC sentinel — not a value");
  }
  if (support !== undefined) {
    if (typeof support !== 'function') throw new Error('selectTopN: support must be a (row) => number function');
    if (analytic) throw new Error('selectTopN: support has no meaning with samples: ANALYTIC — an analytic value has no per-trial denominator');
    if (!estimator.rate) throw new Error(`selectTopN: support was supplied but estimator '${estimator.estimatorName}' is not a rate estimator (rate:true) — support only means something for a fraction-of-trials estimator like meanOf01`);
  }

  // --- per-row value derivation: the operation computes it, never receives it ---
  const items = rows.map((row) => {
    const k = key(row);
    if (analytic) {
      const value = estimator(row); // ANALYTIC mode: estimator is (row) => number — see §CHOICES
      if (!Number.isFinite(value)) throw new Error(`selectTopN: analytic estimator produced a non-finite value for row ${JSON.stringify(k)}`);
      return { row, key: k, value, n: null, refusedReason: null };
    }
    const arr = samples(row);
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error(
        `selectTopN: samples(row) for key ${JSON.stringify(k)} returned ${Array.isArray(arr) ? 'an empty array' : typeof arr} — ` +
        'supply real per-trial measurements, or pass samples: ANALYTIC if this quantity has no sampling error. ' +
        'A row with no samples is not a value of zero; there is no way to hand this operation a number.'
      );
    }
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) {
        throw new Error(
          `selectTopN: samples(row) for key ${JSON.stringify(k)} contains a non-finite value at index ${i} (${arr[i]}) — ` +
          'percentile-family estimators treat NaN as larger than every real value, silently biasing a corrupted row ' +
          'toward the top of the cut being taken (CUT-1B Part A1). Filter or fix upstream before calling.'
        );
      }
    }
    if (arr.length < estimator.minSamples) {
      return { row, key: k, value: null, n: arr.length, refusedReason: `only ${arr.length} sample(s), below estimator '${estimator.estimatorName}''s minimum of ${estimator.minSamples}` };
    }
    const value = estimator(arr);
    // CUT-1B Part A2 clause 2: an estimator must be total on finite input meeting its own
    // minSamples floor. This module's own estimators (makeEstimator) already enforce this on
    // themselves; this check exists for a caller-supplied custom estimator, which only has to
    // declare minSamples to pass the contract check above and would otherwise reach the sort
    // with a silent NaN/Infinity.
    if (!Number.isFinite(value)) {
      throw new Error(
        `selectTopN: estimator${estimator.estimatorName ? ` '${estimator.estimatorName}'` : ''} produced a ` +
        `non-finite value (${value}) for row ${JSON.stringify(k)} from ${arr.length} finite input(s) meeting its ` +
        'own minSamples floor — an estimator must be total on qualifying finite input, never return a silent ' +
        'NaN/Infinity (CUT-1B Part A2).'
      );
    }
    return { row, key: k, value, n: arr.length, refusedReason: null, samplesArr: arr };
  });

  const dir = direction === 'asc' ? 1 : -1;
  const sorted = [...items].sort((a, b) => {
    if (a.value === null && b.value === null) return 0;
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    return dir * (a.value - b.value);
  });
  const population = sorted.map((it) => ({ key: it.key, value: it.value, samples: it.n, refusedReason: it.refusedReason }));
  const eligible = sorted.filter((it) => it.value !== null);

  const seed = fnv1a(JSON.stringify(sorted.map((it) => [it.key, it.value])));

  // --- structural check: can this column carry an ordering at all? ---
  const values = eligible.map((it) => it.value);
  const supportArr = support ? eligible.map((it) => support(it.row)) : null;
  const structuralTopN = Math.min(n, eligible.length);
  const structural = rankingValidityResult(values, {
    topN: eligible.length > 0 ? structuralTopN : null,
    support: supportArr,
  });

  if (!structural.ok || eligible.length === 0) {
    return {
      kind: 'unordered', population, structural,
      stability: { kind: 'not-computed', why: 'structural check failed before stability was attempted' },
      reason: eligible.length === 0
        ? 'no row produced an eligible value (every row was refused or the population was empty)'
        : structural.reason,
    };
  }

  // Analytic and n=1-per-row populations have no sampling error / no split to measure — report
  // that plainly rather than running a resampling loop that can't answer anything (spec §3
  // table's "Analytic" and "One measurement per row" rows).
  if (analytic) {
    return { ...buildRanked(eligible, population, structural, n, direction), stability: { kind: 'not-applicable', why: 'analytic' } };
  }
  if (eligible.every((it) => it.n === 1)) {
    return { ...buildRanked(eligible, population, structural, n, direction), stability: { kind: 'indeterminate', why: 'n=1 per row' } };
  }

  // --- stability: repeated split-half band agreement, for every k in 2..n ---
  // GUARD-MIGRATE: a bare `k <= n` here leaves `curve` EMPTY whenever a caller requests a
  // top-1 cut (n=1) against a population with real per-row samples — found migrating the
  // first n=1 caller (lab2Report.js's best-geometry pick, e4Report.js's A1 top-1), which threw
  // reading `curve[0]` in the final `unordered` branch below. "Banding" is only meaningful at
  // k>=2, so a top-1 request still evaluates the coarsest possible diagnostic (k=2, "is even a
  // top-half/bottom-half split reproducible") rather than skipping stability entirely — the
  // same k=n-is-the-finest-diagnostic philosophy §CHOICES #2 already uses for n>=2, just
  // extended to cover n=1 rather than silently omitting it.
  const rule = bandRule ?? defaultBandRule;
  const curve = [];
  for (let k = 2; k <= Math.max(n, 2); k++) curve.push(bandAgreement(eligible, estimator, k, resamples, seed));

  const chosenK = rule(curve, n);

  if (chosenK >= n) {
    const point = curve[curve.length - 1]; // k === n, or k === 2 when n === 1 (see loop bound above)
    return { ...buildRanked(eligible, population, structural, n, direction), stability: { exactAgreement: point.exactAgreement, withinOne: point.withinOne, repeats: resamples, seed } };
  }
  if (chosenK >= 2) {
    const bandsIdx = bandIndices(eligible.length, chosenK);
    const bands = Array.from({ length: chosenK }, () => []);
    eligible.forEach((it, i) => bands[bandsIdx[i]].push({ key: it.key, value: it.value }));
    return {
      kind: 'banded', bands, bandCount: chosenK, requestedN: n, population, structural,
      stability: { curve, chosenK, rule: rule.ruleName ?? 'default' },
    };
  }
  return {
    kind: 'unordered', population, structural,
    stability: { curve, chosenK: null, rule: rule.ruleName ?? 'default' },
    reason: `not even a 2-way split survives split-half resampling (k=2 within-one ${(curve[0].withinOne * 100).toFixed(1)}%, exact ${(curve[0].exactAgreement * 100).toFixed(1)}%) — this column cannot support any ordering at the current sample budget`,
  };
}

function buildRanked(eligible, population, structural, n, direction) {
  const cut = eligible.slice(0, n).map((it) => ({ key: it.key, value: it.value, samples: it.n }));
  return { kind: 'ranked', cut, population, structural };
}

/** Default bandRule (spec §6): largest k in 2..n for which withinOne >= 0.95 AND
 * exactAgreement > 1/k. Returns 0 (< 2) if no k qualifies, meaning `unordered`. */
function defaultBandRule(curve, n) {
  let best = 0;
  for (const point of curve) {
    if (point.withinOne >= 0.95 && point.exactAgreement > 1 / point.k) best = point.k;
  }
  return best;
}
defaultBandRule.ruleName = 'withinOne>=0.95 && exactAgreement>1/k';
export { defaultBandRule };

/** Split-half band agreement at one k, averaged over `repeats` deterministic shuffles.
 * Each repeat: shuffle each row's own samples (seeded per row+repeat, so rows shuffle
 * independently — no cross-row coupling), split into two halves, apply the estimator to each
 * half independently, rank+band each half's own ordering, and compare band index per row. A
 * row whose half falls below the estimator's minSamples is excluded from that repeat only (its
 * agreement is computed over however many rows had two valid halves that repeat). */
function bandAgreement(eligible, estimator, k, repeats, seed) {
  let exactSum = 0, withinSum = 0, validRepeats = 0;
  for (let r = 0; r < repeats; r++) {
    const halfAVals = [], halfBVals = [], keys = [];
    for (const it of eligible) {
      const rng = mulberry32(fnv1a(`${seed}|${it.key}|${r}`));
      const shuffled = seededShuffle(it.samplesArr ?? [it.value], rng);
      const mid = Math.floor(shuffled.length / 2);
      const a = shuffled.slice(0, mid), b = shuffled.slice(mid);
      if (a.length < estimator.minSamples || b.length < estimator.minSamples) continue;
      halfAVals.push({ key: it.key, value: estimator(a) });
      halfBVals.push({ key: it.key, value: estimator(b) });
      keys.push(it.key);
    }
    if (keys.length < k) continue; // not enough rows with two valid halves to even form k bands
    const rankedA = [...halfAVals].sort((x, y) => y.value - x.value);
    const rankedB = [...halfBVals].sort((x, y) => y.value - x.value);
    const idxA = bandIndices(rankedA.length, k), idxB = bandIndices(rankedB.length, k);
    const bandOfA = new Map(rankedA.map((it, i) => [it.key, idxA[i]]));
    const bandOfB = new Map(rankedB.map((it, i) => [it.key, idxB[i]]));
    let exact = 0, within = 0;
    for (const kk of keys) {
      const ba = bandOfA.get(kk), bb = bandOfB.get(kk);
      if (ba === bb) exact += 1;
      if (Math.abs(ba - bb) <= 1) within += 1;
    }
    exactSum += exact / keys.length;
    withinSum += within / keys.length;
    validRepeats += 1;
  }
  if (validRepeats === 0) return { k, exactAgreement: 0, withinOne: 0, validRepeats: 0 };
  return { k, exactAgreement: exactSum / validRepeats, withinOne: withinSum / validRepeats, validRepeats };
}

// --- §CHOICES: where the specification left something open ------------------------------
//
// 1. ANALYTIC's estimator signature. The spec's §3 table says `samples: ANALYTIC` without
//    restating `estimator`'s shape for that path, and every worked example of `estimator` in
//    the spec (median, p95Minusp5, meanOf01) is `(samples: number[]) => number`. There is no
//    samples array in the analytic case, so something has to give. Chose: when `samples ===
//    ANALYTIC`, `estimator` is called as `estimator(row) => number` instead — a row-level
//    function, not a samples-level one. This keeps the "no way to hand it a number" principle
//    intact (you still hand it a *function*, just one with a different domain) and matches
//    caller #13 in the spec's own table (`samples: r => r.hsSRaw` would have been the natural
//    reading if `estimator` kept the samples-array shape, but that reintroduces exactly the
//    "hand it a pre-computed number" hole ANALYTIC exists to name explicitly rather than allow
//    silently). If this reading is wrong, the fix is a one-line signature change here plus a
//    3-line test change — nothing about the tagged-union return shape depends on it.
//
// 2. Stability for the `ranked` (non-demoted) case. The spec defines `stability.curve` fully
//    for banding/demotion (§6) but does not spell out what `{exactAgreement, withinOne, repeats,
//    seed}` means for a `ranked` result — only that the shape exists. Chose: reuse the exact
//    same split-half band-agreement measurement used for demotion, evaluated at k = n (i.e. "is
//    the requested cut itself stable as an n-way band split"), and report that single point.
//    This makes `ranked` the natural k>=n endpoint of the same curve `banded` reports in full,
//    rather than a second, differently-defined stability metric — one mechanism, not two.
