// T5 — ramps, orbits and the SANDBOX scoop. Pure data: builds ramp tracks (physics/ramp.js)
// and their entry gates (physics/shapes.js's Gate) from the design doc's §4.3 coordinates.
// No THREE, no DOM, no mutable module state.
import { Gate } from '../physics/shapes.js';
import { createRampTrack, entryTangent } from '../physics/ramp.js';
import { perp, normalize, scale } from '../physics/vec2.js';
import { RAMP_ENTRY_MIN_SPEED, SCOOP_EJECT } from '../physics/constants.js';
import {
  SW_SLIDE_ENTER, SW_MONKEYBARS_ENTER, SW_TUNNEL_ENTER, SW_ORBIT_ENTER,
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
 * the feed in the inlane and only re-aiming was tried first and measured against that
 * rejected config: it can be made to reach the bat, but the slingshot underneath scatters it
 * (mid-bat in 27 of 81 samples over ±3mm/±4°/±0.15m/s — this config was abandoned, so this
 * figure is historical and was not re-measured). The habitrail is therefore carried past the
 * slingshot and drops the ball onto the bat directly. The name is kept; what it denotes is
 * now a habitrail drop over the inlane, not a return into it.
 *
 * Contact in 81/81 of the same 81-sample sweep (±3mm/±4°/±0.15m/s × 3 flipper states),
 * mid-bat in 81/81 — re-measured 2026-09-05 (STALE-1 audit) against today's HEAD. Corrects a
 * stale "mid-bat in 66 of 81" recorded 2026-09-04 (commit c2ac18e): the geometry has not
 * changed since, but the METHOD has — commit d901cbf the next day fixed how the
 * 'flip-at-arrival' flipper state is simulated (a mid-swing catch is now genuinely resolved
 * against the sweeping capsule, not folded into 'active'; that commit's own message reports
 * this exact feed's alongBat moving from 0.464 to 0.590 for one flipper state). 66/81 was a
 * correct count under the superseded pre-fix method, not a wrong measurement at the time.
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
 *
 * Re-measured 2026-09-05 (STALE-1 audit, same sweep against today's HEAD, post the
 * 'flip-at-arrival' methodology fix d901cbf): 81/81 contact, 81/81 mid-bat. Confirmed,
 * unchanged.
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
 *
 * STALE-1 audit (2026-09-05): the ~19% and ~40% speed-loss figures above describe two
 * configurations neither of which exists in this file any more (the pre-move mouth position,
 * and a guide-rail segment that was tried and reverted) — there is no current code path to
 * re-measure them against, and they predate the flip-at-arrival methodology fix entirely
 * (this mechanism doesn't involve a flipper). Left as historical record of why the actual
 * fix was chosen, not re-verified.
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
 * THE ORBIT (full orbit, left-to-right). fs2's own structural mapping named the closest
 * analogue: the tunnel ramp above is already described as "a lateral loop" — no new physics
 * primitive is needed for a second one; ramp tracks already support arbitrary loop geometry.
 * A real orbit sends the ball around the outside of the playfield and back to the OPPOSITE
 * flipper, which is the shot that makes a table feel fast; this models that directly, entering
 * on the left and exiting toward the right flipper's side, mirroring the tunnel's own "enter
 * one side, climb, cross the top" shape but returning to the other flipper rather than into
 * the spring riders.
 *
 * Entry (-0.135, 0.32): open field directly above the left apron's own top corner (recess.js's
 * APRON_TOP_Y=0.3) — the same height tunnel's own entry sits at on the right, and, like it,
 * bounded only by the plain outer wall (recess.js's 'left' segment, 10.8cm away) with nothing
 * else nearby. No real-machine source for the exact figure; a design choice, same footing as
 * every other unsourced placement this project records plainly.
 *
 * ORBIT_EXIT_FEED (0.08, 0.25): verified clear of every collider on the table (nearest: the
 * right slingshot at 6.3cm ball-surface clearance, the outlane divider at 11.7cm) before being
 * chosen — not eyeballed. This is a design choice for WHERE the ball re-enters open play, aimed
 * toward the right flipper's general area.
 *
 * Reachability closed out (2026-09-05, test/orbit-reachability.test.mjs): the same 81-sample
 * sweep methodology this file's own SLIDE/MONKEY BARS comments record (±3mm position, ±4°
 * direction, ±0.15 m/s speed, × 3 flipper states) — 81/81 contact, 46/81 mid-bat. No re-aim
 * needed; every sampled condition reaches the right flipper. This now carries the same measured
 * guarantee LEFT_INLANE_FEED/UPPER_LEFT_FLIPPER_FEED do, not just a verified-safe landing spot.
 *
 * STALE-1 audit (2026-09-05): this figure was recorded (commit 59911cf, 08:32) shortly before
 * the 'flip-at-arrival' methodology fix (d901cbf, 09:00) — the same ordering that made SLIDE's
 * figure stale. Re-run against today's HEAD: still 81/81 contact, 46/81 mid-bat, unchanged.
 * Unlike SLIDE, this feed's numbers happen to survive the fix.
 */
export const ORBIT_EXIT_FEED = { x: 0.08, y: 0.25 };

export function buildOrbitRamp() {
  const points = [
    { x: -0.135, y: 0.32, z: 0.01 },
    { x: -0.22, y: 0.55, z: 0.03 },
    { x: -0.2, y: 0.78, z: 0.05 },
    { x: 0.0, y: 0.92, z: 0.05 },
    { x: 0.19, y: 0.75, z: 0.03 },
    { x: 0.2, y: 0.5, z: 0.01 },
  ];
  const ramp = createRampTrack({
    id: 'orbit', points, pitchDeg: 10, friction: 0.35,
    exit: { pos: ORBIT_EXIT_FEED, dir: normalize({ x: -0.15, y: -1 }), speed: 1.6 },
  });
  return { ramp, gate: gateForRamp(ramp, SW_ORBIT_ENTER) };
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
 *
 * Re-checked (2026-09-05, an outside review asked whether 0.88 was stale, since a same-week
 * trace of other feeds' flip-at-arrival state showed it settling to the SAME angularVel=0 as a
 * statically-active flipper by the moment of contact): confirmed live, unchanged — rest 0.325,
 * active 0.324, flip-at-arrival 0.879. It is real, and here is why it is not the same as
 * active despite both ending at angularVel=0: `physics/world.js` sub-steps 24x internally, in
 * one `advance()` call, for every tick a flipper is moving, so the ball is resolved against the
 * flipper's SWEEPING capsule during the ~14ms stroke — a moving bat intercepts the ball's path
 * at a different point than a bat that sat still at either endpoint the whole time, even though
 * the swing has JUST finished by the instant contact is reported. Reaching angularVel=0 at
 * contact means the swing happened to complete right around when the ball arrived, not that
 * the ball's whole approach saw a motionless bat. See mechanism-handoffs.test.mjs's
 * towardFlipper for the fuller measurement across other feeds, including a prior mistaken
 * conclusion on this exact point (corrected there).
 *
 * STALE-1 audit (2026-09-05): re-checked the whole paragraph above against today's HEAD.
 * Arrival (statesHit=3/3) and the three bat fractions (rest/active/flip-at-arrival) all
 * reproduce exactly via test/mechanism-handoffs.test.mjs's towardFlipper — confirmed,
 * unchanged, no correction needed for those.
 *
 * The "35 of 35", "26 headings", and "5 of 25 perturbations" figures earlier in this comment
 * are a different case: they were recorded 2026-09-04 (commit c2ac18e, the same pass that
 * chose -94°), before the flip-at-arrival fix (d901cbf, 2026-09-05) — the same ordering that
 * made SLIDE's mid-bat count stale — and no committed sweep script implements that exact
 * heading/perturbation grid, so they cannot be re-run bit-for-bit. A best-effort
 * reconstruction (±3°/±0.2m/s over a 5×5 grid at the chosen -94° heading, ×3 flipper states,
 * "mid-bat" counted if any state lands on the bat) finds arrival 25/25 and mid-bat survival
 * 25/25 today — much better than the published 5/25, and in the same direction as SLIDE's
 * correction (the pre-fix method under-counted flip-at-arrival contact, since it folded that
 * state into 'active'). This is a reconstruction, not an exact reproduction of the original
 * grid, so it is reported as evidence the published 5/25 is very likely stale rather than as
 * a replacement figure to pin.
 */
export function buildSandbox() {
  const centre = { x: -0.01, y: 0.56 };
  const dir = normalize({ x: -0.07, y: -1 });
  return {
    captureZone: { centre, radius: 0.022, tag: SW_SANDBOX_ENTRY },
    eject: { vel: scale(dir, SCOOP_EJECT), tag: SW_SANDBOX_EJECT },
  };
}
