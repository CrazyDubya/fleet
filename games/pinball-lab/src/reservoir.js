// Uniform reservoir sampling under a fixed memory bound (SAMPLECAP-1).
//
// Why this exists rather than a `length < CAP` push: keeping the first CAP items keeps a
// PREFIX, and a prefix of a worker's contiguous cfg slice is not a sample of the family. On
// `e3-lab4-20260902T031944Z` that put P3's published `timeToReturnMedianS` at 1.0375 s against
// the family's actual 0.7458 s. The memory bound was never the problem — 6,000 samples is
// ample for a median or a 32-bin entropy, and a RANDOM 6,000 reproduces the all-trials value
// to three or four decimals. Which 6,000 was the problem.
//
// Algorithm R (Vitter). Item i (0-based) beyond the capacity replaces a uniformly chosen slot
// with probability CAP/(i+1), which leaves every item seen so far equally likely to be held.
import { seededRng } from './seed.js';

/** Memory bound for E3's pooled per-family samples, held here rather than in e3Worker.js so
 * that stageA.js's merge and the worker's per-shard reservoirs cannot drift apart. It bounds
 * MEMORY, not resolution: a random 6,000 reproduces E3's all-trials entropy and median to
 * three or four decimals. */
export const E3_FAMILY_SAMPLE_CAP = 6000;

/** A reservoir over one stream. `offer` any value — objects are held by reference, so callers
 * sampling several fields per trial should offer ONE object per trial rather than maintaining
 * parallel reservoirs, which would destroy the pairing. */
export function makeReservoir(capacity, seedU32) {
  if (!(Number.isInteger(capacity) && capacity > 0)) {
    throw new Error(`makeReservoir: capacity must be a positive integer, got ${JSON.stringify(capacity)}`);
  }
  const items = [];
  let seen = 0;
  // Lazily created: a reservoir that never fills never draws, so a run whose families all sit
  // under the cap consumes no randomness and behaves exactly as the old prefix code did.
  let next = null;
  return {
    offer(item) {
      if (items.length < capacity) {
        items.push(item);
      } else {
        if (next === null) next = seededRng(seedU32);
        const j = Math.floor(next() * (seen + 1));
        if (j < capacity) items[j] = item;
      }
      seen += 1;
    },
    get items() { return items; },
    get seen() { return seen; },
  };
}

/** Merge per-worker reservoirs into one uniform sample of their union.
 *
 * A plain concatenation is wrong: each worker contributes min(CAP, its own count) items
 * regardless of how many trials it actually saw, so the worker that saw fewest is
 * over-represented. E3's P5 spans five shards holding 32,064 / 42,062 / 41,958 / 41,958 /
 * 41,958 reached trials; concatenating equal slices over-weights the first by ~31%.
 *
 * Each input is already a uniform sample of its own stream, so drawing each output slot from
 * input `i` with probability seen_i / sum(seen) yields a uniform sample of the union. */
export function mergeReservoirs(reservoirs, capacity, seedU32) {
  if (!(Number.isInteger(capacity) && capacity > 0)) {
    throw new Error(`mergeReservoirs: capacity must be a positive integer, got ${JSON.stringify(capacity)}`);
  }
  const live = reservoirs.filter((r) => r.items.length > 0);
  const seen = reservoirs.reduce((a, r) => a + r.seen, 0);
  const held = live.reduce((a, r) => a + r.items.length, 0);
  // Nothing was dropped anywhere and the union fits: keep every item, no randomness consumed.
  if (held === seen && held <= capacity) {
    return { items: live.flatMap((r) => [...r.items]), seen };
  }
  const next = seededRng(seedU32);
  const pools = live.map((r) => ({ items: [...r.items], weight: r.seen }));
  const out = [];
  const target = Math.min(capacity, held);
  while (out.length < target) {
    let total = 0;
    for (const p of pools) if (p.items.length > 0) total += p.weight;
    if (total <= 0) break;
    let u = next() * total;
    let chosen = null;
    for (const p of pools) {
      if (p.items.length === 0) continue;
      u -= p.weight;
      if (u <= 0) { chosen = p; break; }
    }
    if (chosen === null) chosen = pools.filter((p) => p.items.length > 0).pop();
    // Draw without replacement from the chosen pool so no item is emitted twice.
    const k = Math.floor(next() * chosen.items.length);
    out.push(chosen.items[k]);
    chosen.items[k] = chosen.items[chosen.items.length - 1];
    chosen.items.pop();
  }
  return { items: out, seen };
}

/** A stable uint32 seed from a string (FNV-1a). Lets a worker derive a reproducible seed from
 * its own shard path and family name, so a re-run of the same configuration draws the same
 * sample and nobody has to thread a seed argument through the worker protocol. */
export function seedFromString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
