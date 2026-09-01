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

// Generous margin past the walls/shot-line — a ball out here is tunneling, not playing
// (§2.7's ESCAPED flag; also, per the design doc §11, the largest anti-tunneling test the
// solver will ever get).
export const ARENA_BOUNDS = { xMin: -0.5, xMax: 0.5, yMin: -0.2, yMax: 1.0 };

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
  setLayerPrimitives(world, 'playfield', buildWalls().map((shape) => ({ shape })));

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
  addFlipper(world, left);
  addFlipper(world, right);

  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: SHOT_LINE_Y }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS, active: true });

  return { world, flippers: { left, right }, ball, shotLineY: SHOT_LINE_Y, bounds: ARENA_BOUNDS };
}
