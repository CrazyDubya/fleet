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
// from a metric that cannot support an ordering. Two independent failure shapes, either one
// disqualifies the metric: too few distinct values to order 10+ rows meaningfully, or one value
// so dominant that "top N" is really "the first N insertion-order rows tied at the ceiling."
export const RANKING_MIN_DISTINCT = 5;
export const RANKING_MAX_TIE_BLOCK_FRACTION = 0.5;

/** `values`: the metric column being ranked on, one entry per row (cfg/geometry/assembly — the
 * unit doesn't matter, only that each row contributes exactly one value). Exact-equality ties
 * are what matter here (a fraction that lands on 0 or 1 exactly ties regardless of the
 * denominator that produced it), so no rounding/binning is applied — a caller ranking on a
 * genuinely continuous float column that happens to collide by float noise should round before
 * calling this, but every current caller's metric is either a count-ratio (exact 0/1 exactly
 * representable) or already-discrete. */
export function rankingValidityResult(values, { minDistinct = RANKING_MIN_DISTINCT, maxTieBlockFraction = RANKING_MAX_TIE_BLOCK_FRACTION } = {}) {
  const n = values.length;
  if (n === 0) return { ok: true, n: 0, distinctCount: 0, maxTieFraction: 0, reason: null };
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const distinctCount = counts.size;
  const maxTieFraction = Math.max(...counts.values()) / n;
  const reasons = [];
  if (distinctCount < minDistinct) {
    reasons.push(`only ${distinctCount} distinct value(s) across ${n} rows (floor ${minDistinct}) — cannot support an ordering`);
  }
  if (maxTieFraction > maxTieBlockFraction) {
    reasons.push(`${(maxTieFraction * 100).toFixed(1)}% of rows tied at one value (ceiling ${(maxTieBlockFraction * 100).toFixed(0)}%) — "top N" would be insertion order, not a ranking`);
  }
  return { ok: reasons.length === 0, n, distinctCount, maxTieFraction, reason: reasons.length ? reasons.join('; ') : null };
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
