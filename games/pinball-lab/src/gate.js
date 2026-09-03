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
