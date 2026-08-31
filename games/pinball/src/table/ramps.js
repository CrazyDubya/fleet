// T5 — ramps, orbits and the SANDBOX scoop. Pure data: builds ramp tracks (physics/ramp.js)
// and their entry gates (physics/shapes.js's Gate) from the design doc's §4.3 coordinates.
// No THREE, no DOM, no mutable module state.
import { Gate } from '../physics/shapes.js';
import { createRampTrack, entryTangent } from '../physics/ramp.js';
import { perp, normalize, scale } from '../physics/vec2.js';
import { RAMP_ENTRY_MIN_SPEED, SCOOP_EJECT } from '../physics/constants.js';
import {
  SW_SLIDE_ENTER, SW_MONKEYBARS_ENTER, SW_TUNNEL_ENTER,
  SW_SANDBOX_ENTRY, SW_SANDBOX_EJECT,
} from './switches.js';

export const LEFT_INLANE_FEED = { x: -0.15, y: 0.22 };
export const UPPER_LEFT_FLIPPER_FEED = { x: -0.13, y: 0.56 };
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
    exit: { pos: LEFT_INLANE_FEED, dir: normalize({ x: -0.2, y: -1 }), speed: 1.6 },
  });
  return { ramp, gate: gateForRamp(ramp, SW_SLIDE_ENTER) };
}

/**
 * MONKEY BARS. §4.3: entry (0.100, 0.470), crosses overhead right→left, drops to the
 * UPPER-LEFT FLIPPER at (-0.130, 0.560). Steeper (30°) — a real wireform overhead ramp is
 * meant to be the harder shot of the two.
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
    exit: { pos: UPPER_LEFT_FLIPPER_FEED, dir: normalize({ x: -0.3, y: -1 }), speed: 1.4 },
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
 * THE SANDBOX scoop. §4.3: (-0.010, 0.560), r 0.022; ejects down-left toward the left
 * flipper at SCOOP_EJECT (2.2 m/s), per §9 T5.
 */
export function buildSandbox() {
  const centre = { x: -0.01, y: 0.56 };
  const dir = normalize({ x: -0.4, y: -1 });
  return {
    captureZone: { centre, radius: 0.022, tag: SW_SANDBOX_ENTRY },
    eject: { vel: scale(dir, SCOOP_EJECT), tag: SW_SANDBOX_EJECT },
  };
}
