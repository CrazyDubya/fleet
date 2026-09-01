// §2.4a: the actual LAB-1 pilot bug — physics/rng.js's makeRng(seed) only seeds x, leaving
// y/z/w fixed, so nearby seeds' first few outputs barely differ. seed.js's job is to make
// that impossible by construction: splitmix32 fills all four words, then a warm-up is
// discarded. These tests assert the FAILURE MODE is actually gone, not just that seed.js
// runs — a determinism test alone (same seed -> same output) would have passed on the old
// buggy code too, which is exactly why it didn't catch this the first time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { seededRng, WARMUP_DRAWS } from '../src/seed.js';

test('WARMUP_DRAWS meets the §2.4a floor of >= 20', () => {
  assert.ok(WARMUP_DRAWS >= 20);
});

test('same seed -> identical stream (determinism)', () => {
  const a = seededRng(12345);
  const b = seededRng(12345);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test('the actual bug: adjacent small seeds (1, 2, 3) must NOT agree to seven significant figures on the first draw', () => {
  // This is the literal reproduction from the packet: cfgHash ^ seed for seeds 1/2/3, first
  // draw of each. The old makeRng(seed) gave x=0.012279195/0.012279396/0.012279576 here —
  // agreeing to SEVEN significant figures (differing only ~2e-7 apart). seededRng must not
  // reproduce that. Note this asserts against genuine degeneracy (agreement to ~1e-4 or
  // tighter), not that independent uniform draws can never land near each other by chance —
  // two draws within, say, 0.03 of each other is unremarkable for 3 draws of Uniform[0,1).
  const cfgHash = 0x6c7d9477; // one of the pilot cfgIds, arbitrary choice
  const draws = [1, 2, 3].map((seed) => seededRng((cfgHash ^ seed) >>> 0)());
  for (let i = 0; i < draws.length; i++) {
    for (let j = i + 1; j < draws.length; j++) {
      assert.ok(Math.abs(draws[i] - draws[j]) > 1e-4, `seed ${i + 1} and ${j + 1} drew ${draws[i]} and ${draws[j]} — agree far too closely, seeding is still degenerate`);
    }
  }
});

test('sequential seeds (1..50) produce a well-spread first draw, not a tight cluster', () => {
  const cfgHash = 0xabc12300;
  const draws = Array.from({ length: 50 }, (_, i) => seededRng((cfgHash ^ (i + 1)) >>> 0)());
  const lo = Math.min(...draws);
  const hi = Math.max(...draws);
  assert.ok(hi - lo > 0.5, `50 seeds spanned only ${(hi - lo).toFixed(4)} of [0,1) — should cover most of the range`);
});
