import test from 'node:test';
import assert from 'node:assert/strict';
import { mean, sd, percentile, fanWidth, histogram, entropyBits, flaggedFraction, bitFraction, tally } from '../src/metrics.js';

test('mean/sd on a known fixture', () => {
  const xs = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.equal(mean(xs), 5);
  assert.ok(Math.abs(sd(xs) - 2.1380899353) < 1e-6, 'sample standard deviation of the classic fixture');
});

test('percentile: P50 of an odd-length sorted set is the middle value; unsorted input is handled', () => {
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
});

test('fanWidth is P95 - P5, wide for a spread distribution, ~0 for a constant one', () => {
  const spread = Array.from({ length: 100 }, (_, i) => i); // 0..99
  assert.ok(fanWidth(spread) > 80, 'a near-uniform 0..99 spread has a wide P95-P5');
  assert.equal(fanWidth(Array(50).fill(7)), 0);
});

test('histogram: counts sum to input length, out-of-range values clamp into edge bins', () => {
  const counts = histogram([-5, 0, 0.5, 1, 1, 1, 5], 2, 0, 1);
  assert.equal(counts.reduce((a, b) => a + b, 0), 7);
  assert.equal(counts[0], 2); // -5 clamps into bin 0 alongside the one value at 0
});

test('entropyBits: a single-bin (all-one-value) histogram has zero entropy; a uniform one is maximal', () => {
  assert.equal(entropyBits([10, 0, 0, 0]), 0);
  const uniform = [5, 5, 5, 5];
  assert.equal(entropyBits(uniform), 2); // log2(4)
  assert.equal(entropyBits(uniform, { normalise: true }), 1);
});

test('flaggedFraction and bitFraction read a validity-flag bitmask array correctly', () => {
  const IMPACTS_EXHAUSTED = 1, ESCAPED = 2;
  const flags = [0, IMPACTS_EXHAUSTED, 0, ESCAPED, IMPACTS_EXHAUSTED | ESCAPED];
  const overall = flaggedFraction(flags);
  assert.equal(overall.count, 3);
  assert.equal(overall.fraction, 0.6);
  assert.equal(bitFraction(flags, IMPACTS_EXHAUSTED), 0.4);
  assert.equal(bitFraction(flags, ESCAPED), 0.4);
});

test('tally counts discrete values (terminal states, phases)', () => {
  const t = tally(['drain', 'shotline', 'drain', 'drain']);
  assert.equal(t.get('drain'), 3);
  assert.equal(t.get('shotline'), 1);
});
