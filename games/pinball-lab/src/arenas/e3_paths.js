// EXPERIMENT 3 arenas — path shapes (program handoff §5, LAB-4). Five families (P1-P5), each
// a parameterised builder sharing the same open apron/drain arena e1_flippers.js/e4_pocket.js
// already use (no flippers here — E3 measures whether a path DELIVERS a ball back to the
// flipper zone, not what a flipper then does with it; that question is E1's, already
// answered). `buildE3World(cfg)` dispatches on `cfg.family`.
//
// Simplification, recorded rather than hidden (this codebase's own convention, e.g.
// e4_pocket.js's CONTACT_TOL note): the real game's ramps/orbits (physics/ramp.js) are 1D
// tracks on their own layer with a deterministic exit hand-off — reusing that machinery here
// would require standing up `world.ramps`/`addRamp` plumbing this lab has no other use for.
// Instead every E3 family (including the orbit, P2) is built as ordinary 2D `playfield`
// geometry (Segment/Arc/Circle, the same primitives E1/E2/E4 already use), stepped by the
// same swept solver — a path is "made" by physically carrying the ball through it, not by a
// scripted layer switch. P4's ramp mouth is the one family that still needs an explicit
// hand-off (a real ramp's mouth-to-exit jump), implemented as a plain non-gate `Zone`
// crossing check in instrument.js's runE3Trial rather than the game's `Gate`/`world.ramps`
// path, since that path requires a registered ramp track this lab doesn't build.
import { Segment, Arc, Circle, Zone } from '../../../pinball/src/physics/shapes.js';
import { createWorld, setLayerPrimitives, setLayerZones, addBall } from '../../../pinball/src/physics/world.js';
import { E_WALL, BALL_RADIUS, GATE_ONE_WAY_THRESHOLD } from '../../../pinball/src/physics/constants.js';

const DEG = Math.PI / 180;

// --- Shared arena shell (verbatim copy of e1_flippers.js's buildWalls — not exported there;
// e4_pocket.js duplicates it for the same reason). No bottom wall: y<0 is the open drain. ---
export const HALF_WIDTH = 0.257;
const WALL_TOP_Y = 0.62;
const APRON_TOP_Y = 0.3;
const APRON_MID_X = 0.205;
const APRON_MID_Y = 0.12;
const APRON_NECK_X = 0.15;
const APRON_NECK_Y = 0.02;
// E1/E4's arenas never need a top wall — every E1/E4 trial terminates at/below the shot line
// (y=0.60) long before a ball could climb this high. E3's families have no such early
// terminal (a family's whole job is to carry a ball across a much larger vertical span), so a
// fast near-vertical shot with nothing above it would climb several METRES under this
// playfield's shallow tilt-gravity before falling back — not a bug, just nothing to catch it.
// A real machine has a top wall (table/recess.js's `top`, at HEIGHT=1.067); this is that wall,
// generalised wide enough (±0.45) to clear every family's own geometry (P2's orbit is the
// widest, reaching ~0.425 off-centre) without slicing through any of it.
const TOP_Y = 1.4;
const TOP_HALF_WIDTH = 0.7;

// Both side walls run all the way to TOP_Y by default (not just WALL_TOP_Y, the way E1/E4's
// arenas stop them — those arenas never send a ball travelling that high; §5's open E3
// families do, especially off a shallow P1 deflector angle or a wide-angle P4 rejection
// bounce). P1's lane and P2's orbit are the only two families whose own extra geometry
// reaches past HALF_WIDTH, and both sit on the right, so those two builders pass
// `rightTopY: WALL_TOP_Y` to leave their own side open below their geometry's height.
function buildSharedWalls({ rightTopY = TOP_Y } = {}) {
  return [
    Segment({ x: -HALF_WIDTH, y: TOP_Y }, { x: -HALF_WIDTH, y: APRON_TOP_Y }, E_WALL, 'left'),
    Segment({ x: HALF_WIDTH, y: rightTopY }, { x: HALF_WIDTH, y: APRON_TOP_Y }, E_WALL, 'right'),
    Segment({ x: -APRON_NECK_X, y: APRON_NECK_Y }, { x: -APRON_MID_X, y: APRON_MID_Y }, E_WALL, 'apron-left'),
    Segment({ x: -APRON_MID_X, y: APRON_MID_Y }, { x: -HALF_WIDTH, y: APRON_TOP_Y }, E_WALL, 'apron-left'),
    Segment({ x: APRON_NECK_X, y: APRON_NECK_Y }, { x: APRON_MID_X, y: APRON_MID_Y }, E_WALL, 'apron-right'),
    Segment({ x: APRON_MID_X, y: APRON_MID_Y }, { x: HALF_WIDTH, y: APRON_TOP_Y }, E_WALL, 'apron-right'),
    Segment({ x: -TOP_HALF_WIDTH, y: TOP_Y }, { x: TOP_HALF_WIDTH, y: TOP_Y }, E_WALL, 'top'),
  ];
}

export const ARENA_BOUNDS = { xMin: -0.85, xMax: 0.85, yMin: -0.2, yMax: 1.55 };

// §5.4's "flipper zone": the y a returning ball must cross to count as "reached the
// flippers" — matches E1's own flipper-pivot height (0.105) plus margin for the flipper's
// swept reach, not the arena's shot line (E1's 0.60 is an OUTBOUND measurement point, well
// above where any of these paths physically terminate).
export const FLIPPER_ZONE_Y = 0.20;
// x classification bands at the flipper zone / drain, per §5.4's feed categories. Centre =
// roughly between the two flipper tips at rest; inlane = within a flipper's real reach
// (E1/E4's flipper length ~0.09m off a pivot at |x|=0.078, so a tip can reach ~|x|<=0.17);
// beyond that but still on the main apron width is "outlane" (off to the side, still visibly
// on the playfield); beyond the apron's own top width (|x|>HALF_WIDTH) is "direct drain" —
// the ball left the main playfield surface entirely (e.g. a failed P1 plunge, still inside
// the launch lane channel).
export const CENTRE_X = 0.05;
export const FLIPPER_REACH_X = 0.17;
export const DEAD_ZONE_SPEED = 0.15; // §5.4: "every position where |v|<0.15 m/s"
export const DEAD_ZONE_BIN_M = 0.01; // 1cm x 1cm bins

/** §5.4 feed classification, from an (x, onMainApron) pair. `onMainApron` is false only for
 * P1's launch-lane channel (x beyond HALF_WIDTH) — everything else in this arena sits within
 * the apron's own width. */
export function classifyFeed(x, onMainApron = true) {
  if (!onMainApron) return 'directDrain';
  const ax = Math.abs(x);
  if (ax <= CENTRE_X) return 'centre';
  if (ax <= FLIPPER_REACH_X) return x < 0 ? 'leftInlane' : 'rightInlane';
  if (ax <= HALF_WIDTH) return x < 0 ? 'leftOutlane' : 'rightOutlane';
  return 'directDrain';
}

// §5.2: "a flipper shot for P2-P5" — a generic launch band standing in for "the ball has just
// left a flipper", the shared entry state P2-P5's injection uses (§5.3's E1 coupling supplies
// speed/angle; x0 is this band's own small per-trial draw, independent of the coupling
// sample, representing where along a flipper's arc the shot actually released).
export const LAUNCH_BAND = { y: FLIPPER_ZONE_Y, xMin: -0.10, xMax: 0.10 };
// §5.3 uniform-prior fallback ranges — set from e1ShotlineCdf.js's own measured range over
// LAB-2's Stage B shotline crossings (speed 0.02-32.4 m/s with mean 2.12, angle 0.4-179.5°
// with mean ~90°; the fallback narrows the speed tail a real flipper rarely produces down to
// E1's OWN inbound sampling band (0.3-4.5 m/s, §3.3) rather than the raw outlier-inclusive
// max, and keeps the full measured angle span).
export const FALLBACK_SPEED = { min: 0.3, max: 4.5 };
export const FALLBACK_ANGLE = { minDeg: 0, maxDeg: 180 };

function rotate(v, deg) {
  const r = deg * DEG;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}
function norm(v) {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

// --- P1: launch lane (§5.1). Params: laneWidth, deflectorAngleDeg, gateThresholdFrac,
// plungerSpeed. Modelled on table/recess.js's real launch lane (inner wall shared with the
// main right wall's x, an outer wall laneWidth further out, a one-way gate) but taller (a
// swept range, not one fixed geometry) and with NO lane floor: a plunge that fails to clear
// the gate just falls back down the open channel and off the bottom (y<0, the shared drain
// convention) — this IS "what a soft plunge does" (§5.1's own question), a real dead-drain
// finding, not an omission.
//
// Deviation, recorded: the deflector is NOT a physical wall the ball must strike. A first
// attempt built one (several anchor points tried); every one of them, verified via
// replay.js --trace, caught a straight-up plunge within a few mm of the plate's own pinned
// end — laneWidth (0.028-0.045m per §5.1) leaves only ~1-9mm clearance around the ball
// (0.027m diameter) either side of centre, so any deflector spanning that channel's mouth is
// unavoidably struck near an endpoint, which the solver resolves as a near-capsule-cap
// contact that kills nearly all the ball's momentum rather than redirecting it — a solver
// artifact of this channel's own tight geometry, not a measurement of the deflector. Instead,
// clearing the lane (§ instrument.js's runE3Trial: reaching LANE_TOP_Y while still moving
// upward, which requires having already passed the one-way gate below it) triggers a direct
// hand-off — the same pattern P4's ramp mouth already uses for its own make/exit — redirecting
// the ball to `deflectorAngleDeg` above horizontal at `LANE_DEFLECTOR_EFFICIENCY` of its
// arrival speed (a modest, documented stand-in for the plate's own restitution, not a
// measured quantity).
export const LANE_BOTTOM_Y = 0.02;
export const LANE_TOP_Y = 0.78;
export const LANE_DEFLECTOR_EFFICIENCY = 0.85;

function buildP1(cfg) {
  const laneInnerX = HALF_WIDTH;
  const laneOuterX = laneInnerX + cfg.laneWidth;
  const gateY = LANE_BOTTOM_Y + cfg.gateThresholdFrac * (LANE_TOP_Y - LANE_BOTTOM_Y);

  // A redirected ball that clears the field's own left wall and bounces back (a shallow
  // deflectorAngleDeg easily sends most of a hard plunge's speed rightward) has nothing
  // containing it on the right (buildSharedWalls' rightTopY leaves that side open below
  // laneTopY for the plunge itself) — close it with a plain boundary well past the lane, the
  // same pattern buildP2 uses for its own orbit-mouth gap.
  const rightBoundary = Segment(
    { x: laneOuterX + 0.25, y: 0.25 }, { x: laneOuterX + 0.25, y: TOP_Y }, E_WALL, 'lane-right-boundary'
  );
  const shapes = [
    ...buildSharedWalls({ rightTopY: WALL_TOP_Y }),
    Segment({ x: laneInnerX, y: LANE_BOTTOM_Y }, { x: laneInnerX, y: LANE_TOP_Y }, E_WALL, 'lane-inner'),
    Segment({ x: laneOuterX, y: LANE_BOTTOM_Y }, { x: laneOuterX, y: LANE_TOP_Y }, E_WALL, 'lane-outer'),
    Segment(
      { x: laneInnerX, y: gateY }, { x: laneOuterX, y: gateY }, E_WALL, 'lane-gate', 0,
      { allow: { x: 0, y: 1 }, threshold: GATE_ONE_WAY_THRESHOLD }
    ),
    rightBoundary,
  ];

  const world = createWorld();
  setLayerPrimitives(world, 'playfield', shapes.map((shape) => ({ shape })));
  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: 0.5 }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS, active: true });

  return {
    world, ball,
    bounds: { ...ARENA_BOUNDS, xMax: laneOuterX + 0.6 },
    injection: {
      mode: 'plunge', x: (laneInnerX + laneOuterX) / 2, y: LANE_BOTTOM_Y + 0.015,
      laneOuterX, laneTopY: LANE_TOP_Y, deflectorAngleDeg: cfg.deflectorAngleDeg,
    },
  };
}

// --- P2: orbit (§5.1). Params: radius, entryAngleDeg, exitTangentDeg, wallRestitution.
// A channel of two concentric Arcs (physics/shapes.js's Arc IS collidable — solver.js's
// sweepCircleArc — unlike the game's own orbit, which is a 1D ramp track; see file header).
// Centred so its default (entryAngleDeg=0) mouth sits close to the real machine's tunnel
// mouth (table/ramps.js buildTunnelRamp: ~(0.135, 0.32)) — not copied from there, just
// verified to land in the same neighbourhood, so a default-parameter shot has a realistic
// chance of finding the mouth at all.
// ---
const ORBIT_CENTRE = { x: 0.17, y: 0.55 };
const ORBIT_CHANNEL_W = 0.12;
const ORBIT_SWEEP_DEG = 230;
const ORBIT_BASE_A0_DEG = -95;
const ORBIT_EXIT_DEFLECTOR_LEN = 0.08;

function buildP2(cfg) {
  const a0 = (ORBIT_BASE_A0_DEG + cfg.entryAngleDeg) * DEG;
  const a1 = a0 + ORBIT_SWEEP_DEG * DEG;
  const outerR = cfg.radius + ORBIT_CHANNEL_W;

  const inner = Arc(ORBIT_CENTRE, cfg.radius, a0, a1, cfg.wallRestitution, 'orbit-inner');
  const outer = Arc(ORBIT_CENTRE, outerR, a0, a1, cfg.wallRestitution, 'orbit-outer');

  // Exit deflector: a short wall at the a1 (far) end, tangent to the channel's mid-radius,
  // rotated by exitTangentDeg — "where does it spit the ball out" (§5.1), made an explicit,
  // swept parameter rather than left to whatever the bare arc end happens to do.
  const midR = cfg.radius + ORBIT_CHANNEL_W / 2;
  const exitPoint = { x: ORBIT_CENTRE.x + midR * Math.cos(a1), y: ORBIT_CENTRE.y + midR * Math.sin(a1) };
  const tangentAtA1 = { x: -Math.sin(a1), y: Math.cos(a1) };
  const deflectorDir = rotate(tangentAtA1, cfg.exitTangentDeg);
  const deflectorEnd = { x: exitPoint.x + deflectorDir.x * ORBIT_EXIT_DEFLECTOR_LEN, y: exitPoint.y + deflectorDir.y * ORBIT_EXIT_DEFLECTOR_LEN };

  // A ball that leaves the channel (e.g. a shallow exit-deflector redirect, or a miss off
  // the mouth entirely) has nothing containing it further right — the shared 'right' wall is
  // deliberately left short here (rightTopY: WALL_TOP_Y) so shots can reach the mouth at all.
  // Verified via replay.js --trace: without a boundary, a slow-drifting ball can take a
  // couple of seconds to wander past even a generous xMax, reading as a spurious ESCAPED
  // rather than the real terminal (stall/drain/reached) it would hit given a real cabinet
  // rail — so this closes the gap a comfortable margin beyond the orbit's own outer edge.
  const rightBoundary = Segment(
    { x: ORBIT_CENTRE.x + outerR + 0.05, y: 0.25 }, { x: ORBIT_CENTRE.x + outerR + 0.05, y: TOP_Y },
    E_WALL, 'orbit-right-boundary'
  );
  const shapes = [...buildSharedWalls({ rightTopY: WALL_TOP_Y }), inner, outer, Segment(exitPoint, deflectorEnd, cfg.wallRestitution, 'orbit-exit-deflector'), rightBoundary];

  const world = createWorld();
  setLayerPrimitives(world, 'playfield', shapes.map((shape) => ({ shape })));
  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: 0.5 }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS, active: true });

  return {
    world, ball,
    bounds: { ...ARENA_BOUNDS, xMax: ORBIT_CENTRE.x + outerR + 0.25 },
    injection: { mode: 'flipperShot' },
  };
}

// --- P3: return lanes (§5.1). Params: guideAngleDeg, laneWidth, postX. Built on BOTH sides
// (mirrored), each an inlane guide wall running from near the top of the apron down toward
// the flipper zone, plus a small post at its mouth — the guide is the inlane/outlane DIVIDER:
// a ball on the guide's centre-ward side falls freely toward the flipper zone (inlane/centre
// feed); a ball trapped between the guide and the arena's own outer wall is confined to a
// narrow strip that drains along the edge (outlane) — no separate outlane wall is needed,
// the existing shared side wall already IS the outlane's outer boundary. `laneWidth` is the
// guide's standoff from that outer wall (the outlane channel's own width); `postX` offsets
// the post from the guide's top end, the actual split-point a ball's exact line depends on.
// ---
const P3_GUIDE_TOP_Y = 0.42;
const P3_GUIDE_LEN = 0.30;
const P3_POST_RADIUS = 0.008;

function buildP3(cfg) {
  const shapes = [...buildSharedWalls()];
  for (const side of [1, -1]) {
    const guideTop = { x: side * (HALF_WIDTH - cfg.laneWidth), y: P3_GUIDE_TOP_Y };
    const angle = cfg.guideAngleDeg * DEG;
    const dir = { x: -side * Math.sin(angle), y: -Math.cos(angle) };
    const guideBottom = { x: guideTop.x + dir.x * P3_GUIDE_LEN, y: guideTop.y + dir.y * P3_GUIDE_LEN };
    shapes.push(Segment(guideTop, guideBottom, E_WALL, `guide-${side === 1 ? 'L' : 'R'}`));
    const post = { x: guideTop.x + side * cfg.postX, y: guideTop.y - 0.02 };
    shapes.push(Circle(post, P3_POST_RADIUS, 0.5, `post-${side === 1 ? 'L' : 'R'}`));
  }

  const world = createWorld();
  setLayerPrimitives(world, 'playfield', shapes.map((shape) => ({ shape })));
  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: 0.5 }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS, active: true });

  return { world, ball, bounds: ARENA_BOUNDS, injection: { mode: 'flipperShot' } };
}

// --- P4: ramp mouth (§5.1). Params: mouthWidth, approachAngleDeg, rampMinSpeed. A funnel
// (two flared walls narrowing to a throat) plus a plain (non-gate) Zone at the throat —
// instrument.js's runE3Trial does the make/reject check itself (see file header for why this
// doesn't use the game's Gate/world.ramps path) and, on a made shot, hands the ball off to a
// fixed exit state (mirroring how a real ramp's `exit` in physics/ramp.js works: position,
// direction, speed, chosen once and recorded, not re-derived from the shot). A REJECTED shot
// (reaches the throat under `rampMinSpeed`, or from the wrong side) needs no special code —
// the funnel walls are ordinary solid geometry, so it just bounces back into the field like
// any other wall hit; that IS "what a rejected shot does" (§5.1's own question).
// ---
const P4_MOUTH_CENTRE = { x: 0.05, y: 0.45 };
const P4_FUNNEL_LEN = 0.07;
const P4_FUNNEL_FLARE = 0.05;
const P4_EXIT = { pos: { x: -0.13, y: 0.50 }, dir: norm({ x: -0.3, y: -1 }), speed: 1.5 };

function buildP4(cfg) {
  const approach = cfg.approachAngleDeg * DEG;
  const normal = { x: Math.sin(approach), y: Math.cos(approach) }; // "into the ramp"
  const side = { x: normal.y, y: -normal.x };
  const half = cfg.mouthWidth / 2;
  const gateA = { x: P4_MOUTH_CENTRE.x - side.x * half, y: P4_MOUTH_CENTRE.y - side.y * half };
  const gateB = { x: P4_MOUTH_CENTRE.x + side.x * half, y: P4_MOUTH_CENTRE.y + side.y * half };
  const funnelA = { x: gateA.x - normal.x * P4_FUNNEL_LEN - side.x * P4_FUNNEL_FLARE, y: gateA.y - normal.y * P4_FUNNEL_LEN - side.y * P4_FUNNEL_FLARE };
  const funnelB = { x: gateB.x - normal.x * P4_FUNNEL_LEN + side.x * P4_FUNNEL_FLARE, y: gateB.y - normal.y * P4_FUNNEL_LEN + side.y * P4_FUNNEL_FLARE };

  const shapes = [
    ...buildSharedWalls(),
    Segment(funnelA, gateA, E_WALL, 'ramp-funnel-a'),
    Segment(funnelB, gateB, E_WALL, 'ramp-funnel-b'),
  ];
  const zones = [Zone(gateA, gateB, 'ramp-mouth')];

  const world = createWorld();
  setLayerPrimitives(world, 'playfield', shapes.map((shape) => ({ shape })));
  setLayerZones(world, 'playfield', zones);
  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: 0.5 }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS, active: true });

  return {
    world, ball, bounds: ARENA_BOUNDS,
    injection: { mode: 'flipperShot' },
    gate: { allowDir: normal, minSpeed: cfg.rampMinSpeed, exit: P4_EXIT },
  };
}

// --- P5: habitrail drop (§5.1). Params: dropX, dropY, dropSpeed, dropDirectionDeg — these
// ARE the injection state (no extra geometry: the arena is the bare shared shell). Recorded
// deviation from §5.3: P5 does NOT consume the E1 shot-line coupling. §5.3's coupling models
// "a flipper's outbound shot", but a habitrail drop's whole premise is a ball arriving from
// an overhead return that a flipper never touched — its speed/direction are themselves the
// swept study variables (§5.1's own table), not a quantity to source from E1. Applying the
// coupling here anyway would silently overwrite the very parameters this family exists to
// sweep, so it's called out explicitly rather than applied inconsistently.
// ---
function buildP5() {
  const world = createWorld();
  setLayerPrimitives(world, 'playfield', buildSharedWalls().map((shape) => ({ shape })));
  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: 0.5 }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS, active: true });
  return { world, ball, bounds: ARENA_BOUNDS, injection: { mode: 'directDrop' } };
}

export function buildE3World(cfg) {
  if (cfg.family === 'P1') return buildP1(cfg);
  if (cfg.family === 'P2') return buildP2(cfg);
  if (cfg.family === 'P3') return buildP3(cfg);
  if (cfg.family === 'P4') return buildP4(cfg);
  if (cfg.family === 'P5') return buildP5(cfg);
  throw new Error(`buildE3World: unknown family '${cfg.family}'`);
}
