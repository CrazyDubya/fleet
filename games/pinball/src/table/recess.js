// RECESS table layout — pure data. Coordinates start from design doc §4.3 and are adjusted
// here for a buildable pass; deviations are called out below rather than hidden.
//
// Deviations from §4.3 recorded:
// - The launch lane is modelled as a channel appended OUTSIDE the main playfield rectangle
//   (x in [0.257, 0.292]) rather than carved out of the right edge (x in [0.215, 0.250]).
//   Carving the lane into the existing boundary needs a stepped right wall that isn't worth
//   the complexity before ramps/orbits (T5) exist to justify the real geometry. The lane
//   still enters at the top and the one-way gate still behaves as described in §5.
// - Outlanes/inlanes/slingshots/pop bumpers/ramps are not modelled yet (T4/T5); the outer
//   boundary is the plain rectangle plus the launch lane, with a converging apron at the
//   bottom (see below) standing in for the eventual outlane/inlane split.
//
// T3b correction (2026-08-30, per the failed T3 checkpoint): there is NO bottom wall.
// A flat bottom-plus-hole geometry lets a ball settle in a bottom corner forever. Instead
// the lower playfield is bounded by walls that CONVERGE toward the centre as y decreases —
// every point below the flippers has a downhill slope toward the open drain, so nothing can
// come to rest there. `isDrained` is just "below y = 0", full width, no gap to aim for.
import { Segment } from '../physics/shapes.js';
import { E_WALL, E_FLIPPER, FLIPPER, GATE_ONE_WAY_THRESHOLD } from '../physics/constants.js';

export const HALF_WIDTH = 0.257;
export const HEIGHT = 1.067;
// Where the converging apron walls end and the open drain begins (per §4.3's corrected
// lower run: left (-0.257,0.300)->(-0.205,0.120)->(-0.150,0.020), right mirrored).
export const APRON_NECK_X = 0.15;
export const APRON_NECK_Y = 0.02;
export const APRON_MID_X = 0.205;
export const APRON_MID_Y = 0.12;
export const APRON_TOP_Y = 0.3;

export const LANE_INNER_X = HALF_WIDTH;
export const LANE_OUTER_X = HALF_WIDTH + 0.035;
export const LANE_TOP_Y = 0.9;
export const LANE_BOTTOM_Y = 0.02;
export const LANE_MID_X = (LANE_INNER_X + LANE_OUTER_X) / 2;

export const LEFT_FLIPPER_PIVOT = { x: -0.078, y: 0.105 };
export const RIGHT_FLIPPER_PIVOT = { x: 0.078, y: 0.105 };
export const UPPER_LEFT_FLIPPER_PIVOT = { x: -0.115, y: 0.52 };

export function buildWalls() {
  const walls = [];

  // Left + top outer boundary, down to where the converging apron run takes over.
  walls.push(Segment({ x: -HALF_WIDTH, y: APRON_TOP_Y }, { x: -HALF_WIDTH, y: HEIGHT }, E_WALL, 'left'));
  // Top wall spans the full outer width, including the launch-lane mouth above the gate —
  // above LANE_TOP_Y the lane and main field share one open upper chamber.
  walls.push(Segment({ x: -HALF_WIDTH, y: HEIGHT }, { x: LANE_OUTER_X, y: HEIGHT }, E_WALL, 'top'));

  // No separate right wall above the lane mouth: from LANE_TOP_Y up to HEIGHT the lane and
  // main field share one open chamber, bounded by the lane's outer wall and the top wall.

  // Converging apron: no bottom wall anywhere. Both lower runs slope continuously toward
  // the centre as y decreases, so every point below them has a downhill path to the open
  // drain (y < 0, full width) — there is no flat segment for a ball to rest on.
  walls.push(Segment({ x: -HALF_WIDTH, y: APRON_TOP_Y }, { x: -APRON_MID_X, y: APRON_MID_Y }, E_WALL, 'apron-left'));
  walls.push(Segment({ x: -APRON_MID_X, y: APRON_MID_Y }, { x: -APRON_NECK_X, y: APRON_NECK_Y }, E_WALL, 'apron-left'));
  walls.push(Segment({ x: HALF_WIDTH, y: APRON_TOP_Y }, { x: APRON_MID_X, y: APRON_MID_Y }, E_WALL, 'apron-right'));
  walls.push(Segment({ x: APRON_MID_X, y: APRON_MID_Y }, { x: APRON_NECK_X, y: APRON_NECK_Y }, E_WALL, 'apron-right'));

  // Launch lane: outer wall, floor, and the inner wall separating it from the main field
  // (open at the top past LANE_TOP_Y so the ball can cross into the field there).
  walls.push(Segment({ x: LANE_OUTER_X, y: 0 }, { x: LANE_OUTER_X, y: HEIGHT }, E_WALL, 'lane-outer'));
  walls.push(Segment({ x: LANE_INNER_X, y: LANE_BOTTOM_Y }, { x: LANE_INNER_X, y: LANE_TOP_Y }, E_WALL, 'lane-inner'));
  walls.push(Segment({ x: LANE_INNER_X, y: LANE_BOTTOM_Y }, { x: LANE_OUTER_X, y: LANE_BOTTOM_Y }, E_WALL, 'lane-floor'));

  // Deflector plate above the lane mouth: redirects a ball shot straight up the lane into
  // the main field via an ordinary angled bounce (no special-cased "teleport into the
  // field" logic needed) — modelling the curved lane guide on a real machine.
  walls.push(
    Segment({ x: LANE_OUTER_X, y: HEIGHT }, { x: HALF_WIDTH - 0.09, y: HEIGHT - 0.16 }, E_WALL, 'lane-deflector')
  );

  // One-way gate at the mouth of the lane: solid against a ball falling back down into the
  // lane, transparent to a ball launched upward past GATE_ONE_WAY_THRESHOLD.
  walls.push(
    Segment(
      { x: LANE_INNER_X, y: LANE_TOP_Y },
      { x: LANE_OUTER_X, y: LANE_TOP_Y },
      E_WALL,
      'lane-gate',
      0,
      { allow: { x: 0, y: 1 }, threshold: GATE_ONE_WAY_THRESHOLD }
    )
  );

  return walls;
}

// overrides defaults to every shipped constant — a signature widening (2026-09-04, for the
// sandbox's live constants panel), not a physics change: every call site in games/pinball
// calls buildFlipperConfigs() with no argument and gets exactly the constants, byte-identical
// to before this parameter existed. lowerRestAngle/lowerActiveAngle apply to both lower
// flippers (right mirrors as 180 - value, same as the shipped geometry always did); the upper
// flipper's angles are left fixed at their shipped values — only its upMs/downMs and the
// shared restitution are exposed, matching the sandbox panel's own scope (E_FLIPPER, upMs for
// lower AND upper, one restAngle/activeAngle pair).
export function buildFlipperConfigs(overrides = {}) {
  const o = {
    lowerRestAngle: FLIPPER.lower.restAngle,
    lowerActiveAngle: FLIPPER.lower.activeAngle,
    lowerUpMs: FLIPPER.lower.upMs,
    lowerDownMs: FLIPPER.lower.downMs,
    upperUpMs: FLIPPER.upper.upMs,
    upperDownMs: FLIPPER.upper.downMs,
    eFlipper: E_FLIPPER,
    ...overrides,
  };
  return [
    {
      name: 'left', pivot: LEFT_FLIPPER_PIVOT, length: FLIPPER.lower.length, upMs: o.lowerUpMs, downMs: o.lowerDownMs,
      restAngleDeg: o.lowerRestAngle, activeAngleDeg: o.lowerActiveAngle, restitution: o.eFlipper, tag: 'flipper-left',
    },
    {
      name: 'right', pivot: RIGHT_FLIPPER_PIVOT, length: FLIPPER.lower.length, upMs: o.lowerUpMs, downMs: o.lowerDownMs,
      restAngleDeg: 180 - o.lowerRestAngle, activeAngleDeg: 180 - o.lowerActiveAngle, restitution: o.eFlipper, tag: 'flipper-right',
    },
    {
      name: 'upperLeft', pivot: UPPER_LEFT_FLIPPER_PIVOT, length: FLIPPER.upper.length, upMs: o.upperUpMs, downMs: o.upperDownMs,
      restAngleDeg: FLIPPER.upper.restAngle, activeAngleDeg: FLIPPER.upper.activeAngle, restitution: o.eFlipper, tag: 'flipper-upper-left',
    },
  ];
}

export const LAUNCH_POSITION = { x: LANE_MID_X, y: LANE_BOTTOM_Y + 0.02 };

/** Pure geometry check: has the ball fallen below the playfield (no bottom wall, full width)? */
export function isDrained(ball) {
  return ball.pos.y <= 0.001;
}
