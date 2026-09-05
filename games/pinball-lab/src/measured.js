// A published quantity and the evidence for it, in one value. Specification:
// ledger/handoffs/opus2/20260905T174929Z-scalar-guard-spec.md ("The published scalar: why it
// is not a guard, and what it is instead"). Slice 1 only: `rate`, `analytic`, `indeterminate`,
// `unmeasured`, and the rendering wall (`fmt`) — see the spec's §7 for the later slices
// (`mean`/`median`/`quantile`/`quantileSpread`/`entropyOfHistogram`/`correlation`).
//
// The core argument (§1): a scalar is not a claim that can be false the way a top-N cut is, so
// it does not want a guard — it wants a unit of account. An interval is a refusal with a
// magnitude: it refuses at exactly the strength the data warrants, with nobody choosing a
// threshold. What's missing from a bare `45.574%` is not correctness, it's whether the reader
// can tell it apart from a rounding artefact.
//
// Deliberately absent, per §6/§8: `max`/`min`/`argmax`/`best`/`knee`. Those are top-1
// selections and belong to `selectTopN` — giving this module no such constructor is what keeps
// that mistake unspellable here.

const Z95 = 1.959963985; // two-sided 95% normal quantile, exact to 9 places

/** Wilson score interval for a binomial rate k/n, two-sided 95%. Exact closed form, not an
 * approximation (spec §5, tier 1 — zero resampling). */
function wilsonInterval(k, n) {
  const phat = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const adj = Z95 * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return [Math.max(0, (centre - adj) / denom), Math.min(1, (centre + adj) / denom)];
}

function requireEstimand(estimand, fnName) {
  if (typeof estimand !== 'string' || estimand.length === 0) {
    throw new Error(`Measured.${fnName}: estimand is required — a non-empty string naming the ` +
      'quantity being claimed (e.g. "fraction of trials reaching a catch"). The corpus\'s worst ' +
      'failures have been measurements that answered a different question than the one in the ' +
      'header; this cannot check that the string is right, but it can force it to be written down.');
  }
}

function fmtNum(x, digits) {
  if (!Number.isFinite(x)) return String(x);
  return x.toFixed(digits);
}

/** The tagged union. Instances are plain data (kind/value/n/k/ci/level/method/estimand/why) plus
 * toString()/toJSON() — the enforcement point (spec §4's "bypass has to cost more than
 * compliance"): `${m}` is 5 characters and prints the accompanied form; reaching for the bare
 * number underneath is longer. Constructed only via the module's own functions below, never
 * directly — there is no public constructor a caller could hand a raw `value` to. */
class Measured {
  constructor(fields) {
    Object.assign(this, fields);
  }

  toString() {
    if (this.kind === 'unmeasured') return `unmeasured (${this.why})`;
    if (this.kind === 'analytic') return `${fmtNum(this.value, 4)} (analytic — ${this.why})`;
    if (this.kind === 'indeterminate') {
      return `${fmtNum(this.value, 4)} (n=${this.n}, uncertainty not established — ${this.why})`;
    }
    // kind === 'measured'
    const pct = this.unit === 'fraction';
    const scale = pct ? 100 : 1;
    const suffix = pct ? '%' : '';
    const v = fmtNum(this.value * scale, pct ? 3 : 4);
    const lo = fmtNum(this.ci[0] * scale, pct ? 4 : 4);
    const hi = fmtNum(this.ci[1] * scale, pct ? 4 : 4);
    const countPart = this.k !== undefined
      ? `${this.k} event${this.k === 1 ? '' : 's'} / ${this.n.toLocaleString()}`
      : `n=${this.n.toLocaleString()}`;
    return `${v}${suffix} (${countPart}, ${(this.level * 100).toFixed(0)}% CI ${lo}${suffix}–${hi}${suffix})`;
  }

  toJSON() {
    // Every field the type carries, nothing else (no methods survive JSON.stringify anyway,
    // but this keeps the emitted shape stable and self-documenting rather than relying on
    // property enumeration order / whatever else Object.assign happened to leave on `this`).
    const { kind, value, n, k, ci, level, method, estimand, why, unit } = this;
    const out = { kind, estimand };
    if (value !== undefined) out.value = value;
    if (n !== undefined) out.n = n;
    if (k !== undefined) out.k = k;
    if (ci !== undefined) out.ci = ci;
    if (level !== undefined) out.level = level;
    if (method !== undefined) out.method = method;
    if (why !== undefined) out.why = why;
    if (unit !== undefined) out.unit = unit;
    return out;
  }
}

/** A rate k/n (a fraction of trials/events). `n === 0` (or `k === 0 && n === 0`) returns
 * `unmeasured` — no `value` field, per the cut spec's anti-V2 mechanism reused here: a writer
 * that reads `.value` off a zero-trial result gets `undefined` and fails at the point of use,
 * rather than silently printing "0.0%" for a quantity that was never observed.
 *
 * A THIN count (k < 5, say) is published, not refused — the lab's RANKING_MIN_EVENT_SUPPORT=5
 * rules that a rate that thin cannot ORDER a population; it has never ruled that it cannot be
 * PUBLISHED, and refusing would delete a real observation rather than pricing it. The Wilson
 * interval prices it: a wide interval on a one-event rate is not a defect, it is the honest
 * answer. */
export function rate(k, n, { estimand } = {}) {
  requireEstimand(estimand, 'rate');
  if (!Number.isInteger(n) || n < 0) throw new Error(`Measured.rate: n must be a non-negative integer, got ${JSON.stringify(n)}`);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new Error(`Measured.rate: k must be an integer in [0, n=${n}], got ${JSON.stringify(k)}`);
  if (n === 0) return new Measured({ kind: 'unmeasured', why: 'zero trials — no statistical power exists to have measured anything', estimand });
  const ci = wilsonInterval(k, n);
  return new Measured({ kind: 'measured', value: k / n, n, k, ci, level: 0.95, method: 'wilson', unit: 'fraction', estimand });
}

/** A computed (not estimated) quantity — no sampling error to report, and this is a positive
 * declaration of that, the same rule as the cut spec's `ANALYTIC` sentinel: omitting `estimand`
 * or calling nothing does not get you this path, it gets you a bare number and the wall. */
export function analytic(value, why, { estimand } = {}) {
  requireEstimand(estimand, 'analytic');
  if (typeof why !== 'string' || why.length === 0) throw new Error('Measured.analytic: why is required — a non-empty string saying why this value has no sampling error');
  if (!Number.isFinite(value)) throw new Error(`Measured.analytic: value must be a finite number, got ${JSON.stringify(value)}`);
  return new Measured({ kind: 'analytic', value, why, estimand });
}

/** Publishable, but uncertainty has not been established for it yet — the affordability valve
 * (spec §4.2): a builder who cannot afford an interval for some quantity today may publish this
 * instead of silently reaching past the wall, and the page says so. Absence still never reads
 * as fine — the reason is required and rendered. */
export function indeterminate(value, why, { n, estimand } = {}) {
  requireEstimand(estimand, 'indeterminate');
  if (typeof why !== 'string' || why.length === 0) throw new Error('Measured.indeterminate: why is required');
  if (!Number.isFinite(value)) throw new Error(`Measured.indeterminate: value must be a finite number, got ${JSON.stringify(value)}`);
  return new Measured({ kind: 'indeterminate', value, why, n, estimand });
}

/** Explicit unmeasured — no `value` field, ever (see `rate`'s own doc comment on why this
 * matters). Exposed directly for constructors slice 1 doesn't have yet (a future `mean([])`,
 * say) that need the same anti-V2 shape without going through `rate`. */
export function unmeasured(why, { estimand } = {}) {
  requireEstimand(estimand, 'unmeasured');
  if (typeof why !== 'string' || why.length === 0) throw new Error('Measured.unmeasured: why is required');
  return new Measured({ kind: 'unmeasured', why, estimand });
}

/** The wall (spec §4's enforcement point, §7 slice 4 — wired here in slice 1 so every writer
 * that adopts `Measured` gets it immediately rather than waiting for a later dispatch to catch
 * up). Renders a `Measured` value; throws on anything else, INCLUDING a bare number — the one
 * shape this whole design exists to make impossible to reach the page. */
export function fmt(m) {
  if (m instanceof Measured) return m.toString();
  throw new Error(
    `Measured.fmt: expected a Measured value (rate/analytic/indeterminate/unmeasured), got ` +
    `${typeof m === 'number' ? `a bare number (${m})` : typeof m === 'object' && m !== null ? 'a plain object' : typeof m} — ` +
    'there is no way to publish a number through this wall without the evidence for it attached.'
  );
}

export { Measured };
