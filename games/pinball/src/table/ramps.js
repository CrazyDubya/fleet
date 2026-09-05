// T5 — ramps, orbits and the SANDBOX scoop. Pure data: builds ramp tracks (physics/ramp.js)
// and their entry gates (physics/shapes.js's Gate) from the design doc's §4.3 coordinates.
// No THREE, no DOM, no mutable module state.
import { Gate } from '../physics/shapes.js';
import { createRampTrack, entryTangent } from '../physics/ramp.js';
import { perp, normalize, scale } from '../physics/vec2.js';
import { RAMP_ENTRY_MIN_SPEED, SCOOP_EJECT } from '../physics/constants.js';
import {
  SW_SLIDE_ENTER, SW_MONKEYBARS_ENTER, SW_TUNNEL_ENTER,
  SW_SANDBOX_ENTRY, SW_SANDBOX_EJECT, SW_DIVERTER_ENTER,
} from './switches.js';

// Hand-off points where each ramp's untracked habitrail puts the ball back on the playfield.
//
// Deviation from §4.3 recorded (2026-09-04, re-aim pass): the first two were authored at the
// doc's coordinates — (-0.150, 0.220) and (-0.130, 0.560) — and neither ball ever reached the
// flipper its own constant is named for. test/mechanism-handoffs.test.mjs measured the misses
// (3.94cm and 2.58cm from the pivot). Both are re-aimed here to land on the middle of the bat;
// the ramps' own tracked geometry, every pivot, and every flipper length/angle are untouched.
// SPRING_RIDER_FEED already connected and is left exactly as authored.
export const LEFT_INLANE_FEED = { x: -0.055, y: 0.17 };
export const UPPER_LEFT_FLIPPER_FEED = { x: -0.095, y: 0.58 };
export const SPRING_RIDER_FEED = { x: -0.05, y: 0.78 };

const GATE_HALF_WIDTH = 0.022;

/** Build a Gate spanning perpendicular to a ramp's own starting direction, centred on its
 * first point — so the gate's line and the ramp's mouth are always geometrically consistent
 * (author the ramp's points; the gate falls out of them). */
function gateForRamp(ramp, tag) {
  const tangent0 = entryTangent(ramp);
  const side = perp(tangent0);
  const start = ramp.points[0];
  const a = { x: start.x - side.x * GATE_HALF_WIDTH, y: start.y - side.y * GATE_HALF_WIDTH };
  const b = { x: start.x + side.x * GATE_HALF_WIDTH, y: start.y + side.y * GATE_HALF_WIDTH };
  return Gate(a, b, tag, { toLayer: ramp.id, allowDir: tangent0, minSpeed: RAMP_ENTRY_MIN_SPEED });
}

/**
 * THE SLIDE. §4.3: entry (-0.060, 0.430) facing up-left, over the top-left, habitrail
 * returns to the LEFT INLANE at (-0.150, 0.220). The climb (24° — moderate, "the main
 * ramp") is the tracked part; the habitrail's own downhill return is the deterministic
 * `exit` hand-off (see physics/ramp.js's doc comment on why).
 *
 * Re-aim (2026-09-04): the §4.3 return point is EXACTLY the left slingshot's top vertex
 * (table/mechanisms.js builds it (-0.150,0.220) -> (-0.135,0.175) -> (-0.100,0.115), kick
 * 3.5), so the authored hand-off dropped the ball onto a kicking surface aimed down-LEFT,
 * away from a left flipper whose bat sweeps RIGHT of its pivot — it never arrived. Keeping
 * the feed in the inlane and only re-aiming was tried first and measured: it can be made to
 * reach the bat, but the slingshot underneath scatters it (mid-bat in 27 of 81 samples over
 * ±3mm/±4°/±0.15m/s). The habitrail is therefore carried past the slingshot and drops the
 * ball onto the bat directly — mid-bat in 66 of the same 81 samples, contact in 81/81.
 * The name is kept; what it denotes is now a habitrail drop over the inlane, not a return
 * into it.
 */
export function buildSlideRamp() {
  const points = [
    { x: -0.06, y: 0.43, z: 0 },
    { x: -0.135, y: 0.62, z: 0.05 },
    { x: -0.215, y: 0.78, z: 0.09 },
    { x: -0.225, y: 0.85, z: 0.1 },
  ];
  const ramp = createRampTrack({
    id: 'slide', points, pitchDeg: 24, friction: 0.45,
    // -75°, onto the middle of the left bat. Was normalize({x:-0.2,y:-1}) at 1.6 m/s.
    exit: { pos: LEFT_INLANE_FEED, dir: normalize({ x: 0.268, y: -1 }), speed: 1.4 },
  });
  return { ramp, gate: gateForRamp(ramp, SW_SLIDE_ENTER) };
}

/**
 * MONKEY BARS. §4.3: entry (0.100, 0.470), crosses overhead right→left, drops to the
 * UPPER-LEFT FLIPPER at (-0.130, 0.560). Steeper (30°) — a real wireform overhead ramp is
 * meant to be the harder shot of the two.
 *
 * Re-aim (2026-09-04): the §4.3 drop point sits up-and-LEFT of the upper-left pivot and the
 * authored aim pointed further left again, so the ball fell down the far side of a bat that
 * extends to the RIGHT of its pivot — 2.58cm away at closest, in every flipper state. The
 * wireform now ends over the bat and drops onto its middle: contact in 81/81 samples over
 * ±3mm/±4°/±0.15m/s, mid-bat in all 81. Speed is unchanged.
 */
export function buildMonkeyBarsRamp() {
  const points = [
    { x: 0.1, y: 0.47, z: 0 },
    { x: 0.02, y: 0.56, z: 0.09 },
    { x: -0.06, y: 0.62, z: 0.12 },
    { x: -0.125, y: 0.6, z: 0.03 },
  ];
  const ramp = createRampTrack({
    id: 'monkeybars', points, pitchDeg: 30, friction: 0.45,
    // -65°, onto the middle of the upper-left bat. Was normalize({x:-0.3,y:-1}).
    exit: { pos: UPPER_LEFT_FLIPPER_FEED, dir: normalize({ x: 0.466, y: -1 }), speed: 1.4 },
  });
  return { ramp, gate: gateForRamp(ramp, SW_MONKEYBARS_ENTER) };
}

/**
 * THE TUNNEL (right orbit). §4.3: x ≈ 0.185, around the top, exits into the spring riders.
 * Shallow (8°) — an orbit is a lateral loop, not a climb.
 *
 * Geometry note (T5, per the T4 handoff's lane-inner finding, and the actual fix tried
 * here): a full-power LEFT-flipper tip shot crosses this region on a ~56°-from-horizontal
 * line (traced at (0.045,0.187) -> (0.089,0.252) -> ... -> (0.233,0.51)) and was clipping
 * the pre-existing `lane-inner` wall square-on, losing ~19% of its speed.
 *
 * First attempt: a physical guide-rail segment placed just inboard of `lane-inner`. Traced
 * and measured worse, not better — at the angle/position tried, the ball met the guide
 * near an endpoint (a near-square hit, not a graze), losing ~40%. Reverted.
 *
 * Actual fix: the orbit's own mouth (`ramp.points[0]`, and therefore its gate — see
 * `gateForRamp`) is placed directly ON that natural trajectory, at (0.135, 0.320) — well
 * before the ball would ever reach `lane-inner`. A full-power tip shot now transitions
 * straight into the 'tunnel' layer without touching any wall at all: "enters the orbit
 * cleanly", the first of the two acceptable outcomes. See the handoff for the re-measured
 * trace. No guide wall — nothing else stands in this flight path to need one.
 */
export function buildTunnelRamp() {
  const points = [
    { x: 0.135, y: 0.32, z: 0.01 },
    { x: 0.24, y: 0.52, z: 0.02 },
    { x: 0.205, y: 0.74, z: 0.02 },
    { x: 0.07, y: 0.88, z: 0.02 },
    { x: -0.05, y: 0.8, z: 0 },
  ];
  const ramp = createRampTrack({
    id: 'tunnel', points, pitchDeg: 8, friction: 0.3,
    exit: { pos: SPRING_RIDER_FEED, dir: normalize({ x: -0.4, y: -1 }), speed: 1.5 },
  });

  return { ramp, gate: gateForRamp(ramp, SW_TUNNEL_ENTER) };
}

/**
 * RAMP DIVERTER (2026-09-05). fs2's own structural mapping named the closest analogue: the
 * existing ramp entry gates, with exactly one wiring stage differing — a diverter's `toLayer`
 * is chosen at runtime by game state, not fixed at construction. No new physics primitive:
 * physics/world.js's `tryEnterGate` already re-reads `zone.gate.toLayer` fresh on every
 * crossing (it's a plain object field, not baked into a closure), so simply MUTATING that
 * field from the game layer makes the SAME Gate object route differently on the next contact.
 * game/mechanisms.js's `setDiverterRoute` is the one place that mutation happens — the same
 * "game layer mutates a field on the shared physics-owned object" pattern
 * `game/mechanisms.js`'s drop-target `.active` flag already uses, not a new mechanism kind.
 *
 * Routes onto two of the table's own EXISTING ramp tracks (`routeARampId`/`routeBRampId`)
 * rather than authoring new ramp geometry: a ramp track has no assumption that only one gate
 * feeds it (`addRamp`/`tryEnterGate` key purely on `ramp.id`), so a second gate onto an
 * already-built, already-measured ramp needs no new exit point to place or verify — it gets
 * that ramp's own tested landing for free. This also means the standing "check clearance
 * against ball diameter + padding" rule has nothing new to check here: a Gate is a Zone
 * (physics/shapes.js), detected only by a straight-line crossing test, never a collision
 * primitive a ball can wedge against — the only genuinely NEW geometry this function
 * introduces is the gate's own mouth, which cannot trap a ball by construction.
 *
 * Placement (0.18, 0.40): a design choice, not a real-machine figure — a real diverter's exact
 * position depends on table layout decisions well beyond this dispatch. Chosen and verified
 * numerically (not eyeballed) to sit clear of every other primitive/zone on the table — nearest
 * neighbour is the `lane-inner` wall at 7.7cm and the tunnel ramp's own gate mouth at 9.4cm,
 * see the handoff for the full clearance scan.
 */
const DIVERTER_HALF_WIDTH = 0.022; // matches gateForRamp's own GATE_HALF_WIDTH convention

export function buildDiverter(routeARampId, routeBRampId) {
  const centre = { x: 0.18, y: 0.4 };
  const allowDir = normalize({ x: -0.3, y: 1 }); // a ball headed up-and-left crosses it
  const side = perp(allowDir);
  const a = { x: centre.x - side.x * DIVERTER_HALF_WIDTH, y: centre.y - side.y * DIVERTER_HALF_WIDTH };
  const b = { x: centre.x + side.x * DIVERTER_HALF_WIDTH, y: centre.y + side.y * DIVERTER_HALF_WIDTH };
  const gate = Gate(a, b, SW_DIVERTER_ENTER, { toLayer: routeARampId, allowDir, minSpeed: RAMP_ENTRY_MIN_SPEED });
  return { gate, routeARampId, routeBRampId };
}

/**
 * THE SANDBOX scoop. §4.3: (-0.010, 0.560), r 0.022; ejects down-left toward the left
 * flipper at SCOOP_EJECT (2.2 m/s), per §9 T5.
 *
 * Re-aim (2026-09-04): "down-left" was taken literally as normalize({x:-0.4,y:-1}) (-111.8°)
 * and threw the ball 9.55cm wide of the pivot, diverging right and never descending to
 * flipper height. Only the direction is changed here: the eject ORIGIN is not free (main.js
 * places the ball at centre + normalize(eject.vel) * radius*1.3, so it follows the aim), the
 * scoop's drawn position is untouched, and the speed is still SCOOP_EJECT.
 *
 * What this feed can and cannot promise, measured rather than assumed: ARRIVAL is reliable —
 * over ±3°/±0.2m/s it reaches the flipper in every sweep state in 35 of 35 samples. WHERE it
 * lands on the bat is not, and no aim fixes that: this is a 45cm unguided flight past the
 * slingshot, and across the 26 headings that arrive at all, the best mid-bat survival found
 * was 5 of 25 perturbations. -94° is chosen for arrival reliability; today it happens to land
 * at 0.32 of the bat at rest and active, 0.88 (near the tip) on a flip-at-arrival. The test
 * therefore asserts arrival for this feed and bat-fraction for the other two.
 */
export function buildSandbox() {
  const centre = { x: -0.01, y: 0.56 };
  const dir = normalize({ x: -0.07, y: -1 });
  return {
    captureZone: { centre, radius: 0.022, tag: SW_SANDBOX_ENTRY },
    eject: { vel: scale(dir, SCOOP_EJECT), tag: SW_SANDBOX_EJECT },
  };
}
