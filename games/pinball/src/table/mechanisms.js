// T4 scoring mechanisms — pure data, per design doc §4.2/§4.3. Each builder returns plain
// collision/zone descriptors; no THREE, no DOM, no mutable module state (drop-target
// "dropped" state lives in src/game/mechanisms.js, which owns the shape objects returned
// here and toggles their `.active` flag at runtime).
import { Circle, Segment, Zone } from '../physics/shapes.js';
import { E_RUBBER, POP_BUMPER_KICK, SLINGSHOT_KICK, BALL_RADIUS } from '../physics/constants.js';
import { normalize } from '../physics/vec2.js';
import {
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  SW_HOPSCOTCH, SW_SAND,
  SW_TREEHOUSE,
  SW_FUN,
  SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
  SW_MERRY_GO_ROUND,
} from './switches.js';

const POP_SKIRT_RADIUS = 0.03;

/** Spring riders — pop bumpers. §4.3: duck (-0.075,0.760), horse (-0.005,0.815), rocket (-0.100,0.860). */
export function buildPopBumpers() {
  const specs = [
    { name: 'duck', tag: SW_POP_DUCK, centre: { x: -0.075, y: 0.76 } },
    { name: 'horse', tag: SW_POP_HORSE, centre: { x: -0.005, y: 0.815 } },
    { name: 'rocket', tag: SW_POP_ROCKET, centre: { x: -0.1, y: 0.86 } },
  ];
  return specs.map((s) => {
    const shape = Circle(s.centre, POP_SKIRT_RADIUS, E_RUBBER, s.tag);
    shape.kick = POP_BUMPER_KICK;
    return { ...s, shape };
  });
}

/**
 * Swing-set slingshots. §4.3 gives apexes at (∓0.135, 0.175); we model each as the two
 * outer faces of a shallow kite (apex -> inlane feed, apex -> flipper pivot area) so the
 * ball can be kicked from either face, mirroring a real kite slingshot's two rubber faces.
 */
export function buildSlingshots() {
  const left = [
    Segment({ x: -0.15, y: 0.22 }, { x: -0.135, y: 0.175 }, E_RUBBER, SW_SLING_LEFT),
    Segment({ x: -0.135, y: 0.175 }, { x: -0.1, y: 0.115 }, E_RUBBER, SW_SLING_LEFT),
  ];
  const right = [
    Segment({ x: 0.15, y: 0.22 }, { x: 0.135, y: 0.175 }, E_RUBBER, SW_SLING_RIGHT),
    Segment({ x: 0.135, y: 0.175 }, { x: 0.1, y: 0.115 }, E_RUBBER, SW_SLING_RIGHT),
  ];
  for (const seg of [...left, ...right]) seg.kick = SLINGSHOT_KICK;
  return { left, right };
}

/**
 * A row of drop targets: thin segments perpendicular to the bank's line direction, spaced
 * by `pitch` along a line through `centre` angled at `angleDeg` (0 = vertical row, i.e.
 * targets stacked along +y; §4.3's "pitch 0.028, line angled +15°" reads as the row axis
 * rotated 15° from vertical).
 */
function buildTargetRow(id, tags, centre, pitch, angleDeg, targetWidth = 0.018) {
  const rad = (angleDeg * Math.PI) / 180;
  const axis = { x: Math.sin(rad), y: Math.cos(rad) }; // row direction
  const perp = { x: Math.cos(rad), y: -Math.sin(rad) }; // target face direction
  const n = tags.length;
  const start = -(n - 1) / 2;
  const targets = tags.map((tag, i) => {
    const off = (start + i) * pitch;
    const cx = centre.x + axis.x * off;
    const cy = centre.y + axis.y * off;
    const a = { x: cx - perp.x * targetWidth, y: cy - perp.y * targetWidth };
    const b = { x: cx + perp.x * targetWidth, y: cy + perp.y * targetWidth };
    const shape = Segment(a, b, 0.25, tag);
    return { tag, shape, centre: { x: cx, y: cy } };
  });
  return { id, targets };
}

/** HOPSCOTCH 1-2-3-4 bank. §4.3: centred (0.055, 0.640), pitch 0.028, angled +15°. */
export function buildHopscotchBank() {
  return buildTargetRow('hopscotch', SW_HOPSCOTCH, { x: 0.055, y: 0.64 }, 0.028, 15);
}

/**
 * S-A-N-D bank. §4.3: centred (0.175, 0.560), near-vertical. Built as 4 targets (S,A,N,D)
 * — see the deviation note in table/switches.js.
 */
export function buildSandBank() {
  return buildTargetRow('sand', SW_SAND, { x: 0.175, y: 0.56 }, 0.026, 3);
}

/** TREEHOUSE standup. §4.3: (0.010, 0.965). A fixed post — hit registers, never drops. */
export function buildTreehouseStandup() {
  return { tag: SW_TREEHOUSE, shape: Circle({ x: 0.01, y: 0.965 }, 0.012, 0.3, SW_TREEHOUSE) };
}

/**
 * F-U-N top rollover lanes. §4.3: y ≈ 0.985 at x = -0.06, 0.00, +0.06. Each lane is a short
 * crossing zone spanning the lane's width so a ball rolling through registers exactly once.
 */
export function buildFunLanes() {
  const y = 0.985;
  const xs = [-0.06, 0.0, 0.06];
  const halfWidth = 0.018;
  return xs.map((x, i) => ({
    tag: SW_FUN[i],
    zone: Zone({ x: x - halfWidth, y }, { x: x + halfWidth, y }, SW_FUN[i]),
  }));
}

/**
 * TETHERBALL (left orbit lane, x≈-0.170, y 0.30→0.46) and PINWHEEL (at the SLIDE mouth,
 * ~(-0.060, 0.430)) spinners. Modelled as short crossing zones the ball passes through
 * repeatedly as it rolls up/down the lane; each crossing is one "click"/revolution.
 */
export function buildSpinners() {
  const tetherball = Zone({ x: -0.178, y: 0.38 }, { x: -0.162, y: 0.38 }, SW_TETHERBALL_SPIN);
  const pinwheel = Zone({ x: -0.075, y: 0.43 }, { x: -0.045, y: 0.43 }, SW_PINWHEEL_SPIN);
  return { tetherball, pinwheel };
}

/**
 * MERRY-GO-ROUND lock (T8). §4.3: centre (0.010, 0.900), r 0.075, fed from the top orbit
 * (THE TUNNEL). Modelled as a capture zone, same pattern as the SANDBOX scoop — the ball
 * always physically settles into it on entry; rules/multiball.js decides afterwards whether
 * that's a genuine lock, a re-lock jackpot escalator, or an unlit pass-through that gets
 * kicked straight back out (world.js's checkCaptures doesn't gate on game state, deliberately
 * matching the SANDBOX scoop's existing shape rather than adding a second capture pattern).
 *
 * Geometry deviation, recorded: §4.3's tunnel exit (table/ramps.js's buildTunnelRamp,
 * frozen by T5/T5b) dumps at SPRING_RIDER_FEED (-0.050, 0.780) heading down-left into the
 * spring riders, not directly at (0.010, 0.900) — reworking a T5 ramp exit is out of this
 * task's scope. The merry-go-round sits just past the spring riders on the natural rebound
 * line up toward TREEHOUSE, so "fed from the top orbit" reads as "reachable off a tunnel
 * shot", not "the tunnel's exit point is inside it" — the same kind of deviation T4/T5
 * recorded for the lane-inner clip and the tunnel gate placement.
 */
export function buildMerryGoRound() {
  const centre = { x: 0.01, y: 0.9 };
  const radius = 0.075;
  return { centre, radius, captureZone: { centre, radius, tag: SW_MERRY_GO_ROUND } };
}

// Design doc's own preferred release heading — down/in toward the main field, away from the
// spring-rider cluster it was originally (wrongly) never checked against. Kept as the
// starting point so an unobstructed table still gets the intended-looking release.
const MGR_RELEASE_PREFERRED_HEADING = normalize({ x: -0.15, y: -1 });

/**
 * Where a ball leaves the merry-go-round — a genuine 3-lock release, a re-lock ejection
 * during active multiball, or an unlit pass-through. Derived from the current table layout
 * instead of a hardcoded constant, so a future mechanism-layout change can't silently
 * reintroduce a ball landing back inside another mechanism's collision skirt.
 *
 * This exists because of a real bug: the previous hardcoded (-0.15, -1) heading was chosen
 * only to clear the merry-go-round's own capture radius (a 1.05x margin) and was never
 * checked against anything else. It landed 7.85mm inside the horse spring-rider's 30mm
 * skirt — every release/relock ball spawned already overlapping the pop bumper, which
 * re-kicked it back into the merry-go-round's capture zone, which re-doubled an uncapped
 * jackpot, forever (500,000 -> 1.757e+165 in ~5s, confirmed live). See the 2026-09-01 P0
 * handoff for the full trace.
 *
 * `obstacles` is every other circular mechanism skirt the landing point must clear —
 * `{ centre, radius }` pairs — e.g. the pop bumpers' skirts, the TREEHOUSE standup, the
 * SANDBOX scoop's capture zone. `margin` on top of each obstacle's own radius accounts for
 * the ball's own footprint (defaults to BALL_RADIUS) so the ball doesn't spawn edge-touching
 * a skirt either.
 *
 * Starts from the design doc's preferred heading; if that lands inside some obstacle's
 * skirt+margin, sweeps outward from it in 1-degree steps (alternating either side) to the
 * nearest heading that clears every obstacle. Throws if literally nothing within 180 degrees
 * clears — that would mean the merry-go-round is boxed in by the layout itself, a table-design
 * problem no release heading can paper over.
 */
export function computeMergeGoRoundRelease(mgr, obstacles, margin = BALL_RADIUS) {
  const clear = mgr.radius * 1.05;
  const landingFor = (heading) => ({
    x: mgr.centre.x + heading.x * clear,
    y: mgr.centre.y + heading.y * clear,
  });
  const clearsAll = (heading) => {
    const p = landingFor(heading);
    return obstacles.every((o) => Math.hypot(p.x - o.centre.x, p.y - o.centre.y) >= o.radius + margin);
  };

  if (clearsAll(MGR_RELEASE_PREFERRED_HEADING)) {
    return { heading: MGR_RELEASE_PREFERRED_HEADING, pos: landingFor(MGR_RELEASE_PREFERRED_HEADING) };
  }

  const baseAngle = Math.atan2(MGR_RELEASE_PREFERRED_HEADING.y, MGR_RELEASE_PREFERRED_HEADING.x);
  for (let deg = 1; deg <= 180; deg++) {
    for (const sign of [1, -1]) {
      const angle = baseAngle + (sign * deg * Math.PI) / 180;
      const heading = { x: Math.cos(angle), y: Math.sin(angle) };
      if (clearsAll(heading)) return { heading, pos: landingFor(heading) };
    }
  }
  throw new Error('computeMergeGoRoundRelease: no heading within 180 degrees clears every mechanism skirt');
}
