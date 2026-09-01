// Seed expansion for inbound sampling (program handoff §2.4a — the LAB-1 pilot's actual bug).
//
// The game's `physics/rng.js` makeRng(seed) sets `x = seed >>> 0 || 1` and leaves y/z/w at
// fixed constants. That's fine for the game, which draws one long stream per game — entropy
// from x fully diffuses into y/z/w within a handful of steps, and nothing ever reads the
// first few outputs in isolation. It is fatal for a harness that draws only the first 2-3
// outputs of a FRESH stream per trial: y/z/w start identical for every seed, and the xorshift
// recurrence's 4-step shift register (x<-y<-z<-w) means genuine seed-dependent entropy
// doesn't even reach the x slot (the one range()/pick() actually read from) until the 4th
// output — so seeds 1, 2, 3 produced injected balls agreeing to seven significant figures.
//
// Fix, lab-side only (games/pinball/src/physics/* is never touched): splitmix32 seeds all
// four xorshift128 words independently instead of leaving three of them fixed, and a >=20
// -draw warm-up discards the still-correlated early outputs before any real sampling. This
// reimplements the same six-line xorshift128 step as physics/rng.js — not a copy of "the
// instrument" in §2.1's sense (the physics whose behaviour must transfer to the game); it's
// six lines of a generic, textbook algorithm, needed only because makeRng's signature has no
// way to seed y/z/w independently, which is exactly the defect being worked around.
const U32 = 0x100000000;

function splitmix32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

export const WARMUP_DRAWS = 32; // packet: ">= 20"; a round margin above the stated floor.

/** A fresh, well-mixed generator from a single uint32 seed: splitmix32 fills x/y/z/w, then
 * WARMUP_DRAWS outputs are discarded before the returned `next()` is used for real. */
export function seededRng(seedU32) {
  const sm = splitmix32(seedU32 >>> 0);
  let x = sm() || 1;
  let y = sm() || 1;
  let z = sm() || 1;
  let w = sm() || 1;

  function next() {
    const t = x ^ (x << 11);
    x = y; y = z; z = w;
    w = (w ^ (w >>> 19)) ^ (t ^ (t >>> 8));
    w >>>= 0;
    return w / U32;
  }

  for (let i = 0; i < WARMUP_DRAWS; i++) next();
  return next;
}
