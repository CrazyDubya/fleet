// EXPERIMENT 4 arena — the pocket (opus2 design handoff, 2026-09-01T13:41Z, §2). Extends
// E1's arena (same walls/apron/pivots/shot line/createFlipper path) with a parameterised
// lower assembly — W1 pocket guide, W2 feed rail, W3 tip post, W4 outlane divider — built on
// the left and mirrored about x=0 (`side`: +1 left, -1 right). `games/pinball/` is untouched;
// this file only imports the shipped physics primitives, same as e1_flippers.js/e2_bumpers.js.
import { Segment, Circle } from '../../../pinball/src/physics/shapes.js';
import { createFlipper } from '../../../pinball/src/physics/flipper.js';
import { createWorld, setLayerPrimitives, addFlipper, addBall } from '../../../pinball/src/physics/world.js';
import { E_WALL, FLIPPER, BALL_RADIUS } from '../../../pinball/src/physics/constants.js';
import {
  SHOT_LINE_Y, LEFT_PIVOT, RIGHT_PIVOT, ARENA_BOUNDS, CRADLE_INJECTION, OMEGA_PROFILES,
} from './e1_flippers.js';

export { SHOT_LINE_Y, LEFT_PIVOT, RIGHT_PIVOT, ARENA_BOUNDS, CRADLE_INJECTION };

const DEG = Math.PI / 180;
const FOUL_MARGIN = 0.001; // §2.5 assertion 1's 1mm safety margin
const RAIL_LEN = 0.10; // §2.2 W2
const RAIL_STANDOFF = 0.030; // §2.2 W2 — lower end sits 0.030m above the flipper's active face
const GUIDE_LEN = 0.09; // §2.1 W1's U = T + 0.09*(...)

function buildWalls() {
  // Verbatim copy of e1_flippers.js's buildWalls — duplicated rather than imported because
  // that function isn't exported (arena-private there) and E4 needs the identical apron.
  const HALF_WIDTH = 0.257, WALL_TOP_Y = 0.62, APRON_TOP_Y = 0.3;
  const APRON_MID_X = 0.205, APRON_MID_Y = 0.12, APRON_NECK_X = 0.15, APRON_NECK_Y = 0.02;
  return [
    Segment({ x: -HALF_WIDTH, y: WALL_TOP_Y }, { x: -HALF_WIDTH, y: APRON_TOP_Y }, E_WALL, 'left'),
    Segment({ x: HALF_WIDTH, y: WALL_TOP_Y }, { x: HALF_WIDTH, y: APRON_TOP_Y }, E_WALL, 'right'),
    Segment({ x: -HALF_WIDTH, y: APRON_TOP_Y }, { x: -APRON_MID_X, y: APRON_MID_Y }, E_WALL, 'apron-left'),
    Segment({ x: -APRON_MID_X, y: APRON_MID_Y }, { x: -APRON_NECK_X, y: APRON_NECK_Y }, E_WALL, 'apron-left'),
    Segment({ x: HALF_WIDTH, y: APRON_TOP_Y }, { x: APRON_MID_X, y: APRON_MID_Y }, E_WALL, 'apron-right'),
    Segment({ x: APRON_MID_X, y: APRON_MID_Y }, { x: APRON_NECK_X, y: APRON_NECK_Y }, E_WALL, 'apron-right'),
  ];
}

function pivotFor(side) {
  return side === 1 ? LEFT_PIVOT : RIGHT_PIVOT;
}

// --- §2.1 W1 geometry, canonical "left" formula (side=+1), mirrored in x for side=-1. ---
export function guideEndpoints({ gapX, tiltDeg, endDy, side }) {
  const pivot = pivotFor(side);
  const tilt = tiltDeg * DEG;
  const T = { x: pivot.x - side * gapX, y: pivot.y + endDy };
  const U = { x: T.x - side * GUIDE_LEN * Math.sin(tilt), y: T.y + GUIDE_LEN * Math.cos(tilt) };
  return { T, U };
}

function flipperDir(activeAngleDeg, side) {
  // Left flipper's active angle is cfg.activeAngleDeg directly (side=1); the right flipper is
  // built at 180-activeAngleDeg (e1_flippers.js's mirroring convention) — reproduce that here
  // rather than re-deriving a different mirror rule.
  const angle = (side === 1 ? activeAngleDeg : 180 - activeAngleDeg) * DEG;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function tipAtActive({ activeAngleDeg, length, side }) {
  const pivot = pivotFor(side);
  const dir = flipperDir(activeAngleDeg, side);
  return { x: pivot.x + dir.x * length, y: pivot.y + dir.y * length };
}

// Flipper's "upper face" normal at active angle — the side a resting ball sits on. Left
// flipper: rotate its direction vector +90°; right flipper is x-mirrored, so its own normal
// is the x-mirror of the same rotation applied to the UN-mirrored (canonical-left) direction.
function flipperUpNormal(activeAngleDeg, side) {
  const canonicalDir = { x: Math.cos(activeAngleDeg * DEG), y: Math.sin(activeAngleDeg * DEG) };
  const n = { x: -canonicalDir.y, y: canonicalDir.x };
  return { x: side * n.x, y: n.y };
}

function lineIntersect(p1, d1, p2, d2) {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-12) return null;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const t = (dx * d2.y - dy * d2.x) / denom;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

/**
 * §1.1's two-contact static-equilibrium solve, generalised off the hand-derived table to any
 * (gapX, tiltDeg, endDy, activeAngleDeg, flipperRadius) — not a re-derivation of the physics,
 * just the same "offset line ∩ offset line, then check both contact forces are ≥0" method
 * carried to arbitrary parameters instead of six hand-picked rows. Approximates the guide as
 * locally straight near its lower terminus (true for tiltDeg's small range here) and the
 * flipper as its capsule centreline at the active angle (true once `heldActive` has settled).
 * Returns { feasible, point:{x,y}, forces:{wall,flipper} } in world coordinates.
 */
export function pocketSolve({ gapX, tiltDeg, endDy, activeAngleDeg, flipperRadius, ballRadius = BALL_RADIUS, side = 1 }) {
  const pivot = pivotFor(side);
  const dir = flipperDir(activeAngleDeg, side);
  const upNormal = flipperUpNormal(activeAngleDeg, side);
  const rFlip = flipperRadius + ballRadius;
  const flipLinePoint = { x: pivot.x + upNormal.x * rFlip, y: pivot.y + upNormal.y * rFlip };

  const { T } = guideEndpoints({ gapX, tiltDeg, endDy, side });
  const tilt = tiltDeg * DEG;
  const gDir = { x: -side * Math.sin(tilt), y: Math.cos(tilt) };
  // Normal pointing from the guide INTO the table (toward the pivot), i.e. toward where the
  // ball actually rests.
  const guideNormalIn = { x: side * Math.cos(tilt), y: Math.sin(tilt) };
  const guideLinePoint = { x: T.x + guideNormalIn.x * ballRadius, y: T.y + guideNormalIn.y * ballRadius };

  const point = lineIntersect(flipLinePoint, dir, guideLinePoint, gDir);
  if (!point) return { feasible: false, point: null, forces: null };

  // Force balance: a*guideNormalIn + b*upNormal = (0, 1) (unit "gravity", direction only
  // matters for the sign check). Solve the 2x2 system.
  const det = guideNormalIn.x * upNormal.y - guideNormalIn.y * upNormal.x;
  if (Math.abs(det) < 1e-9) return { feasible: false, point, forces: null };
  const a = (0 * upNormal.y - 1 * upNormal.x) / det;
  const b = (guideNormalIn.x * 1 - guideNormalIn.y * 0) / det;
  const feasible = a >= -1e-6 && b >= -1e-6;
  return { feasible, point, forces: { wall: a, flipper: b } };
}

function pointToSegmentDistance(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx, cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Clearance from a point to a shape's own surface (not its centreline) — segments/rails have
 * zero extra radius; circles (the tip post) subtract their own radius. */
function pointToShapeClearance(p, shape) {
  if (shape.kind === 'circle') return Math.hypot(p.x - shape.centre.x, p.y - shape.centre.y) - shape.radius;
  return pointToSegmentDistance(p, shape.a, shape.b);
}

/** §2.5 assertion 1: sample the flipper's swept capsule centreline at 1° steps across
 * [restAngle, activeAngle] and, at each angle, sample points along the flipper segment,
 * checking every non-flipper shape clears it by more than `flipper.radius + FOUL_MARGIN`.
 * Throws on the first violation (build-time-fatal per the design doc, not a warning). */
function assertNoFoul(shapes, { pivot, restAngleDeg, activeAngleDeg, length, radius }) {
  const lo = Math.min(restAngleDeg, activeAngleDeg);
  const hi = Math.max(restAngleDeg, activeAngleDeg);
  const steps = Math.max(1, Math.ceil(hi - lo));
  for (let i = 0; i <= steps; i++) {
    const angleDeg = lo + ((hi - lo) * i) / steps;
    const angle = angleDeg * DEG;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    for (let s = 0; s <= 20; s++) {
      const u = s / 20;
      const p = { x: pivot.x + dir.x * length * u, y: pivot.y + dir.y * length * u };
      for (const shape of shapes) {
        const clearance = pointToShapeClearance(p, shape) - (shape.padding || 0);
        if (clearance <= radius + FOUL_MARGIN) {
          throw new Error(
            `buildE4World: shape '${shape.tag}' fouls the flipper sweep at angle ${angleDeg.toFixed(1)}° ` +
            `(clearance ${clearance.toFixed(4)}m <= ${(radius + FOUL_MARGIN).toFixed(4)}m)`
          );
        }
      }
    }
  }
}

/** §2.5 assertion 2: no injection point overlaps a primitive (the T8 P0 carry-over). Each
 * point carries `ownTag`, the shape it is the endpoint OF (the inlane rail's own upper end,
 * for an 'inlane' spawn) — that shape is excluded from its own point's check, since a point
 * defined as lying exactly on a segment trivially has ~0 clearance from that one segment. */
function assertInjectionClear(shapes, points) {
  for (const { point: p, ownTag } of points) {
    for (const shape of shapes) {
      if (shape.tag === ownTag) continue;
      const clearance = pointToShapeClearance(p, shape) - (shape.padding || 0);
      if (clearance <= BALL_RADIUS + FOUL_MARGIN) {
        throw new Error(`buildE4World: injection point (${p.x.toFixed(4)},${p.y.toFixed(4)}) overlaps shape '${shape.tag}'`);
      }
    }
  }
}

/** Build one side's W1-W4 shapes + this side's flipper spec. `side`: +1 left, -1 right. */
function buildSideAssembly(cfg, side) {
  const pivot = pivotFor(side);
  const shapes = [];
  const meta = { side: side === 1 ? 'L' : 'R' };

  if (cfg.shelf) {
    // C1 control: a horizontal ledge under the flipper base — catches nearly everything, the
    // metrics upper bound (§6.4). Positioned INSIDE the apron's open neck (the apron walls
    // converge to +-0.15m by y=0.02; a shelf outboard of that is physically unreachable,
    // hidden behind the apron itself — the first placement made exactly that mistake) and
    // below the flipper's lowest swept point at rest, minus its own radius+ball margin.
    const y = 0.025;
    const x0 = pivot.x - side * 0.07;
    const x1 = pivot.x + side * 0.06;
    shapes.push(Segment({ x: Math.min(x0, x1), y }, { x: Math.max(x0, x1), y }, E_WALL, `shelf-${meta.side}`));
  } else if (cfg.guide) {
    const { gapX, tiltDeg, endDy, guideE } = cfg.guide;
    const { T, U } = guideEndpoints({ gapX, tiltDeg, endDy, side });
    shapes.push(Segment(T, U, guideE, `guide-${meta.side}`));
  }

  if (cfg.feed) {
    const { feedAngleDeg, feedHs } = cfg.feed;
    const facePoint = { x: pivot.x + flipperDir(cfg.activeAngleDeg, side).x * feedHs * cfg.flipperLength,
                         y: pivot.y + flipperDir(cfg.activeAngleDeg, side).y * feedHs * cfg.flipperLength };
    const upNormal = flipperUpNormal(cfg.activeAngleDeg, side);
    const lower = { x: facePoint.x + upNormal.x * RAIL_STANDOFF, y: facePoint.y + upNormal.y * RAIL_STANDOFF };
    const angle = feedAngleDeg * DEG;
    const dir = { x: -side * Math.cos(angle), y: Math.sin(angle) };
    const upper = { x: lower.x + dir.x * RAIL_LEN, y: lower.y + dir.y * RAIL_LEN };
    shapes.push(Segment(lower, upper, E_WALL, `rail-${meta.side}`));
    meta.rail = { lower, upper };
  }

  if (cfg.post) {
    const { dx, dy, postR, postE } = cfg.post;
    const tip = tipAtActive({ activeAngleDeg: cfg.activeAngleDeg, length: cfg.flipperLength, side });
    const centre = { x: tip.x + side * dx, y: tip.y + dy };
    shapes.push(Circle(centre, postR, postE, `post-${meta.side}`));
  }

  if (cfg.outlaneW) {
    const gapX = cfg.guide ? cfg.guide.gapX : 0.026; // outlane can be swept independent of a guide
    const { T } = guideEndpoints({ gapX, tiltDeg: cfg.guide ? cfg.guide.tiltDeg : 0, endDy: cfg.guide ? cfg.guide.endDy : 0, side });
    const x = T.x - side * cfg.outlaneW;
    shapes.push(Segment({ x, y: 0.62 }, { x, y: 0.02 }, E_WALL, `outlane-${meta.side}`));
  }

  return { shapes, meta };
}

/**
 * Build a fresh E4 world for one trial. `cfg` (see design §2/§3): flipper geometry
 * (restAngleDeg, activeAngleDeg, upMs, radius, restitution, omegaProfile?), plus `guide`/
 * `feed`/`post`/`outlaneW`/`shelf` (any may be null/absent — "off"), plus `inj`
 * ('drop'|'inlane') and the policy fields consumed by policy.js.
 */
export function buildE4World(cfg) {
  const world = createWorld();
  const flipperLength = FLIPPER.lower.length;
  const cfgWithLen = { ...cfg, flipperLength };

  const left = buildSideAssembly(cfgWithLen, 1);
  const right = buildSideAssembly(cfgWithLen, -1);
  const wallShapes = buildWalls();
  const guideShapes = [...left.shapes, ...right.shapes];
  const allShapes = [...wallShapes, ...guideShapes];

  const omegaProfile = cfg.omegaProfile ? OMEGA_PROFILES[cfg.omegaProfile] : undefined;
  if (cfg.omegaProfile && !omegaProfile) throw new Error(`unknown omegaProfile '${cfg.omegaProfile}'`);

  const leftFlipper = createFlipper({
    pivot: LEFT_PIVOT, length: flipperLength, radius: cfg.radius,
    restAngleDeg: cfg.restAngleDeg, activeAngleDeg: cfg.activeAngleDeg,
    upMs: cfg.upMs, downMs: FLIPPER.lower.downMs, side: 1, restitution: cfg.restitution, tag: 'flipper-left',
  });
  const rightFlipper = createFlipper({
    pivot: RIGHT_PIVOT, length: flipperLength, radius: cfg.radius,
    restAngleDeg: 180 - cfg.restAngleDeg, activeAngleDeg: 180 - cfg.activeAngleDeg,
    upMs: cfg.upMs, downMs: FLIPPER.lower.downMs, side: -1, restitution: cfg.restitution, tag: 'flipper-right',
  });
  if (omegaProfile) {
    leftFlipper.omegaProfile = omegaProfile;
    rightFlipper.omegaProfile = omegaProfile;
  }

  // §2.5 assertion 1, both flippers against every shape — walls included (LAB-14): "always
  // clear by construction" (this file's prior comment here) was an assumption about E1's
  // unmodified geometry, not a check of it; e1_flippers.js now asserts the same thing on its
  // own walls independently, but this call is what actually verifies it for an E4 cfg, since
  // E4 never calls buildE1World itself.
  assertNoFoul(allShapes, { pivot: LEFT_PIVOT, restAngleDeg: cfg.restAngleDeg, activeAngleDeg: cfg.activeAngleDeg, length: flipperLength, radius: cfg.radius });
  assertNoFoul(allShapes, { pivot: RIGHT_PIVOT, restAngleDeg: 180 - cfg.restAngleDeg, activeAngleDeg: 180 - cfg.activeAngleDeg, length: flipperLength, radius: cfg.radius });

  // §2.5 assertion 2: the injection point(s) this cfg can actually produce.
  const injectionPoints = [];
  if (cfg.inj === 'inlane') {
    if (left.meta.rail) injectionPoints.push({ point: left.meta.rail.upper, ownTag: 'rail-L' });
    if (right.meta.rail) injectionPoints.push({ point: right.meta.rail.upper, ownTag: 'rail-R' });
  } else {
    // 'drop' mode (E1's CRADLE_INJECTION band, y=SHOT_LINE_Y) — sample across the band's x
    // range; SHOT_LINE_Y sits far above every W1-W4 shape (all near y<=0.13), so this is a
    // cheap confirmation rather than a live risk, but it is the actual §2.5 assertion 2 check.
    for (let i = 0; i <= 4; i++) {
      const x = CRADLE_INJECTION.xMin + ((CRADLE_INJECTION.xMax - CRADLE_INJECTION.xMin) * i) / 4;
      injectionPoints.push({ point: { x, y: SHOT_LINE_Y }, ownTag: null });
    }
  }
  assertInjectionClear(allShapes, injectionPoints);

  setLayerPrimitives(world, 'playfield', [
    ...wallShapes.map((shape) => ({ shape })),
    ...left.shapes.map((shape) => ({ shape, guide: true })),
    ...right.shapes.map((shape) => ({ shape, guide: true })),
  ]);
  addFlipper(world, leftFlipper);
  addFlipper(world, rightFlipper);

  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: SHOT_LINE_Y }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS, active: true });

  return {
    world, flippers: { left: leftFlipper, right: rightFlipper }, ball,
    shotLineY: SHOT_LINE_Y, bounds: ARENA_BOUNDS,
    guideShapes: [...left.shapes.filter((s) => s.tag.startsWith('guide')), ...right.shapes.filter((s) => s.tag.startsWith('guide'))],
    rail: { left: left.meta.rail ?? null, right: right.meta.rail ?? null },
  };
}

// §5.1's stated tolerance is 0.5mm, but empirically (verified against a settled trial's raw
// trace) a ball's rest position sits systematically ~1mm further from whichever primitive it
// LAST bounced off than the nominal contact distance — solver.js's `PUSHOUT_EPS * 1000` (1mm)
// residual-penetration correction, applied once after every impact and never re-approached for
// a contact that isn't being continuously re-pressed by gravity (a guide, which only takes a
// lateral load; unlike the flipper, which holds the ball's weight and so keeps re-contacting).
// Without this margin `cp` reads near-zero even for a genuine two-contact rest, which is a
// measurement artifact of a known, documented solver constant, not a real "no pocket" finding
// — folded into the tolerance here rather than left to silently undercount every cp. Recorded
// per the project's "adjust and record" convention (see physics/constants.js's own E_FLIPPER).
const SOLVER_PUSHOUT_RESIDUAL_M = 0.001;
const CONTACT_TOL = 0.0005 + SOLVER_PUSHOUT_RESIDUAL_M;

/** Foot-of-perpendicular of `p` onto segment a->b: `t` unclamped (used to test "on the
 * segment, not past an endpoint"), `tc` clamped to [0,1] (the actual rest position, `hs`),
 * `dist` the perpendicular distance to the clamped foot. */
function projectOntoSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
  const tc = Math.max(0, Math.min(1, t));
  const foot = { x: a.x + tc * abx, y: a.y + tc * aby };
  return { t, tc, dist: Math.hypot(p.x - foot.x, p.y - foot.y) };
}

/**
 * §5.1's four settle predicates, evaluated once at the settle instant from ball position
 * alone (not event history) — `ct` is the caller's job (it's just "did we get here at all");
 * this computes cr/cp/cv/hsS given the ball's rest position and the two flippers' CURRENT
 * poses (radians, world coords — `flippers.left/right` are the live Flipper records) plus the
 * world's W1 guide shapes (already side-tagged `guide-L`/`guide-R`).
 *
 * Simplification, recorded rather than silently assumed: this does not check which side of
 * the flipper segment the ball is on (its "upper face") — a touching contact from below is not
 * reachable in practice (the solver's own collision response keeps the ball on the approach
 * side it hit), so the distance-only test is sufficient without adding a second dot-product
 * gate that would need its own sign convention per side.
 */
export function classifySettle({ ballPos, ballRadius, flippers, guideShapes }) {
  const per = {};
  for (const side of ['left', 'right']) {
    const f = flippers[side];
    const tip = { x: f.pivot.x + Math.cos(f.angle) * f.length, y: f.pivot.y + Math.sin(f.angle) * f.length };
    const proj = projectOntoSegment(ballPos, f.pivot, tip);
    const threshold = f.radius + ballRadius + CONTACT_TOL;
    // Clamped distance (`proj.dist` already uses `tc`, not raw `t`) — matches the solver's
    // OWN definition of "touching the flipper" (solver.js's endpoint-collision branches),
    // which treats the segment's pivot end as a rounded capsule cap, not a hard cutoff. A
    // pocket cradle resting essentially at the base (§1.1's tables: predicted rest sits only
    // ~1mm past the pivot cap) needs exactly this — an unclamped-`t`-only gate would exclude
    // the very geometry H6 predicts, since it clamps to hs=0 rather than reading as "off-segment".
    per[side] = { touching: proj.dist <= threshold, hs: proj.tc };
  }
  const restingSide = per.left.touching ? 'left' : per.right.touching ? 'right' : null;
  const cr = restingSide !== null;
  let cp = 0;
  if (cr) {
    for (const shape of guideShapes) {
      const proj = projectOntoSegment(ballPos, shape.a, shape.b);
      if (proj.dist <= ballRadius + CONTACT_TOL) { cp = 1; break; }
    }
  }
  const cv = per.left.touching && per.right.touching ? 1 : 0;
  return { cr: cr ? 1 : 0, cp, cv, hsS: restingSide ? per[restingSide].hs : null, restingSide };
}
