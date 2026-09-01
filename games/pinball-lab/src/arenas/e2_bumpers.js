// EXPERIMENT 2 arena — bumper field (program handoff §4.1). A fixed (Series A) or grown
// (Series B, §4.2) rectangular field, walls on left/right/top only — the bottom edge is open
// and is the exit boundary (mirrors §3.1's "no bottom wall — y<0 is the drain" pattern, but
// here the crossing is recorded, not a drain). Bumpers are real `Circle` primitives with
// `restitution = E_RUBBER` and `.kick = POP_BUMPER_KICK`, exactly as `table/mechanisms.js`
// builds them — this measures the shipped mechanism, just at an N the game doesn't build.
import { Segment, Circle } from '../../../pinball/src/physics/shapes.js';
import { createWorld, setLayerPrimitives, addBall } from '../../../pinball/src/physics/world.js';
import { E_WALL, E_RUBBER, POP_BUMPER_KICK, BALL_RADIUS } from '../../../pinball/src/physics/constants.js';
import { createHash } from 'node:crypto';
import { seededRng } from '../seed.js';

// Local hash helper (deliberately NOT imported from sweep.js's `cfgId`, which needs to import
// this module's Series A/B sizing functions for its grid builders — importing back would be a
// cycle). Same shape (first 8 hex of sha256 over sorted-key JSON) but scoped to this file's
// tiny layout-seed objects only.
function hashObj(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 8);
}

// §4.1: x∈[−0.257,0.257] (width 0.514), y∈[0.55,1.00] (height 0.45), area 0.514×0.45 =
// 0.2313 m² — Series A's fixed field. Series B grows this (§4.2/buildFieldSizeB below).
export const SERIES_A_FIELD_WIDTH = 0.514;
export const SERIES_A_FIELD_HEIGHT = 0.45;
export const SERIES_A_FIELD_AREA = SERIES_A_FIELD_WIDTH * SERIES_A_FIELD_HEIGHT;

// §4.2: "skirt radius 0.030 m (design §4.3) plus the ball's 0.0135 m gives an effective disc
// of 0.0435 m." Effective-area-fraction arithmetic below is built from these two constants,
// not re-derived per call.
export const NOMINAL_SKIRT_RADIUS = 0.03;
export const SERIES_A_AREA_FRACTION_CAP = 0.4;
export const SERIES_B_AREA_FRACTION = 0.15;

/** §4.2 Series A: `r = min(0.030, r_feasible(N))` where `r_feasible` holds the *effective*
 * (skirt+ball) disc area fraction at <= cap. Solving `N·π·(r+BALL_RADIUS)² = cap·fieldArea`
 * for r. Below N≈13 this returns > 0.030 and the min() picks the nominal pop-bumper size;
 * above it (N=50 in the mandated grid) the field is geometrically too small for 30mm skirts
 * and this returns the constrained value instead — the "pegs, not pops" case §4.2 predicts. */
export function seriesASkirtRadius(N, fieldArea = SERIES_A_FIELD_AREA, cap = SERIES_A_AREA_FRACTION_CAP) {
  const rFeasible = Math.sqrt((cap * fieldArea) / (N * Math.PI)) - BALL_RADIUS;
  return Math.min(NOMINAL_SKIRT_RADIUS, rFeasible);
}

/** Effective (skirt+ball) area fraction the field actually ends up at, for reporting on
 * every row per §4.2 ("no summary reports N without it"). */
export function effectiveAreaFraction(N, radius, fieldArea) {
  const effR = radius + BALL_RADIUS;
  return (N * Math.PI * effR * effR) / fieldArea;
}

// §4.2 Series B (opus2 extension): field GROWS with N holding area fraction fixed at 0.15,
// skirt fixed at the nominal 0.030 m — this is what separates "more bumpers" from "tighter
// bumpers": Series A changes both count and density together (density is capped, not fixed),
// Series B holds density fixed and only count changes. Aspect ratio is held at Series A's
// (0.514:0.45) so the field grows self-similarly rather than becoming oddly shaped.
const SERIES_A_ASPECT = SERIES_A_FIELD_HEIGHT / SERIES_A_FIELD_WIDTH; // height/width
export function seriesBFieldSize(N, radius = NOMINAL_SKIRT_RADIUS, areaFraction = SERIES_B_AREA_FRACTION) {
  const effR = radius + BALL_RADIUS;
  const bumperArea = N * Math.PI * effR * effR;
  const fieldArea = bumperArea / areaFraction;
  const fieldWidth = Math.sqrt(fieldArea / SERIES_A_ASPECT);
  const fieldHeight = SERIES_A_ASPECT * fieldWidth;
  return { fieldWidth, fieldHeight, fieldArea };
}

// Layout placement margins: bumpers must clear the side/top walls by radius+BALL_RADIUS
// (else the wall-Circle gap can't fit a ball), and must clear the BOTTOM (injection) edge by
// a generous fixed margin regardless of N/radius — the P0 lesson (design §11, re-affirmed by
// the program handoff's dispatch log §7.1): "no injection may overlap a primitive". Every
// injected ball spawns exactly on the bottom edge (local y=0); keeping every bumper's centre
// at least this far above that line guarantees the injection point clears every primitive by
// construction, independent of the sampled injection x, so no per-injection collision check
// is needed at trial time (buildE2World still asserts it once per world, cheaply, per §7.1).
const WALL_MARGIN_PAD = 0.005;
const BOTTOM_MARGIN = 0.06; // generous clearance strip for the injection edge

function layoutBounds(fieldWidth, fieldHeight, radius) {
  const marginXY = radius + BALL_RADIUS + WALL_MARGIN_PAD;
  return {
    xMin: -fieldWidth / 2 + marginXY,
    xMax: fieldWidth / 2 - marginXY,
    yMin: BOTTOM_MARGIN, // field-local y, 0 = bottom (injection) edge
    yMax: fieldHeight - marginXY,
  };
}

function layoutSeed(params) {
  return parseInt(hashObj(params).slice(0, 8), 16) >>> 0;
}

/** Dart-throwing Poisson-disc-ish placement: try random points at a target min-spacing,
 * shrinking the spacing (and, if that still doesn't converge, falling back to a deterministic
 * grid scan) until N points are placed — always terminates, unlike a pure rejection sampler,
 * which is what §4.2's high-N/high-area-fraction cells need (N=50 at a 40% fraction is a
 * genuinely tight pack). The spacing floor is `2*radius + eps`: bumpers may end up close
 * enough that a ball can't always pass between them (that IS the phenomenon §4.4/§4.5 are
 * measuring at high area fraction), but never so close their skirts overlap each other. */
function poissonDiscLayout(N, bounds, radius, rng) {
  const { xMin, xMax, yMin, yMax } = bounds;
  const floorSpacing = 2 * radius + 0.001;
  let spacing = Math.max(floorSpacing, 2.2 * (radius + BALL_RADIUS));
  const attemptsPerRound = 3000;
  let points = [];
  for (let round = 0; round < 400; round++) {
    points = [];
    let attempts = 0;
    while (points.length < N && attempts < attemptsPerRound) {
      attempts += 1;
      const x = xMin + rng() * (xMax - xMin);
      const y = yMin + rng() * (yMax - yMin);
      if (points.every((p) => Math.hypot(p.x - x, p.y - y) >= spacing)) points.push({ x, y });
    }
    if (points.length >= N) return points;
    spacing = Math.max(floorSpacing, spacing * 0.95);
    if (spacing <= floorSpacing && points.length < N) break;
  }
  // Fallback: deterministic grid scan at the spacing floor, guarantees termination. Only
  // reachable at extreme density (didn't trigger for the mandated N<=50 grid in testing, but
  // must not throw if a future config pushes past it).
  return gridScanLayout(N, bounds, floorSpacing, rng);
}

function gridScanLayout(N, bounds, spacing, rng) {
  const { xMin, xMax, yMin, yMax } = bounds;
  const jitterX = rng() * spacing * 0.3;
  const jitterY = rng() * spacing * 0.3;
  const points = [];
  for (let y = yMin + jitterY; y <= yMax && points.length < N; y += spacing) {
    for (let x = xMin + jitterX; x <= xMax && points.length < N; x += spacing) {
      points.push({ x, y });
    }
  }
  if (points.length < N) {
    throw new Error(`gridScanLayout: field too small to fit N=${N} bumpers at spacing=${spacing.toFixed(4)} (placed ${points.length})`);
  }
  return points;
}

/** Hex-pack layout (variant 2, "at high N"): points on a hexagonal lattice at the same
 * spacing floor the Poisson-disc variants fall back to, with a small seeded jitter of the
 * lattice origin so it isn't bit-identical across every N/field-size combination that happens
 * to share a spacing. Rows offset by spacing/2, row pitch = spacing*sqrt(3)/2 (standard hex
 * packing). Takes the first N points scanning row-major from a seeded origin offset — not
 * cherry-picked toward the centre, so the layout doesn't secretly become "more centred" than
 * the Poisson-disc variants at the same N. */
function hexPackLayout(N, bounds, radius, rng) {
  const { xMin, xMax, yMin, yMax } = bounds;
  const spacing = Math.max(2 * radius + 0.001, 2.05 * (radius + BALL_RADIUS));
  const rowPitch = spacing * (Math.sqrt(3) / 2);
  const originJitterX = (rng() - 0.5) * spacing;
  const originJitterY = (rng() - 0.5) * rowPitch;
  const points = [];
  let row = 0;
  for (let y = yMin + originJitterY; y <= yMax; y += rowPitch, row++) {
    if (y < yMin) continue;
    const offset = row % 2 === 0 ? 0 : spacing / 2;
    for (let x = xMin + originJitterX + offset; x <= xMax; x += spacing) {
      if (x < xMin) continue;
      points.push({ x, y });
    }
  }
  if (points.length >= N) return points.slice(0, N);
  // Field can't fit N even fully packed at this spacing — fall back to the shrinking
  // Poisson-disc/grid-scan path, which always terminates.
  return poissonDiscLayout(N, bounds, radius, rng);
}

/** `variant`: 0/1 = Poisson-disc (different seeded draws), 2 = hex-pack (§4.2's "3 seeded
 * layout variants ... plus hex-pack at high N" — hex-pack is included as variant 2 for every
 * N, not only "high" N, so every config gets the same three-variant treatment uniformly;
 * "at high N" describes where it matters most, not a gate on when it runs). */
export function generateLayout({ N, fieldWidth, fieldHeight, radius, variant }) {
  const seed = layoutSeed({ N, fieldWidth, fieldHeight, radius, variant });
  const rng = seededRng(seed);
  const bounds = layoutBounds(fieldWidth, fieldHeight, radius);
  if (bounds.xMax <= bounds.xMin || bounds.yMax <= bounds.yMin) {
    throw new Error(`generateLayout: field ${fieldWidth}x${fieldHeight} too small for radius ${radius} (N=${N})`);
  }
  return variant === 2 ? hexPackLayout(N, bounds, radius, rng) : poissonDiscLayout(N, bounds, radius, rng);
}

function buildWalls(fieldWidth, fieldHeight) {
  const halfW = fieldWidth / 2;
  return [
    Segment({ x: -halfW, y: 0 }, { x: -halfW, y: fieldHeight }, E_WALL, 'e2-left'),
    Segment({ x: halfW, y: 0 }, { x: halfW, y: fieldHeight }, E_WALL, 'e2-right'),
    Segment({ x: -halfW, y: fieldHeight }, { x: halfW, y: fieldHeight }, E_WALL, 'e2-top'),
  ];
}

// §4.1: "speed 1.5-4.5 m/s and direction sampled in the up-table half" — taken literally as
// the full upper hemisphere (0-180°, where 0°=+x per the shared angle convention), not
// narrowed further the way E1's INJECTION band was: E1 had to aim at a small fixed flipper
// target, E2's target is the whole field above the injection edge, so the brief's own band is
// already the deliberate choice, not an arbitrary default needing tightening.
export const INJECTION_SPEED = { min: 1.5, max: 4.5 };
export const INJECTION_ANGLE_DEG = { min: 0, max: 180 };

// Generous margin past the field walls — an escapee here is tunneling (§2.7 ESCAPED), not
// play; scales with field size since Series B's field is itself far larger than Series A's.
function arenaBounds(fieldWidth, fieldHeight) {
  const marginX = Math.max(0.3, fieldWidth * 0.5);
  const marginY = Math.max(0.3, fieldHeight * 0.5);
  return {
    xMin: -fieldWidth / 2 - marginX, xMax: fieldWidth / 2 + marginX,
    yMin: -marginY, yMax: fieldHeight + marginY,
  };
}

/**
 * Build a fresh E2 world for one trial. `cfg`: { N, radius, fieldWidth, fieldHeight,
 * layoutVariant, perturbAngleRad? }. Field is local-frame (bottom edge at y=0) purely as an
 * arena-construction convenience — records store real playfield-style coordinates the same
 * way E1 does (this arena just doesn't need to align with the game's actual bumper y's, since
 * §4.1 defines its own field rectangle).
 */
export function buildE2World(cfg) {
  const world = createWorld();
  const centres = generateLayout({
    N: cfg.N, fieldWidth: cfg.fieldWidth, fieldHeight: cfg.fieldHeight,
    radius: cfg.radius, variant: cfg.layoutVariant,
  });

  const bottomEdgeY = 0;
  // §7.1 P0 lesson, asserted once per world (cheap: N circles) rather than trusted from the
  // layout margins alone.
  for (const c of centres) {
    if (c.y - cfg.radius - BALL_RADIUS <= bottomEdgeY) {
      throw new Error(`buildE2World: bumper at (${c.x},${c.y}) overlaps the injection edge`);
    }
  }

  const bumperEntries = centres.map((c, i) => {
    const shape = Circle(c, cfg.radius, E_RUBBER, `e2-bumper-${i}`);
    shape.kick = POP_BUMPER_KICK;
    return { shape, bumper: true };
  });
  const wallEntries = buildWalls(cfg.fieldWidth, cfg.fieldHeight).map((shape) => ({ shape }));
  setLayerPrimitives(world, 'playfield', [...wallEntries, ...bumperEntries]);

  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: bottomEdgeY }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS, active: true });

  return {
    world, ball, exitY: bottomEdgeY,
    bounds: arenaBounds(cfg.fieldWidth, cfg.fieldHeight),
    bumperCount: centres.length,
  };
}
