// EXPERIMENT 1 arena — flippers only (program handoff §3.1). Pure data/construction, no
// side effects beyond building the world object the caller steps. Reuses the real lower-table
// geometry (table/recess.js's converging apron) and the shipped `createFlipper`/flipper
// collision path, so results transfer to the game rather than measuring a stand-in.
import { Segment } from '../../../pinball/src/physics/shapes.js';
import { createFlipper } from '../../../pinball/src/physics/flipper.js';
import { createWorld, setLayerPrimitives, addFlipper, addBall } from '../../../pinball/src/physics/world.js';
import { E_WALL, FLIPPER, BALL_RADIUS } from '../../../pinball/src/physics/constants.js';

// §3.1: side walls x=±0.257 from y=0.62 down to y=0.30, then the converging apron from
// table/recess.js, mirrored. No bottom wall — y<0 is the drain. Open at the top.
const HALF_WIDTH = 0.257;
const WALL_TOP_Y = 0.62;
const APRON_TOP_Y = 0.3;
const APRON_MID_X = 0.205;
const APRON_MID_Y = 0.12;
const APRON_NECK_X = 0.15;
const APRON_NECK_Y = 0.02;

export const SHOT_LINE_Y = 0.6;
export const LEFT_PIVOT = { x: -0.078, y: 0.105 };
export const RIGHT_PIVOT = { x: 0.078, y: 0.105 };

const DEG = Math.PI / 180;
// e4_pocket.js's §2.5 assertion 1 standard (its own comment: "1mm safety margin"), reused here
// verbatim rather than re-derived — LAB-14 closes this file's own gap (no build-time geometry
// check existed at all) to the same standard e4_pocket.js already holds its OWN new shapes to.
const FOUL_MARGIN = 0.001;

function pointToSegmentDistance(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx, cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Verbatim port of e4_pocket.js's `assertNoFoul` (not imported — e4_pocket.js imports FROM
 * this file, so the dependency can't run the other way; e4_pocket.js's own header already
 * documents this same duplicate-rather-than-import pattern for `buildWalls`). Segments only
 * here (E1 has no circles), so the shape-clearance step is `pointToSegmentDistance` directly
 * rather than e4_pocket.js's kind-dispatching `pointToShapeClearance`. */
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
        const clearance = pointToSegmentDistance(p, shape.a, shape.b) - (shape.padding || 0);
        if (clearance <= radius + FOUL_MARGIN) {
          throw new Error(
            `buildE1World: shape '${shape.tag}' fouls the flipper sweep at angle ${angleDeg.toFixed(1)}° ` +
            `(clearance ${clearance.toFixed(4)}m <= ${(radius + FOUL_MARGIN).toFixed(4)}m)`
          );
        }
      }
    }
  }
}

// Generous margin past the walls/shot-line — a ball out here is tunneling, not playing
// (§2.7's ESCAPED flag; also, per the design doc §11, the largest anti-tunneling test the
// solver will ever get).
export const ARENA_BOUNDS = { xMin: -0.5, xMax: 0.5, yMin: -0.2, yMax: 1.0 };

// §3.3 inbound sampling band, per §2.4a: chosen against the shot line and the flipper
// geometry above rather than left an arbitrary wide default. At rest each flipper's tip sits
// at pivot + length*(cos(restAngle), sin(restAngle)) ≈ x∈[-0.078,-0.030] (left) /
// [0.030,0.078] (right), y≈0.048-0.105 — a narrow target ~0.5m below the shot line.
// Measured honestly, not asserted: with LAB-1's original ±0.20/190-350° band and the §2.4a
// RNG fix applied, the `never`-policy baseline already clears the 30% floor (~56% over
// 5,000 seeds) — the pilot's near-zero contact counts were entirely the degenerate-RNG bug,
// not a geometry problem. `xMin`/`xMax`/the angle range are narrowed here anyway (still
// ~52% contact rate, same order, over the same 5,000 seeds) because "use the shot line and
// the flipper geometry to choose the band" reads as a design instruction to aim
// deliberately at the flippers, not merely to clear the floor by whatever margin the
// original arbitrary range happened to leave.
export const INJECTION = {
  xMin: -0.1, xMax: 0.1,
  speedMin: 0.3, speedMax: 4.5,
  angleMinDeg: 200, angleMaxDeg: 340,
};

// §3.5 cradle family injection: "delivered down the inlane line at 0.6-1.8 m/s" while both
// flippers are held active from t=0. Centred over the pivot span so the ball actually lands
// on a raised flipper capsule rather than passing between them; angle band is near-straight-
// down (270° = -y) with enough spread to land anywhere along either capsule, not just its tip.
export const CRADLE_INJECTION = {
  xMin: -0.05, xMax: 0.05,
  speedMin: 0.6, speedMax: 1.8,
  angleMinDeg: 260, angleMaxDeg: 280,
};

/** ω(t) profiles (§2.2/§3.3): each is a rate multiplier over u = fraction of the up-stroke
 * travelled, pre-normalised so its mean over u in [0,1] is exactly 1 — the sweep completes in
 * ~upMs under every profile, only the shape of the rate curve differs. Verified analytically
 * (see each profile's comment); test/omegaProfile.test.mjs also checks it numerically. */
export const OMEGA_PROFILES = {
  // Undefined is the "no profile" default (bit-identical to pre-§2.2 RECESS); 'constant' is
  // the same shape made explicit, for cfgs that want to name it rather than omit it.
  constant: () => 1,
  // Coil-like: fast off the stop, decelerating into the end. Linear 2 -> 0; ∫ = 1.
  easeOut: (u) => 2 * (1 - u),
  // Slow off the stop, accelerating into the end. Linear 0 -> 2; ∫ = 1.
  easeIn: (u) => 2 * u,
  // Slow-fast-slow, symmetric: derivative of the 3u²-2u³ smoothstep. Peaks at u=0.5; ∫ = 1.
  sCurve: (u) => 6 * u * (1 - u),
};

function buildWalls() {
  return [
    Segment({ x: -HALF_WIDTH, y: WALL_TOP_Y }, { x: -HALF_WIDTH, y: APRON_TOP_Y }, E_WALL, 'left'),
    Segment({ x: HALF_WIDTH, y: WALL_TOP_Y }, { x: HALF_WIDTH, y: APRON_TOP_Y }, E_WALL, 'right'),
    Segment({ x: -HALF_WIDTH, y: APRON_TOP_Y }, { x: -APRON_MID_X, y: APRON_MID_Y }, E_WALL, 'apron-left'),
    Segment({ x: -APRON_MID_X, y: APRON_MID_Y }, { x: -APRON_NECK_X, y: APRON_NECK_Y }, E_WALL, 'apron-left'),
    Segment({ x: HALF_WIDTH, y: APRON_TOP_Y }, { x: APRON_MID_X, y: APRON_MID_Y }, E_WALL, 'apron-right'),
    Segment({ x: APRON_MID_X, y: APRON_MID_Y }, { x: APRON_NECK_X, y: APRON_NECK_Y }, E_WALL, 'apron-right'),
  ];
}

/**
 * Build a fresh E1 world for one trial. `cfg`: { restAngleDeg, activeAngleDeg, upMs, radius,
 * restitution, omegaProfile? }. `downMs` is fixed at the real RECESS value (§3.3 only sweeps
 * upMs) and `length`/`side` are the shipped lower-flipper geometry.
 */
export function buildE1World(cfg) {
  const world = createWorld();
  const wallShapes = buildWalls();
  setLayerPrimitives(world, 'playfield', wallShapes.map((shape) => ({ shape })));

  const omegaProfile = cfg.omegaProfile ? OMEGA_PROFILES[cfg.omegaProfile] : undefined;
  if (cfg.omegaProfile && !omegaProfile) throw new Error(`unknown omegaProfile '${cfg.omegaProfile}'`);

  const left = createFlipper({
    pivot: LEFT_PIVOT, length: FLIPPER.lower.length, radius: cfg.radius,
    restAngleDeg: cfg.restAngleDeg, activeAngleDeg: cfg.activeAngleDeg,
    upMs: cfg.upMs, downMs: FLIPPER.lower.downMs, side: 1, restitution: cfg.restitution, tag: 'flipper-left',
  });
  const right = createFlipper({
    pivot: RIGHT_PIVOT, length: FLIPPER.lower.length, radius: cfg.radius,
    restAngleDeg: 180 - cfg.restAngleDeg, activeAngleDeg: 180 - cfg.activeAngleDeg,
    upMs: cfg.upMs, downMs: FLIPPER.lower.downMs, side: -1, restitution: cfg.restitution, tag: 'flipper-right',
  });
  if (omegaProfile) {
    left.omegaProfile = omegaProfile;
    right.omegaProfile = omegaProfile;
  }
  // §2.5 assertion 1, applied to E1's own walls — the "always clear by construction" assumption
  // e4_pocket.js's header names when it skips this same check on these same shapes (LAB-14).
  assertNoFoul(wallShapes, { pivot: LEFT_PIVOT, restAngleDeg: cfg.restAngleDeg, activeAngleDeg: cfg.activeAngleDeg, length: FLIPPER.lower.length, radius: cfg.radius });
  assertNoFoul(wallShapes, { pivot: RIGHT_PIVOT, restAngleDeg: 180 - cfg.restAngleDeg, activeAngleDeg: 180 - cfg.activeAngleDeg, length: FLIPPER.lower.length, radius: cfg.radius });

  addFlipper(world, left);
  addFlipper(world, right);

  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: SHOT_LINE_Y }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS, active: true });

  return { world, flippers: { left, right }, ball, shotLineY: SHOT_LINE_Y, bounds: ARENA_BOUNDS };
}
