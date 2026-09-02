// LAB-4, §5.3 — the E1→E3 coupling: P2-P5 sample their launch (speed, angle) from E1's
// measured shot-line distribution (e1ShotlineCdf.js's output) via bootstrap resampling (draw
// a uniformly-random INDEX into the real (speed,angle) pair array, seeded by the trial's own
// rng) rather than sampling speed/angle independently — resampling a real pair preserves
// whatever speed/angle correlation a real flipper actually produces, which independent
// marginal sampling would destroy.
//
// A static, committed JSON file read here is not a purity violation (test/purity.test.mjs
// only forbids the wall-clock and other non-deterministic sources — a real
// concern, not file I/O): the file's content is fixed, `cfg.shotlineSamplesPath` is part of
// the cfg (and therefore its cfgId), and reading the same path always returns the same
// samples — `(cfgId, seed) -> record` stays exactly as deterministic as every other
// experiment. In-process cache keyed by path so a worker handling many cfgs off the same
// file only parses it once.
import { readFileSync } from 'node:fs';
import { pick } from '../../pinball/src/physics/rng.js';

const cache = new Map();

export function loadShotlineSamples(relPath) {
  let entry = cache.get(relPath);
  if (entry) return entry;
  const absPath = new URL(`../${relPath}`, import.meta.url);
  const data = JSON.parse(readFileSync(absPath, 'utf8'));
  entry = { samples: data.samples, meanAngleDeg: data.meanAngleDeg };
  cache.set(relPath, entry);
  return entry;
}

/** Draws a uniformly-random real (speed, angle) pair from the loaded empirical sample set,
 * via the game's own `pick()` (rng.js) — same draw mechanism as every other rng-consuming
 * call in this codebase, not a bespoke index formula. */
export function sampleShotline(rng, entry) {
  const [speed, angleDeg] = pick(rng, entry.samples);
  return { speed, angleDeg };
}
