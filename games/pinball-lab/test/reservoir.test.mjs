// SAMPLECAP-1. `familySamples` used to keep the FIRST `FAMILY_SAMPLE_CAP` reached trials each
// worker saw, which is a prefix of that worker's contiguous cfg slice, not a sample of the
// family. Measured on `e3-lab4-20260902T031944Z`: the capped sample covered 6.1-15.0% of each
// family's reached trials and put P3's published `timeToReturnMedianS` at 1.0375 s against the
// family's actual 0.7458 s (1.39x). Invisible to a null test — both metrics clear their nulls
// decisively, because the families really do differ; it is the VALUES that were wrong.
//
// The repair is uniform reservoir sampling under the same memory bound, plus a merge that
// preserves uniformity across workers (a plain concatenation of per-worker reservoirs
// over-weights whichever worker saw the fewest trials).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReservoir, mergeReservoirs, seedFromString } from '../src/reservoir.js';

test('under capacity: keeps everything, in order — small runs behave exactly as before', () => {
  const r = makeReservoir(10, 1);
  for (let i = 0; i < 7; i++) r.offer(i);
  assert.deepEqual(r.items, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(r.seen, 7);
});

test('at capacity exactly: keeps everything, in order', () => {
  const r = makeReservoir(5, 1);
  for (let i = 0; i < 5; i++) r.offer(i);
  assert.deepEqual(r.items, [0, 1, 2, 3, 4]);
});

test('over capacity: the sample is uniform over the WHOLE stream, not its prefix', () => {
  // The exact failure being repaired: first half 0s, second half 1s. Taking the prefix gives
  // mean 0. A uniform sample gives ~0.5.
  const N = 100000, CAP = 1000;
  const r = makeReservoir(CAP, 12345);
  for (let i = 0; i < N; i++) r.offer(i < N / 2 ? 0 : 1);
  assert.equal(r.items.length, CAP);
  assert.equal(r.seen, N);
  const mean = r.items.reduce((a, b) => a + b, 0) / CAP;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean=${mean} — expected ~0.5, prefix-taking would give 0`);
});

test('over capacity: every position in the stream is equally likely to survive', () => {
  // Stronger than the mean check: bin the retained ORIGINAL INDICES into deciles and require
  // each decile to be represented near its expected share.
  const N = 50000, CAP = 2000;
  const r = makeReservoir(CAP, 999);
  for (let i = 0; i < N; i++) r.offer(i);
  const deciles = new Array(10).fill(0);
  for (const v of r.items) deciles[Math.min(9, Math.floor((v / N) * 10))] += 1;
  for (let d = 0; d < 10; d++) {
    assert.ok(Math.abs(deciles[d] - CAP / 10) < 60, `decile ${d} held ${deciles[d]}, expected ~${CAP / 10}`);
  }
});

test('deterministic: the same seed and stream give the same sample', () => {
  const build = () => { const r = makeReservoir(50, 7); for (let i = 0; i < 5000; i++) r.offer(i); return r.items; };
  assert.deepEqual(build(), build());
});

test('different seeds give different samples (the seed is actually used)', () => {
  const build = (s) => { const r = makeReservoir(50, s); for (let i = 0; i < 5000; i++) r.offer(i); return r.items; };
  assert.notDeepEqual(build(1), build(2));
});

test('paired values stay paired — xx and tt must come from the same trial', () => {
  // e3Worker samples return-x and time-to-return together. If they were sampled independently
  // the pairing would be destroyed, and any later joint analysis would be silently wrong.
  const N = 20000, CAP = 500;
  const r = makeReservoir(CAP, 4242);
  for (let i = 0; i < N; i++) r.offer({ xx: i, tt: i * 2 });
  assert.equal(r.items.length, CAP);
  for (const it of r.items) assert.equal(it.tt, it.xx * 2, 'pairing broken');
});

test('merge: a concatenation of per-worker reservoirs over-weights the smallest worker', () => {
  // This is why merging needs its own step. Worker A saw 90,000 trials of value 0; worker B saw
  // 10,000 of value 1. The true pooled mean is 0.1. Concatenating two equal-size reservoirs
  // gives 0.5 — five times wrong, and in a way no null test can see.
  const A = makeReservoir(1000, 11); for (let i = 0; i < 90000; i++) A.offer(0);
  const B = makeReservoir(1000, 22); for (let i = 0; i < 10000; i++) B.offer(1);
  const concatMean = [...A.items, ...B.items].reduce((a, b) => a + b, 0) / 2000;
  assert.ok(Math.abs(concatMean - 0.5) < 0.01, `concat mean=${concatMean}`);

  const merged = mergeReservoirs([A, B], 1000, 33);
  assert.equal(merged.items.length, 1000);
  assert.equal(merged.seen, 100000);
  const mergedMean = merged.items.reduce((a, b) => a + b, 0) / merged.items.length;
  assert.ok(Math.abs(mergedMean - 0.1) < 0.03, `merged mean=${mergedMean} — expected ~0.1`);
});

test('merge: when the total is under capacity nothing is dropped', () => {
  const A = makeReservoir(100, 1); for (let i = 0; i < 30; i++) A.offer(i);
  const B = makeReservoir(100, 2); for (let i = 100; i < 140; i++) B.offer(i);
  const merged = mergeReservoirs([A, B], 100, 3);
  assert.equal(merged.items.length, 70);
  assert.equal(merged.seen, 70);
  assert.deepEqual([...merged.items].sort((a, b) => a - b), [...Array(30).keys()].concat([...Array(40).keys()].map((k) => k + 100)));
});

test('merge: deterministic, and an empty input contributes nothing', () => {
  const mk = () => { const A = makeReservoir(50, 1); for (let i = 0; i < 5000; i++) A.offer(i);
    const B = makeReservoir(50, 2); for (let i = 5000; i < 9000; i++) B.offer(i);
    const C = makeReservoir(50, 3); // never offered anything
    return mergeReservoirs([A, B, C], 50, 9); };
  assert.deepEqual(mk().items, mk().items);
  assert.equal(mk().seen, 9000);
});

test('seedFromString: stable, and distinct for the inputs the worker actually uses', () => {
  assert.equal(seedFromString('shard-0.jsonl.gz:P1'), seedFromString('shard-0.jsonl.gz:P1'));
  const seeds = new Set();
  for (const shard of ['shard-0.jsonl.gz', 'shard-1.jsonl.gz', 'shard-2.jsonl.gz'])
    for (const fam of ['P1', 'P2', 'P3', 'P4', 'P5']) seeds.add(seedFromString(`${shard}:${fam}`));
  assert.equal(seeds.size, 15, 'every (shard, family) pair must get its own seed');
});
