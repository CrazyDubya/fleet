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
import { E_WALL, E_FLIPPER, FLIPPER, GATE_ONE_WAY_THRESHOLD, BALL_RADIUS } from '../physics/constants.js';
// Swing-set (slingshot) post geometry, needed only to route the outlane/inlane dividers around
// it (see routeAroundPost below) — safe to import here: mechanisms.js does not import recess.js,
// so this is not circular.
import { SWING_SET_APEXES, SWING_SET_POST_RADIUS, SWING_SET_POST_DX } from './mechanisms.js';

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

// OUTLANE/INLANE SPLIT (2026-09-04) — real machine geometry, not invented: a standard
// playfield has two outlanes flanking the drain on the outside (bounded by the table's own
// side/apron wall) and two inlanes inboard of them feeding the flippers, divided by a post.
// This supersedes this file's earlier "not modelled yet" note (kept above, historical) — the
// apron wall was standing in for this split; now it IS one side of it (the outlane's own outer
// wall, unchanged), and a new inner wall carves the inlane out of what used to be open gap
// between the apron and the flippers.
//
// OUTLANE_WIDTH: no sourced figure exists for THIS design (§4.3 doesn't specify one) — set to
// 1.5 ball diameters, the commonly-cited real-world figure and the one named in this dispatch;
// marked as a design choice, the same way the kickback's placement was.
export const OUTLANE_WIDTH = BALL_RADIUS * 2 * 1.5; // ~40mm

/** Segment a->b, offset perpendicular by `dist` (positive = the side +90 degrees
 * counter-clockwise from a->b's own direction) — a true parallel copy, both endpoints offset
 * by the same normal. Used so the outlane/inlane divider is DERIVED from the existing apron
 * wall's own two points, not a second, independently-eyeballed set of coordinates — if the
 * apron is ever re-authored, the divider follows it by construction instead of silently
 * drifting out of parallel. */
function offsetSegment(a, b, dist) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * dist, ny = (dx / len) * dist;
  return [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }];
}

/** Intersection of infinite lines p1->p2 and p3->p4. Used to miter two offset segments at a
 * shared joint instead of leaving their independently-offset endpoints disconnected — offsetting
 * a two-segment polyline's segments separately (the naive approach) leaves a gap/kink at the
 * joint (offsetSegment alone does this: the two segments were each translated by their OWN
 * normal, which differ, so the copies don't meet). This was caught, not assumed: the drain-sweep
 * re-measurement below found a ball trapped in exactly that gap. */
function lineIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/** Offset a 3-point polyline (a->mid->b) perpendicular by `dist`, mitered at `mid` so the two
 * resulting segments share one joint vertex instead of two disconnected offset endpoints. */
function offsetPolylineMitered(a, mid, b, dist) {
  const [t1a, t1b] = offsetSegment(a, mid, dist);
  const [t2a, t2b] = offsetSegment(mid, b, dist);
  const joint = lineIntersect(t1a, t1b, t2a, t2b);
  return [t1a, joint, t2b];
}

// Required real clearance between the ball's own surface and a post's surface — same margin
// style as the drain-sweep test's own `tooClose` check (BALL_RADIUS + 5mm), not a new figure.
const OBSTACLE_CLEARANCE_MARGIN = 0.005;

/** Where segment a->b first clears a circular obstacle (`postCentre`, `postRadius`) by a full
 * ball's-width-plus-margin, measured coming FROM b (i.e. the point closest to b that still
 * satisfies clearance) — found, not assumed. First attempt bulged the line outward around the
 * post instead of clipping it, and a re-measurement caught a ball wedged between the bulged
 * divider and the (unmoved, outer) apron wall: bulging the divider toward the post's far side
 * necessarily narrows the outlane channel on the OTHER side (against the apron), and this
 * particular stretch of outlane is too narrow to give the bulge room. Clipping instead — simply
 * not extending the divider through the post's danger zone at all — avoids trading one pinch for
 * another. This shortens the divider: the outlane/inlane split doesn't reach as high as the
 * apron's own top point on this side; above the clip point the gap is undifferentiated, same as
 * this file's pre-dispatch model, same as a real machine's guide rail (which is typically a
 * shorter run near the bottom, not the full side-wall height) not reaching that high either.
 *
 * Required wall-line-to-post-CENTRE distance is 2*BALL_RADIUS + postRadius + margin: a ball's
 * CENTRE must clear the wall by BALL_RADIUS *and* clear the post by postRadius+BALL_RADIUS, so
 * the post-to-wall channel needs room for both clearances plus the ball's own diameter passing
 * between them, not just one ball radius (an earlier, too-small margin using only one BALL_RADIUS
 * still trapped a ball right at the point of closest approach). */
function clipPastObstacle(a, b, postCentre, postRadius) {
  const required = 2 * BALL_RADIUS + postRadius + OBSTACLE_CLEARANCE_MARGIN;
  const dx = b.x - a.x, dy = b.y - a.y;
  const fx = a.x - postCentre.x, fy = a.y - postCentre.y;
  const qa = dx * dx + dy * dy;
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - required * required;
  const disc = qb * qb - 4 * qa * qc;
  if (disc <= 0) return a; // line never comes within `required` of the post — no conflict
  const t = (-qb + Math.sqrt(disc)) / (2 * qa); // the intersection closer to b
  if (t <= 0 || t >= 1) return a; // conflict resolves outside this segment — no clip needed
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function swingSetPostCentre(apex, dx) {
  return { x: apex.x + dx, y: apex.y + 0.02 };
}

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

  // OUTLANE/INLANE dividers: one inner wall per side, a true parallel copy of the apron wall's
  // own two segments, offset OUTLANE_WIDTH inboard (see offsetSegment above). The OUTLANE is
  // the strip between the apron wall (unchanged, outer) and this new wall (inner); the INLANE
  // is everything inboard of it, open down toward the flipper — no wall on the inlane's own
  // inner side, because the flipper capsule IS that boundary. Below the divider's lower end
  // (mirroring the apron's own NECK point) there is no wall, same as the apron itself: both
  // lanes open into the same converging, no-bottom-wall drain below that height.
  // Each divider's upper (top->mid) run passes near the swing-set/slingshot's own inboard-most
  // support post (swingset_left_post1 / swingset_right_post2 — measured, not assumed: the
  // straight offset line left only 1.2mm of clearance there, well under a ball's 27mm diameter).
  // clipPastObstacle shortens that run so it doesn't extend through the post's danger zone (see
  // its own doc comment for why clipping, not bulging, is the fix that survived measurement).
  const leftPost = swingSetPostCentre(SWING_SET_APEXES[0], SWING_SET_POST_DX[0]);
  const rightPost = swingSetPostCentre(SWING_SET_APEXES[1], SWING_SET_POST_DX[1]);

  const leftApronTop = { x: -HALF_WIDTH, y: APRON_TOP_Y };
  const leftApronMid = { x: -APRON_MID_X, y: APRON_MID_Y };
  const leftApronNeck = { x: -APRON_NECK_X, y: APRON_NECK_Y };
  const [leftDivTop, leftDivMid, leftDivNeck] = offsetPolylineMitered(leftApronTop, leftApronMid, leftApronNeck, OUTLANE_WIDTH);
  const leftDivTopClipped = clipPastObstacle(leftDivTop, leftDivMid, leftPost, SWING_SET_POST_RADIUS);
  walls.push(Segment(leftDivTopClipped, leftDivMid, E_WALL, 'outlane-divider-left'));
  walls.push(Segment(leftDivMid, leftDivNeck, E_WALL, 'outlane-divider-left'));

  const rightApronTop = { x: HALF_WIDTH, y: APRON_TOP_Y };
  const rightApronMid = { x: APRON_MID_X, y: APRON_MID_Y };
  const rightApronNeck = { x: APRON_NECK_X, y: APRON_NECK_Y };
  const [rightDivTop, rightDivMid, rightDivNeck] = offsetPolylineMitered(rightApronTop, rightApronMid, rightApronNeck, -OUTLANE_WIDTH);
  const rightDivTopClipped = clipPastObstacle(rightDivTop, rightDivMid, rightPost, SWING_SET_POST_RADIUS);
  walls.push(Segment(rightDivTopClipped, rightDivMid, E_WALL, 'outlane-divider-right'));
  walls.push(Segment(rightDivMid, rightDivNeck, E_WALL, 'outlane-divider-right'));

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
