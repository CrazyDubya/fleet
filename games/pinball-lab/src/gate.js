// §2.7's shared validity gate: "an experiment whose flagged fraction exceeds 1% is not
// summarised until the cause is understood." Before LAB-11 this existed for E3 only
// (stageA.js's runE3Stage); everywhere else the flagged fraction was computed and never
// compared to anything (LAB-11's P0-1, code review 20260902T130928Z). One pure implementation
// here, reused by every stage runner — the impure part (how each runner reports/exits on
// failure) stays with the caller, matching the style each runner already used for its other
// gates (§2.4a's sd-floor / arena-on-target checks).
export const FLAG_GATE_FRACTION = 0.01;

// LAB-22: the declared-premise exemption, implementing the ruling in opus2's
// `ledger/handoffs/opus2/20260904T150000Z-three-gate-rulings.md` (§(b) and §(c)).
//
// Two corpora exceed 1% for reasons that are understood and written down — e1-pilot-01's
// TIMEOUT tail (§3.3 samples inbound speed down to 0.3 m/s against a 2.0s cap) and E4 Stage
// A1's coarse first-stage sweep. §2.7 is a STOP-UNTIL-EXPLAINED rule, not a threshold on
// physics, so a corpus whose excess is explained should be able to say so — but as a recorded
// claim a reader can challenge, never as a loosened threshold.
//
// Three properties make this an exemption rather than an escape hatch:
//
//   1. A premise is A CEILING THAT STILL FAILS. Declaring 13% does not skip the gate, it moves
//      the gate to 13%. 13.1% is still a refusal. An exemption that cannot fail is not a gate.
//   2. A premise is NARROW. It must name the flags it covers, and every flag it does NOT name
//      is still held to FLAG_GATE_FRACTION. This is what keeps FLAG_GATE_FRACTION at 0.01 in
//      substance and not just in name: a corpus declaring a TIMEOUT tail does not thereby get
//      to hide a NAN. `expectedFlags` is required for exactly this reason — an unscoped
//      declaration would weaken the gate for everything in the declaring corpus.
//   3. A premise is ATTRIBUTABLE. `reason` and `declaredBy` are required, so the claim traces
//      back to the handoff that made it and can be argued with rather than merely obeyed.
export const PREMISE_MIN_REASON_CHARS = 40;
// LAB-26, found by an outside review (opencode) within a dispatch of the mechanism landing.
// A ceiling of 1.0 is not a ceiling: the check is `fraction > ceiling`, so 1.0 > 1.0 is false
// and a corpus with EVERY trial flagged passed. The design principle was "a premise is a
// ceiling that still fails"; at 1.0 it cannot. The bound is placed at the declaration rather
// than the comparison, because an unfailable ceiling is a malformed CLAIM, not a permissive
// one — and it is set at one half on a principle rather than to taste: a premise may not
// declare that the MAJORITY of a corpus is flagged. Past that, "expected" has stopped being an
// exemption and become a description of a broken corpus.
export const PREMISE_MAX_CEILING = 0.5;
const PREMISE_KEYS = new Set(['expectedFlagFraction', 'expectedFlags', 'reason', 'declaredBy']);
// Mirrors instrument.js's FLAGS. Duplicated rather than imported to keep gate.js free of the
// instrument's own imports (it is the one module every stage runner pulls in); the test
// `premise: the flag vocabulary matches instrument.js` holds the two in step.
export const PREMISE_FLAG_NAMES = ['IMPACTS_EXHAUSTED', 'ESCAPED', 'TIMEOUT', 'STALLED', 'NAN', 'CREEP'];

function badPremise(source, msg) {
  return new Error(`${source}: malformed \`premise\` — ${msg}. A declared-premise exemption is a claim a reader must be able to challenge; a premise that cannot be parsed is a wiring error, not a missing declaration.`);
}

/**
 * A cfg file is either the bare array every existing cfgs/*.json already is (no premise), or
 * `{ premise, cfgs }`. Returns `{ cfgs, premise }` with `premise: null` for the bare form.
 * Throws on a malformed premise rather than degrading to "no premise declared" — a typo'd
 * `expectedFlagFractoin` silently reading as "no ceiling" is the exact failure this mechanism
 * exists to prevent.
 */
export function parseCfgSet(parsed, { source = '<cfg>' } = {}) {
  if (Array.isArray(parsed)) return { cfgs: parsed, premise: null };
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${source}: expected a cfg array or an object with a \`cfgs\` key, got ${parsed === null ? 'null' : typeof parsed}`);
  }
  if (!Array.isArray(parsed.cfgs)) throw new Error(`${source}: the object form needs a \`cfgs\` array`);
  const raw = parsed.premise;
  if (raw === undefined || raw === null) return { cfgs: parsed.cfgs, premise: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badPremise(source, 'it must be an object');

  for (const key of Object.keys(raw)) {
    if (!PREMISE_KEYS.has(key)) {
      throw badPremise(source, `unknown key \`${key}\` (expected one of ${[...PREMISE_KEYS].join(', ')})`);
    }
  }
  const { expectedFlagFraction: frac, expectedFlags: flags, reason, declaredBy } = raw;

  if (typeof frac !== 'number' || !Number.isFinite(frac) || frac <= 0 || frac >= PREMISE_MAX_CEILING) {
    throw badPremise(source, `\`expectedFlagFraction\` must be a finite fraction in (0, ${PREMISE_MAX_CEILING}), got ${JSON.stringify(frac)} — a premise may not declare that half or more of a corpus is flagged, and a ceiling at or above 1.0 could never fail at all`);
  }
  if (!Array.isArray(flags) || flags.length === 0) {
    throw badPremise(source, '`expectedFlags` must be a non-empty array naming the flags this premise covers — an unscoped premise would weaken the gate for every other flag too');
  }
  for (const f of flags) {
    if (!PREMISE_FLAG_NAMES.includes(f)) {
      throw badPremise(source, `\`expectedFlags\` names ${JSON.stringify(f)}, which is not a flag (known: ${PREMISE_FLAG_NAMES.join(', ')})`);
    }
  }
  if (typeof reason !== 'string' || reason.trim().length < PREMISE_MIN_REASON_CHARS) {
    throw badPremise(source, `\`reason\` must be a written explanation of at least ${PREMISE_MIN_REASON_CHARS} characters, got ${typeof reason === 'string' ? `${reason.trim().length}` : typeof reason}`);
  }
  if (typeof declaredBy !== 'string' || declaredBy.trim().length === 0) {
    throw badPremise(source, '`declaredBy` must name the handoff or LAB item that made this claim, so it can be traced');
  }
  return { cfgs: parsed.cfgs, premise: { expectedFlagFraction: frac, expectedFlags: [...flags], reason, declaredBy } };
}

/** `{ trials, flagged }` -> `{ fraction, ok }`. `flagged` is whatever count the caller has
 * already decided is "over the line" — E4 passes its STALLED-excluded count (STALLED is E4's
 * actual measurement, per §7's amendment); every other experiment passes the plain
 * any-bit-set count, since nothing else has a documented reason to exclude a flag bit.
 *
 * LAB-22: pass a `premise` (from `parseCfgSet`) to apply a declared-premise exemption. The
 * premise's fraction becomes the ceiling, AND every flag the premise did not declare is
 * separately held to `gateFraction` — which requires `flagCounts`, a `{ FLAG_NAME: count }`
 * map over the same `trials`. Omitting `flagCounts` alongside a premise throws: "not checked"
 * must never read as "passed" (the same rule LAB-21 applied to ranking support). */
export function flagGateResult({ trials, flagged, gateFraction = FLAG_GATE_FRACTION, premise = null, flagCounts = null, excludedFlags = [] }) {
  // Found by a cross-family review (2026-09-05): `gateFraction: 1.0` (or anything >= 1) makes
  // `fraction <= gateFraction` true no matter what `fraction` is, silently disabling the gate
  // entirely with no warning. A caller passing a gate-disabling value is almost certainly a
  // mistake, not a decision — refuse it loudly. A caller who genuinely needs to relax the gate
  // for a specific, understood reason has the declared-premise path (`parseCfgSet`) for exactly
  // that, which already requires a stated, attributable reason and still cannot reach 1.0
  // itself (`PREMISE_MAX_CEILING`, 0.5).
  if (!(gateFraction > 0 && gateFraction < 1)) {
    throw new Error(`flagGateResult: gateFraction must be a fraction strictly between 0 and 1, got ${JSON.stringify(gateFraction)} — 1.0 or above admits every flag rate and silently disables the gate`);
  }
  // Found by the same review: `trials > 0 ? flagged / trials : 0` reads zero trials as
  // `fraction: 0`, which then clears any threshold — zero samples carry zero statistical power,
  // not a clean result. A zero-trial corpus is not a passing corpus, it is an unmeasured one.
  if (trials === 0) {
    return {
      fraction: 0, ok: false, premiseApplied: false, gateFraction, undeclaredOverGate: [], excludedFlags: [...excludedFlags],
      reason: 'zero trials — an empty corpus carries no statistical power and cannot pass a flag-rate gate; this is almost certainly an upstream wiring error, not a corpus to bless',
    };
  }
  const fraction = flagged / trials;
  for (const f of excludedFlags) {
    if (!PREMISE_FLAG_NAMES.includes(f)) throw new Error(`flagGateResult: excludedFlags names ${JSON.stringify(f)}, which is not a flag (known: ${PREMISE_FLAG_NAMES.join(', ')})`);
  }
  if (!premise) {
    return { fraction, ok: fraction <= gateFraction, premiseApplied: false, gateFraction, undeclaredOverGate: [], excludedFlags: [...excludedFlags], reason: null };
  }

  if (flagCounts === null || typeof flagCounts !== 'object') {
    throw new Error('flagGateResult: a `premise` was declared but no `flagCounts` were supplied, so the flags it does NOT cover could not be checked against FLAG_GATE_FRACTION. That is a wiring error — "not checked" must never read as "passed".');
  }
  const reasons = [];
  const ceiling = premise.expectedFlagFraction;
  if (fraction > ceiling) {
    reasons.push(
      `flagged fraction ${(fraction * 100).toFixed(2)}% exceeds the corpus's own declared premise of ` +
      `${(ceiling * 100).toFixed(2)}% (declared by ${premise.declaredBy}) — a declared premise moves the gate, it does not remove it`);
  }
  // Every flag outside the declaration is still on the 1% gate.
  const undeclaredOverGate = [];
  for (const [flag, count] of Object.entries(flagCounts)) {
    if (premise.expectedFlags.includes(flag)) continue;
    // A flag the CALLER has already removed from `flagged` is not re-gated here. E4 passes
    // its STALLED-excluded numerator per §7's amendment ("for a cradle experiment STALLED IS
    // the measurement"); re-applying the 1% gate to STALLED per-flag would reinstate by the
    // back door the exclusion the caller legitimately made. This is a STRUCTURAL exclusion
    // already ruled on and is per-experiment; `expectedFlags` is a per-corpus claim about an
    // expected excess. They are deliberately separate fields.
    if (excludedFlags.includes(flag)) continue;
    const f = trials > 0 ? count / trials : 0;
    if (f > gateFraction) undeclaredOverGate.push({ flag, fraction: f });
  }
  if (undeclaredOverGate.length > 0) {
    reasons.push(
      `${undeclaredOverGate.map((u) => `${u.flag} at ${(u.fraction * 100).toFixed(2)}%`).join(', ')} ` +
      `— over the ${(gateFraction * 100).toFixed(0)}% gate and NOT covered by the declared premise ` +
      `(which covers ${premise.expectedFlags.join(', ')})`);
  }
  // LAB-26, second hole from the same review. Holding each undeclared flag to 1% INDIVIDUALLY
  // multiplies the allowance by the number of flags: five undeclared flags at 0.99% each is
  // 4.95% of the corpus carrying an undeclared flag, five times what §2.7 permits, with every
  // one of them passing. A premise carves out the flags it NAMES; everything it does not name
  // must still satisfy the original gate as if no premise existed — together, not one at a
  // time. (The reviewer put the exposure at ~18%; that adds the declared flag back in and
  // double-counts. 4.95% is the real number, and it is still five times the gate.)
  let undeclaredCombined = 0;
  for (const [flag, count] of Object.entries(flagCounts)) {
    if (premise.expectedFlags.includes(flag) || excludedFlags.includes(flag)) continue;
    undeclaredCombined += count;
  }
  const undeclaredCombinedFraction = trials > 0 ? undeclaredCombined / trials : 0;
  if (undeclaredCombinedFraction > gateFraction) {
    reasons.push(
      `the flags this premise does NOT declare come to ${(undeclaredCombinedFraction * 100).toFixed(2)}% combined, ` +
      `over the ${(gateFraction * 100).toFixed(0)}% gate — a premise exempts the flags it names, and everything ` +
      `else together must still clear §2.7 as if no premise existed`);
  }
  return {
    fraction, ok: reasons.length === 0, premiseApplied: true, gateFraction: ceiling,
    undeclaredOverGate, excludedFlags: [...excludedFlags], undeclaredCombinedFraction,
    reason: reasons.length ? reasons.join('; ') : null,
  };
}

/** Markdown lines echoing a declared premise into a summary header, so the exemption travels
 * with the summary a reader actually opens rather than living only in the cfg file. Returns
 * `[]` when no premise was declared. */
export function premiseHeaderLines(premise, gate) {
  // LAB-26: returning [] here made "declared nothing" and "declared and passed" identical in
  // the rendered summary — the not-checked-must-not-read-as-passed rule, broken by the module
  // that enforces it everywhere else. Absence is now stated.
  if (!premise) {
    return [
      `- **§2.7**: no declared premise — this corpus is held to the plain ${(FLAG_GATE_FRACTION * 100).toFixed(0)}% gate, ` +
      `and measured ${(gate.fraction * 100).toFixed(2)}%.`,
      '',
    ];
  }
  const declared = (premise.expectedFlagFraction * 100).toFixed(2);
  const actual = (gate.fraction * 100).toFixed(2);
  const head = gate.ok
    ? `## Declared premise (§2.7 exemption) — measured ${actual}%, declared ceiling ${declared}%`
    : `## ⚠ Declared premise EXCEEDED (§2.7) — measured ${actual}%, declared ceiling ${declared}%`;
  return [
    head,
    '',
    `> This corpus declares an expected flagged fraction above §2.7's ${(FLAG_GATE_FRACTION * 100).toFixed(0)}% gate. ` +
    `The declaration covers **${premise.expectedFlags.join(', ')}** only — every other flag is still held to ` +
    `${(FLAG_GATE_FRACTION * 100).toFixed(0)}%. This is a recorded claim, not a waiver: challenge it here.`,
    '',
    `- **declared ceiling**: ${declared}%  ·  **measured**: ${actual}%  ·  **verdict**: ${gate.ok ? 'within the declaration' : 'EXCEEDS THE DECLARATION'}`,
    `- **covers flags**: ${premise.expectedFlags.join(', ')}`,
    ...(gate.excludedFlags?.length
      ? [`- **structurally excluded from the numerator** (a separate, per-experiment ruling, not part of this premise): ${gate.excludedFlags.join(', ')}`]
      : []),
    `- **declared by**: ${premise.declaredBy}`,
    `- **reason**: ${premise.reason}`,
    '',
  ];
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
// LAB-21: a rate needs enough raw events behind it before it can order anything. The floor and
// ceiling above catch a metric with no SPREAD; neither can catch one with spread but no SUPPORT —
// 3,888 rows, plenty of distinct values, every one of them estimated from a single event. E1's
// September `cradleProxy` was exactly that: its whole nonzero population was 16 rows at k=1 and
// one at k=2. `0.010101` on its own cannot be told from 10/990, so the denominator has to come
// from the caller.
//
// 5 is the conventional Poisson floor: relative standard error 1/sqrt(k), so k=5 is ~45% and k=1
// is 100% — at k=1 the "rate" carries no information about which row is larger.
export const RANKING_MIN_EVENT_SUPPORT = 5;

/**
 * `support` is an OPTIONAL per-row denominator array, same length and order as `values`, holding
 * whatever each rate was divided by (trials for cradleProxy/cp, reachedCount for E3's
 * inBandFraction). Chosen over the two alternatives considered:
 *   - a scalar `trials`: cannot express heterogeneous denominators, and cradleProxy's real
 *     population mixes 99 and 108, so a scalar would have mis-stated k on most rows;
 *   - numerator/denominator arrays replacing `values`: forces every call site to restructure,
 *     including the ones that have no k at all.
 * A parallel array is additive — sites that cannot supply one simply omit it and get exactly
 * today's behaviour, with `minSelectedSupport: null` recording that no support verdict was made.
 * That distinction matters: "not checked" must never read as "passed".
 */
export function rankingValidityResult(values, { topN = null, support = null, minDistinct = RANKING_MIN_DISTINCT, maxTieBlockFraction = RANKING_MAX_TIE_BLOCK_FRACTION, maxBoundaryAmbiguity = RANKING_MAX_BOUNDARY_AMBIGUITY, minEventSupport = RANKING_MIN_EVENT_SUPPORT } = {}) {
  // Found by a cross-family review (2026-09-05): distinctCount is always >= 1 for any
  // non-empty ranking, so `distinctCount < minDistinct` can never fire when minDistinct <= 1 —
  // a minDistinct of 0 or 1 silently admits a single-value "ranking" that cannot order
  // anything. A caller passing a gate-disabling value here is almost certainly a mistake, not
  // a decision; refuse it loudly rather than honour it, the same treatment as gateFraction
  // below. A caller who genuinely needs a weaker distinctness floor than the default still
  // needs SOME floor >= 2 (the minimum that can distinguish two rows at all) — there is no
  // legitimate reason to pass 0 or 1, so this throws rather than clamps. Checked before `n`,
  // since this is validating the CALL, not the data.
  if (!(minDistinct >= 2)) {
    throw new Error(`rankingValidityResult: minDistinct must be >= 2 (a floor of ${minDistinct} can never fail — distinctCount is always >= 1 for a non-empty ranking, so this would silently admit a single-value ranking as valid)`);
  }
  const n = values.length;
  if (support != null && support.length !== n) {
    throw new Error(`rankingValidityResult: support has ${support.length} entries for ${n} values — a wiring error, not a metric problem`);
  }
  // Found by the same review, and not a hypothetical: a planner thread joined a table wrong
  // this morning, got an empty population, and this line handed it a PASS on the most
  // important guarded axis in E1. An empty ranking cannot order anything and carries no
  // information — it must not read as "verified fine", the same "not checked must never read
  // as passed" standard this file states explicitly everywhere else in it.
  if (n === 0) {
    return {
      ok: false, n: 0, distinctCount: 0, maxTieFraction: 0, boundaryAmbiguity: null, minSelectedSupport: null,
      reason: 'empty ranking (0 rows) — there is no valid ruling on zero rows; this is almost certainly an upstream wiring error (an empty join, an empty filter), not a corpus to bless',
    };
  }
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const distinctCount = counts.size;
  const maxTieFraction = Math.max(...counts.values()) / n;

  // LAB-20: the population checks below apply on EVERY path. They used to live only in the
  // fall-through, so passing a `topN` silently disabled them and left boundary ambiguity as the
  // sole test — which is how E1's September `cradleProxy` shipped a "top 12" off 4 distinct
  // values in 3,888 rows (the identical array failed without `topN` and passed with it), and how
  // the LAB-20 cradle-metric pilot's contact-dwell-time did the same at 2 distinct values in 24
  // rows. The boundary test answers "is the CUT arbitrary"; these answer "can this metric order
  // anything at all". A top-N needs both, and they are not substitutes for one another.
  const reasons = [];
  if (distinctCount < minDistinct) {
    reasons.push(`only ${distinctCount} distinct value(s) across ${n} rows (floor ${minDistinct}) — cannot support an ordering`);
  }
  if (maxTieFraction > maxTieBlockFraction) {
    reasons.push(`${(maxTieFraction * 100).toFixed(1)}% of rows tied at one value (ceiling ${(maxTieBlockFraction * 100).toFixed(0)}%) — presenting this as an order would be misleading`);
  }

  if (topN != null && topN < n) {
    // Found by the same review: `topN <= 0` reaches the `Math.min(...selected.map(...))` below
    // with `selected` empty (`.slice(0, 0)`), and `Math.min()` with no arguments returns
    // `Infinity` — a support floor that `Infinity` satisfies is not a floor, so a `topN` of 0
    // (or negative) silently passed the event-support check regardless of the real data. A
    // top-N selection of zero or fewer rows is not a meaningful call to begin with; reject it
    // at the source rather than let it fall through to a vacuously-passing spread.
    if (topN < 1) throw new Error(`rankingValidityResult: topN must be >= 1, got ${topN}`);
    const sorted = [...values].sort((a, b) => b - a);
    const cutValue = sorted[topN - 1];
    const higherCount = sorted.filter((v) => v > cutValue).length;
    const tieBlockSize = counts.get(cutValue);
    const slotsRemaining = topN - higherCount;
    const boundaryAmbiguity = tieBlockSize / slotsRemaining;
    if (boundaryAmbiguity > maxBoundaryAmbiguity) {
      reasons.push(
        `top-${topN} cut lands inside a ${tieBlockSize}-way tie for ${slotsRemaining} remaining slot(s) ` +
        `(${boundaryAmbiguity.toFixed(2)}x, ceiling ${maxBoundaryAmbiguity}x) — most of the selection would be insertion order, not a ranking`);
    }

    // LAB-21: raw-event support, checked only over the rows a top-N would actually SELECT — the
    // population's weakly-supported tail is not the caller's problem if it never gets picked.
    let minSelectedSupport = null;
    if (support != null) {
      const selected = values
        .map((v, i) => ({ v, k: Math.round(v * support[i]) }))
        .sort((a, b) => b.v - a.v)
        .slice(0, topN);
      minSelectedSupport = Math.min(...selected.map((r) => r.k));
      if (minSelectedSupport < minEventSupport) {
        reasons.push(
          `the top-${topN} selection rests on as few as ${minSelectedSupport} raw event(s) per row ` +
          `(floor ${minEventSupport}) — at that count the rate carries no information about which row ranks higher`);
      }
    }
    return {
      ok: reasons.length === 0, n, distinctCount, maxTieFraction, boundaryAmbiguity, minSelectedSupport,
      reason: reasons.length ? reasons.join('; ') : null,
    };
  }

  return { ok: reasons.length === 0, n, distinctCount, maxTieFraction, boundaryAmbiguity: null, minSelectedSupport: null, reason: reasons.length ? reasons.join('; ') : null };
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
