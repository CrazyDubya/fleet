// Flipper: a kinematic capsule (pivot -> tip) driven toward a rest/active angle at a fixed
// sweep duration. Modelled as a uniform-radius capsule for collision (design doc §2.3 lists
// distinct r_base/r_tip; we simplify to one physics radius and taper only the rendered mesh
// in render/ — recorded here as the deliberate simplification, per the design doc's
// "buildable first pass, adjust and record" note).
import { Segment } from './shapes.js';
import { perp, sub } from './vec2.js';

const DEG = Math.PI / 180;

export function createFlipper({ pivot, length, radius = 0.012, restAngleDeg, activeAngleDeg, upMs, downMs, side = 1, restitution, tag = 'flipper', layer = 'playfield' }) {
  const restAngle = restAngleDeg * DEG;
  const activeAngle = activeAngleDeg * DEG;
  return {
    pivot,
    length,
    radius,
    restAngle,
    activeAngle,
    upMs,
    downMs,
    side, // +1 = flipper swings counter-clockwise when active (left flipper), -1 = clockwise (right flipper)
    restitution,
    tag,
    layer,
    angle: restAngle,
    angularVel: 0,
    active: false,
  };
}

export function setActive(flipper, active) {
  flipper.active = active;
}

/** Advance a flipper's angle by dt seconds toward its current target. */
export function updateFlipper(flipper, dt) {
  const target = flipper.active ? flipper.activeAngle : flipper.restAngle;
  const durationMs = flipper.active ? flipper.upMs : flipper.downMs;
  const durationS = durationMs / 1000;
  const sweep = Math.abs(flipper.activeAngle - flipper.restAngle);
  const maxDelta = durationS > 0 ? (sweep / durationS) * dt : Math.abs(target - flipper.angle);

  const prevAngle = flipper.angle;
  const diff = target - flipper.angle;
  if (Math.abs(diff) <= maxDelta) {
    flipper.angle = target;
  } else {
    flipper.angle += Math.sign(diff) * maxDelta;
  }
  flipper.angularVel = dt > 0 ? (flipper.angle - prevAngle) / dt : 0;
}

function tipPosition(flipper) {
  return {
    x: flipper.pivot.x + Math.cos(flipper.angle) * flipper.length,
    y: flipper.pivot.y + Math.sin(flipper.angle) * flipper.length,
  };
}

/** Build a fresh collision entry {shape, surfaceVelocityAt} for the flipper's current pose. */
export function flipperEntry(flipper) {
  const tip = tipPosition(flipper);
  const shape = Segment(flipper.pivot, tip, flipper.restitution, flipper.tag, flipper.radius);
  const surfaceVelocityAt = (point) => {
    const r = sub(point, flipper.pivot);
    const tangent = perp(r);
    return { x: tangent.x * flipper.angularVel, y: tangent.y * flipper.angularVel };
  };
  return { shape, surfaceVelocityAt, flipper };
}
