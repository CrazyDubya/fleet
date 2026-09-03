// §2.7's shared validity gate: "an experiment whose flagged fraction exceeds 1% is not
// summarised until the cause is understood." Before LAB-11 this existed for E3 only
// (stageA.js's runE3Stage); everywhere else the flagged fraction was computed and never
// compared to anything (LAB-11's P0-1, code review 20260902T130928Z). One pure implementation
// here, reused by every stage runner — the impure part (how each runner reports/exits on
// failure) stays with the caller, matching the style each runner already used for its other
// gates (§2.4a's sd-floor / arena-on-target checks).
export const FLAG_GATE_FRACTION = 0.01;

/** `{ trials, flagged }` -> `{ fraction, ok }`. `flagged` is whatever count the caller has
 * already decided is "over the line" — E4 passes its STALLED-excluded count (STALLED is E4's
 * actual measurement, per §7's amendment); every other experiment passes the plain
 * any-bit-set count, since nothing else has a documented reason to exclude a flag bit. */
export function flagGateResult({ trials, flagged, gateFraction = FLAG_GATE_FRACTION }) {
  const fraction = trials > 0 ? flagged / trials : 0;
  return { fraction, ok: fraction <= gateFraction };
}

// LAB-16: E3 P1's `inBandFraction` was a pure step function of `plungerSpeed` (0.0 for one
// grid value, 1.0 for the other five) — LAB-14's fouled block held all 10 "top 10" slots, and
// after the LAB-15 fix a different laneWidth value held all 10, because with 240/288 rows tied
// exactly at 1.0 a "top 10" is array/insertion order, not a ranking (operator handoff
// `20260903T0540Z-e3-p1-is-degenerate.md`). This guard makes that class of mistake loud instead
// of silent: a ranking table (or a "best"/"selected" pick derived from one) must not be built
// from a metric that cannot support an ordering.
//
// LAB-17 (correcting LAB-16's own second retraction, which was itself a false positive of the
// LAB-16 guard): a population-wide tie test asks the wrong question. What a top-N selection
// actually needs is for the CUT to be unambiguous — a 99.6%-tied metric can still produce a
// perfectly sound top-12 if all the mass ties at the BOTTOM, below the cut (E1's cradleProxy:
// 3871/3888 tied at 0, the top 12 are the only 16 nonzero rows). The population-wide
// `minDistinct`/`maxTieBlockFraction` test flags that case anyway, because it never looks at
// where the tie block sits relative to N. So the real test is the boundary-ambiguity ratio,
// checked only where a top-N cut actually exists: at the value the cut falls on, how many rows
// are tied there (`tieBlockSize`), against how many slots are still unfilled when the cut
// reaches that block (`slotsRemaining`, after slots already claimed by strictly-higher rows)?
//   ambiguityRatio = tieBlockSize / slotsRemaining
// ratio 1.0 means the tie block exactly fits the remaining slots — every tied row is selected,
// no insertion-order pick required, not ambiguous at all. Ratio > 1.0 means the block has more
// candidates than slots, so some subset is chosen by array order — ambiguous, and worse as the
// ratio grows. E1 cradleProxy top-12: block=12 tied at 0.010101, 11 slots left after the one
// row above it → 1.09x, one arbitrary drop out of 12 — benign. E3 P1's old top-10: block=240
// tied at the ceiling value 1.0, all 10 slots still open → 24x, essentially the entire
// selection is arbitrary — fatal. Threshold picked at 2x: below it, at most half the slots in
// the tie block are an arbitrary pick; at or above it, the tie block has at least twice the
// candidates the remaining slots can hold and the selection is mostly noise.
export const RANKING_MIN_DISTINCT = 5;
export const RANKING_MAX_TIE_BLOCK_FRACTION = 0.5;
export const RANKING_MAX_BOUNDARY_AMBIGUITY = 2;

/** `values`: the metric column being ranked on, one entry per row (cfg/geometry/assembly — the
 * unit doesn't matter, only that each row contributes exactly one value). Exact-equality ties
 * are what matter here (a fraction that lands on 0 or 1 exactly ties regardless of the
 * denominator that produced it), so no rounding/binning is applied — a caller ranking on a
 * genuinely continuous float column that happens to collide by float noise should round before
 * calling this, but every current caller's metric is either a count-ratio (exact 0/1 exactly
 * representable) or already-discrete.
 *
 * `topN`: the size of the actual top-N cut this ranking feeds (a "best" pick is `topN: 1`).
 * When given (and less than the population size), the guard checks boundary ambiguity at that
 * cut — the only question that matters for a selection. When omitted (the metric is reported
 * or displayed in full, with no cut — e.g. a small reference table nobody truncates), there is
 * no boundary to check, so the guard falls back to the population-wide distinct-value/tie-block
 * test, which is the right question for "is displaying this as an order misleading" rather than
 * "is this cut arbitrary." */
export function rankingValidityResult(values, { topN = null, minDistinct = RANKING_MIN_DISTINCT, maxTieBlockFraction = RANKING_MAX_TIE_BLOCK_FRACTION, maxBoundaryAmbiguity = RANKING_MAX_BOUNDARY_AMBIGUITY } = {}) {
  const n = values.length;
  if (n === 0) return { ok: true, n: 0, distinctCount: 0, maxTieFraction: 0, boundaryAmbiguity: null, reason: null };
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const distinctCount = counts.size;
  const maxTieFraction = Math.max(...counts.values()) / n;

  if (topN != null && topN < n) {
    const sorted = [...values].sort((a, b) => b - a);
    const cutValue = sorted[topN - 1];
    const higherCount = sorted.filter((v) => v > cutValue).length;
    const tieBlockSize = counts.get(cutValue);
    const slotsRemaining = topN - higherCount;
    const boundaryAmbiguity = tieBlockSize / slotsRemaining;
    const ok = boundaryAmbiguity <= maxBoundaryAmbiguity;
    const reason = ok ? null :
      `top-${topN} cut lands inside a ${tieBlockSize}-way tie for ${slotsRemaining} remaining slot(s) ` +
      `(${boundaryAmbiguity.toFixed(2)}x, ceiling ${maxBoundaryAmbiguity}x) — most of the selection would be insertion order, not a ranking`;
    return { ok, n, distinctCount, maxTieFraction, boundaryAmbiguity, reason };
  }

  const reasons = [];
  if (distinctCount < minDistinct) {
    reasons.push(`only ${distinctCount} distinct value(s) across ${n} rows (floor ${minDistinct}) — cannot support an ordering`);
  }
  if (maxTieFraction > maxTieBlockFraction) {
    reasons.push(`${(maxTieFraction * 100).toFixed(1)}% of rows tied at one value (ceiling ${(maxTieBlockFraction * 100).toFixed(0)}%) — presenting this as an order would be misleading`);
  }
  return { ok: reasons.length === 0, n, distinctCount, maxTieFraction, boundaryAmbiguity: null, reason: reasons.length ? reasons.join('; ') : null };
}

export const STALLED_BIT = 8;

/** Is a trial's flag word `f` valid once STALLED is treated as E4's measurement rather than
 * an artifact (§7's amendment)? Mirrors `stageAWorker.js`'s `flaggedExclStalled` accounting
 * (`record.f !== 0 && !(record.f & 8)` counts as flagged) exactly: a trial is invalid only if
 * some OTHER bit is set — STALLED alone, or STALLED alongside nothing else being checked here,
 * does not disqualify it. Used by e4Report.js/e5aReport.js (P1-1) the same way P0-2 used plain
 * `r.f === 0` in lab2Report.js, which has no STALLED exception. */
export function validExclStalled(f) {
  return f === 0 || (f & STALLED_BIT) !== 0;
}
