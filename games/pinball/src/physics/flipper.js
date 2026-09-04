// Flipper: a kinematic capsule (pivot -> tip) driven toward a rest/active angle at a fixed
// sweep duration. Modelled as a uniform-radius capsule for collision (design doc §2.3 lists
// distinct r_base/r_tip; we simplify to one physics radius and taper only the rendered mesh
// in render/ — recorded here as the deliberate simplification, per the design doc's
// "buildable first pass, adjust and record" note).
import { Segment } from './shapes.js';
import { perp, sub } from './vec2.js';

const DEG = Math.PI / 180;

// True-to-physics fix (ledger/handoffs/opus2/20260904T180000Z-true-to-physics-standard.md §5,
// Experiment A'-3; corrected to its final value by
// ledger/handoffs/opus2/20260904T215500Z-experiment-a-run.md after Experiment A was actually
// run): at the world's normal STEP_DT=1/240s, the lower flipper's 82-degree, 14ms stroke moves
// its tip ~31.9mm per substep — 1.18 ball diameters — so a resting ball cannot get out of the
// way between substeps and is swept through and re-struck repeatedly (13 contacts measured at
// the tip; peak exit speed non-monotonic in E_FLIPPER as a result — a re-strike-count artifact,
// not restitution behaving strangely). The fix is resolution, not retuning: while a flipper is
// actually moving (angle != its current target), both world.js's real simulation loop and any
// test that hand-rolls a flip must integrate at STEP_DT/FLIPPER_SUBSTEPS instead of STEP_DT, so
// the flipper and ball-vs-flipper collision are resolved finely enough that the ball can
// separate between contacts. STEP_DT itself, upMs, every angle and every restitution are
// unchanged — this constant only ever subdivides the same STEP_DT-sized span, never lengthens
// or shortens it. Exported so world.js and every test measuring flip behaviour share one source
// instead of duplicating the multiplier.
//
// FIRST SHIPPED AT 4 (960Hz), THEN CORRECTED TO 24 (5760Hz). N=4 was chosen because peak exit
// speed became "monotonic" there — but Experiment A (run properly, see the handoff above)
// showed that monotonicity ran in the WRONG DIRECTION: at N=4, peak speed FALLS as E_FLIPPER
// rises, and has no relation to contact radius along the bat — both physically backwards (a
// bouncier bat must throw a faster ball; a strike further from the pivot, at higher surface
// speed, must throw a faster ball too). N=4 was still resolving multiple contacts per stroke
// (k=3-6 depending on e), just few enough and evenly enough spaced to look monotonic by
// coincidence — every resolution below a true single-impact regime is a different, deterministic
// multi-contact composite (exit speed step k gives slope e^k, not e), and N=4's composite
// happened to be monotonic in the wrong direction. The two criteria that are physically
// obligatory — peak RISES with e, peak RISES with contact radius — first hold at N=24, where
// tip travel per substep (1.33mm) is small enough that every stroke resolves as one genuine
// impact (k=1) at every e and every contact point tested. Measured cost of N=24 vs N=4 (full
// real table, 3 balls, one full stroke): median 0.347ms vs 0.057ms — under 2.1% of a single
// 60fps (16.67ms) frame budget even at the higher count, and that cost is spread across the
// stroke's ~4 STEP_DT ticks, not paid in one frame. Affordable; shipped.
export const FLIPPER_SUBSTEPS = 24; // STEP_DT/24 = 1/5760s -> ~1.33mm tip travel/substep; the single-impact regime (k=1 at every e, every contact point)

/** True while `flipper` is mid-stroke (its angle hasn't yet reached whichever of rest/active is
 * its current target) — the condition both world.js and any hand-rolled test loop use to decide
 * whether this tick needs FLIPPER_SUBSTEPS subdivisions or can take the ordinary single step. */
export function isFlipperMoving(flipper) {
  const target = flipper.active ? flipper.activeAngle : flipper.restAngle;
  return flipper.angle !== target;
}

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

/**
 * Advance a flipper's angle by dt seconds toward its current target.
 *
 * `flipper.omegaProfile(u)` (optional; pinball-lab/E1 hook, design doc-external) reshapes the
 * up-stroke's angular rate as a function of `u` = fraction of the up-stroke's *duration*
 * elapsed (not fraction of angle covered — a profile driven by position rather than time
 * feeds back on itself, and one that tapers to 0 at u=1, like a coil easing into the stop,
 * would asymptotically never quite finish the sweep). The multiplier is expected to be
 * pre-normalised by its caller (mean 1 over u in [0,1]) so the sweep still completes in
 * ~upMs; this function does no normalising of its own. Undefined (the default, and every
 * flipper RECESS itself builds) ⇒ `rate` stays the plain constant-rate baseline below,
 * bit-identical to before this hook existed.
 */
export function updateFlipper(flipper, dt) {
  const target = flipper.active ? flipper.activeAngle : flipper.restAngle;
  const durationMs = flipper.active ? flipper.upMs : flipper.downMs;
  const durationS = durationMs / 1000;
  const sweep = Math.abs(flipper.activeAngle - flipper.restAngle);
  let rate = durationS > 0 ? sweep / durationS : Infinity;
  if (flipper.active && flipper.omegaProfile && durationS > 0) {
    flipper._upElapsedS = (flipper._upElapsedS || 0) + dt;
    const u = flipper._upElapsedS / durationS;
    // u >= 1: time's nominally up. Force completion rather than trust the profile's own
    // discretised integral to have landed exactly on the target — a coarse step count (a
    // 14ms sweep is only ~3 physics substeps) means a profile shaped to taper toward 0 right
    // at u=1 (easeOut, sCurve) can otherwise undershoot and then never move again, since its
    // own rate at u=1 is 0. This is what "still completes in ~upMs" is actually enforcing.
    rate = u >= 1 ? Infinity : rate * flipper.omegaProfile(u);
  } else {
    flipper._upElapsedS = 0;
  }
  const maxDelta = durationS > 0 ? rate * dt : Math.abs(target - flipper.angle);

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
