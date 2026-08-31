// Ramps and orbits: 1D tracks living in their own layer. See design doc §2.2 — a ball is
// in exactly one layer at a time, layer transitions happen at explicit gates, and z is a
// pure function of arclength (rendering reads it; it is never fed back into 2D collision).
// Headless — no THREE, no DOM, no wall-clock reads.
import { sub, length } from './vec2.js';

const G = 9.81;

/**
 * A ramp/orbit track. `points` is an ordered array of {x, y, z} defining the track's
 * centreline — x,y in playfield space (so a ramp ball's `pos` stays directly comparable to
 * everything else on the table), z the rendered height at that station. Arclength is
 * accumulated over the (x,y) projection only; z labels height, it doesn't lengthen the
 * track — that's the "2.5D" simplification the design doc calls for.
 *
 * `pitchDeg` is the ramp's OWN incline (steeper than the playfield's 6.5°, per §9 T5:
 * "gravity along a ramp uses that ramp's own pitch, not the playfield's"): gravity along
 * the track is a constant `-G*sin(pitchDeg)` opposing forward (+s, "uphill") travel. A
 * shot that doesn't carry enough speed decelerates, stops short of `totalLength`, and
 * rolls back down under the same deceleration — real single-incline physics, which is a
 * deliberate simplification of ramps whose real geometry rises then falls (the "habitrail
 * return" is not separately simulated; see `exit` below).
 *
 * `exit` — where a ball that REACHES `totalLength` (makes the shot) re-enters 'playfield':
 * `{ pos: {x,y}, dir: unit {x,y}, speed }`. This collapses the habitrail's/wireform's/
 * orbit's actual downhill return into a single deterministic hand-off, recorded here as a
 * simplification rather than hidden (consistent with this codebase's other "buildable
 * first pass" notes in flipper.js/constants.js).
 */
export function createRampTrack({ id, points, pitchDeg, friction = 0.4, exit, entryBackSpeedFloor = 0.3 }) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + length(sub(points[i], points[i - 1])));
  }
  return { id, points, cum, totalLength: cum[cum.length - 1], pitchDeg, friction, exit, entryBackSpeedFloor };
}

/** Sample the track at arclength s (clamped to [0, totalLength]). */
export function sampleRamp(ramp, s) {
  const clamped = Math.max(0, Math.min(ramp.totalLength, s));
  const { points, cum } = ramp;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < clamped) i++;
  const segLen = cum[i] - cum[i - 1];
  const t = segLen > 1e-9 ? (clamped - cum[i - 1]) / segLen : 0;
  const a = points[i - 1];
  const b = points[i];
  const pos = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const z = a.z + (b.z - a.z) * t;
  const dir = { x: b.x - a.x, y: b.y - a.y };
  const dLen = Math.hypot(dir.x, dir.y) || 1;
  return { pos, z, tangent: { x: dir.x / dLen, y: dir.y / dLen } };
}

/** The direction of travel at the very start of the track — used to derive a gate's
 * "into the ramp" direction straight from the authored geometry, so the two never drift
 * apart. */
export function entryTangent(ramp) {
  return sampleRamp(ramp, Math.min(1e-6, ramp.totalLength / 2)).tangent;
}

/**
 * Advance a ball already on a ramp track by dt seconds. `ball.s`/`ball.sVel` are the
 * scalar position/velocity along the track; `ball.pos`/`ball.vel`/`ball.z` are kept in
 * sync from the sample so rendering and a subsequent hand-off to 'playfield' both see a
 * sane, consistent state. Returns 'top' | 'bottom' | null depending on whether the ball
 * just ran off either end of the track this step.
 */
export function stepRampBall(ball, ramp, dt) {
  const pitchRad = (ramp.pitchDeg * Math.PI) / 180;
  const gAlong = -G * Math.sin(pitchRad);
  ball.sVel += gAlong * dt;
  ball.sVel *= Math.max(0, 1 - ramp.friction * dt);
  ball.s += ball.sVel * dt;

  let exited = null;
  if (ball.s >= ramp.totalLength) exited = 'top';
  else if (ball.s <= 0) exited = 'bottom';

  const sample = sampleRamp(ramp, ball.s);
  ball.pos = sample.pos;
  ball.z = sample.z;
  ball.vel = { x: sample.tangent.x * ball.sVel, y: sample.tangent.y * ball.sVel };

  return exited;
}
