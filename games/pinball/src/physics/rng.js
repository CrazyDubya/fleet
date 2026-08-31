// Deterministic xorshift128 PRNG. Pure — the only source of randomness anywhere in
// physics/table/rules, so games (and this test suite) are reproducible from a seed.

export function makeRng(seed = 1) {
  let x = seed >>> 0 || 1;
  let y = 362436069;
  let z = 521288629;
  let w = 88675123;

  return function next() {
    const t = x ^ (x << 11);
    x = y; y = z; z = w;
    w = (w ^ (w >>> 19)) ^ (t ^ (t >>> 8));
    w >>>= 0;
    return w / 4294967296;
  };
}

export function range(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
