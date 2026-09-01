// Pure statistics helpers over arrays of numbers/records. No I/O, no randomness, no wall
// clock — importable from a worker, the aggregator, or a test with nothing else running.
// This is the foundation LAB-2/E2/E3 build their fan-width, entropy and divergence metrics
// on (program handoff §3.6/§4.4/§5.4); LAB-1 only needs mean/sd/percentile/histogram for the
// pilot's per-column summary tables, but the rest is included now since it's the same shape
// of function and this file is explicitly "sweep machinery", not just a pilot helper.

export function mean(xs) {
  if (xs.length === 0) return NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Sample sd from a streaming {n, sum, sumSq} accumulator (worker.js's §2.4a ensemble check)
 * — avoids keeping every raw value in memory just to call sd() on them. */
export function sdFromAcc({ n, sum, sumSq }) {
  if (n < 2) return 0;
  const mean = sum / n;
  const variance = (sumSq - n * mean * mean) / (n - 1);
  return Math.sqrt(Math.max(0, variance));
}

/** sd of a Uniform(lo, hi) distribution — the reference an inbound sampling quantity's
 * measured sd is checked against (§2.4a's "floor"). */
export function uniformSd(lo, hi) {
  return (hi - lo) / Math.sqrt(12);
}

export function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let sq = 0;
  for (const x of xs) sq += (x - m) * (x - m);
  return Math.sqrt(sq / (xs.length - 1));
}

/** Linear-interpolated percentile, p in [0,100]. `xs` need not be pre-sorted. */
export function percentile(xs, p) {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/** P95 - P5: "wide = many shots available" (design doc §3.6.2). */
export function fanWidth(xs) {
  if (xs.length === 0) return NaN;
  return percentile(xs, 95) - percentile(xs, 5);
}

/** Fixed-width histogram over [lo, hi] with `bins` buckets; values outside are clamped into
 * the edge bucket rather than dropped, so counts always sum to xs.length. */
export function histogram(xs, bins, lo, hi) {
  const counts = new Array(bins).fill(0);
  const width = (hi - lo) / bins;
  for (const x of xs) {
    let idx = width > 0 ? Math.floor((x - lo) / width) : 0;
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    counts[idx] += 1;
  }
  return counts;
}

/** Shannon entropy (bits) of a set of bin counts. `normalise: true` divides by log2(n) so a
 * uniform distribution over n bins reads as 1.0 (design doc §4.4's exit-entropy convention). */
export function entropyBits(counts, { normalise = false } = {}) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  if (normalise) {
    const n = counts.length;
    return n > 1 ? h / Math.log2(n) : 0;
  }
  return h;
}

/** Count of `f` values (a validity-flag bitmask array) with any bit set, and the fraction of
 * the total — §2.7's "flagged fraction" every summary must report. */
export function flaggedFraction(flags) {
  if (flags.length === 0) return { count: 0, fraction: 0 };
  const count = flags.reduce((a, f) => a + (f !== 0 ? 1 : 0), 0);
  return { count, fraction: count / flags.length };
}

/** Tally of a specific bit across an array of bitmasks — e.g. IMPACTS_EXHAUSTED alone,
 * reported prominently per §2.7/§4.5 rather than folded into the general flagged fraction. */
export function bitFraction(flags, bit) {
  if (flags.length === 0) return 0;
  let count = 0;
  for (const f of flags) if ((f & bit) !== 0) count += 1;
  return count / flags.length;
}

/** §4.4's divergence chaos measure, part 1: median of `|delta|` over a set of paired-trial
 * deltas (e.g. exit-x under a 1e-6 rad inbound perturbation). */
export function medianAbsDelta(deltas) {
  if (deltas.length === 0) return null;
  return percentile(deltas.map(Math.abs), 50);
}

/** §4.4's divergence chaos measure, part 2: fraction of `|delta|` values exceeding a
 * threshold (5cm per the program handoff). */
export function fractionExceeding(deltas, threshold) {
  if (deltas.length === 0) return 0;
  return deltas.filter((d) => Math.abs(d) > threshold).length / deltas.length;
}

/** Frequency table over discrete string values (terminal states, phases, policy names). */
export function tally(xs) {
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return counts;
}
