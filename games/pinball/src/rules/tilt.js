// TILT — TEACHER'S WATCHING (design doc §4.4/line 437-440): "A simulated tilt bob: a 2D damped
// pendulum accumulating energy from nudges. Two warnings ('TEACHER'S WATCHING'), the third
// tilts ('SENT TO THE PRINCIPAL'): flippers die, the ball drains, bonus is lost, no ball save.
// Tilt state resets each ball. A slam-tilt threshold (very large single nudge) ends the game."
//
// This is a real damped pendulum (small-angle approximation: a 2D damped spring-mass, the
// standard tilt-bob model), not a nudge counter — a counter that trips at 3 would satisfy the
// design doc's word count, not its physics. The reason a bob matters: repeated small nudges
// spaced well apart are safe (the bob has time to decay back toward rest before the next one
// arrives) while the same nudges in quick succession are not (each new impulse lands on top of
// residual velocity from the last, so the bob's own energy compounds) — that behaviour falls
// out of a damped oscillator for free and cannot be approximated by counting events. See
// TUNING below for the measured cadence this produces.
//
// Lives in the game layer, integrates itself — no physics/ import, no physics/ change. Pure:
// no THREE, no DOM, no wall-clock read (every timestep is caller-supplied, same convention
// game/mechanisms.js's scoop/drop-bank timers and rules/game.js's atS already use).

// --- Tuning (picked, not sourced — the design doc gives no numbers) ------------------------
// Natural period ~0.6s: fast enough that a real player notices the bob "still swinging" from
// their last nudge if they nudge again within roughly half a second, slow enough that it reads
// as a pendulum and not a twitch. STIFFNESS = omega0^2 for that period.
const TILT_STIFFNESS = 110; // (rad/s)^2 — omega0 = sqrt(110) ≈ 10.49 rad/s, period ≈ 0.60s
// Damping ratio ~0.35 (underdamped: a couple of visible-in-principle decay swings, not a dead
// thump) — chosen so the bob is most of the way back to rest after ~1 natural period.
const TILT_DAMPING = 7.3; // (1/s), i.e. 2*zeta*omega0 with zeta ≈ 0.35
// Converts one nudge's own strength (see nudgeUnits below — NOT the raw {x,y} passed to
// nudgeTiltBob) into a velocity impulse on the bob. A keyboard nudge is always exactly 1 unit.
const TILT_NUDGE_GAIN = 4.0;
// A single 1-unit nudge (gain=4 -> vel=4) from a bob at rest has energy 0.5*4^2 = 8 (see
// tiltEnergy below) — TILT_WARNING_ENERGY is set above that on purpose: one isolated nudge must
// never warn on a real machine, only rapid/sustained nudging does. Measured against the real
// module (see test/tilt.test.mjs's own cadence tests, run via a probe script during tuning, and
// re-measured after fixing registerCrossing's use inside tickTiltBob — see that function's own
// doc comment): two 1-unit nudges <=116ms apart trigger a warning on the second; >=117ms apart,
// never (even resumed for 300 nudges). Sustained 1-unit nudging: <=84ms apart escalates to a
// tilt by the 9th nudge; 85-110ms apart plateaus at exactly 2 warnings (never a 3rd, out to 300
// nudges); 111-116ms apart plateaus at exactly 1; >=118ms apart, never warns at all. These are
// the real, measured numbers, not a guess.
const TILT_WARNING_ENERGY = 12;
// Set well above what sustained 1-unit nudging can reach (the measured plateau above tops out
// around energy 14-15) — only a genuinely oversized single nudge can clear this alone. Checked
// against the SAME single-hit energy formula as the warning threshold: "slam" means exactly
// "one nudge big enough to instantly exceed several warnings' worth of energy on its own", not
// a separate raw-magnitude check.
const TILT_SLAM_ENERGY = 500;

// main.js's existing onNudge callback (src/ui/input.js) has two sources with genuinely
// incompatible units: a keyboard nudge (ArrowUp/KeyA/KeyD) always sends a UNIT vector
// (magnitude exactly 1); a two-finger touch swipe always sends a RAW, unnormalized pixel
// dx/dy, and only calls onNudge once that raw magnitude already clears input.js's own 40px
// minimum-swipe gate. Feeding both straight into the same gain/threshold would make every
// touch swipe (minimum ~40) read as roughly 40x a keypress — found this by computing it, not
// by guessing: at TILT_NUDGE_GAIN=4, a raw magnitude of just ~8 alone already clears
// TILT_SLAM_ENERGY, so literally every touch swipe that's even allowed to fire would slam-tilt
// the game outright on its very first frame of play. nudgeUnits() normalizes both onto the
// same "how many nudges is this worth" scale before TILT_NUDGE_GAIN ever sees it: a magnitude
// at or below NUDGE_UNIT_CUTOFF is treated as already keyboard-scale (passed through as 1
// unit); above it, it's treated as touch pixels and divided by NUDGE_REFERENCE_PX — the same
// 40px input.js itself already uses as "the smallest motion that counts as a nudge at all" —
// so a bare-minimum swipe reads as about one nudge-unit, same as a keypress, and only a swipe
// several times that big starts reading as proportionally more than one.
const NUDGE_UNIT_CUTOFF = 2;
const NUDGE_REFERENCE_PX = 40;

function nudgeUnits(x, y) {
  const mag = Math.hypot(x, y) || 1;
  const unitScale = mag <= NUDGE_UNIT_CUTOFF ? 1 : mag / NUDGE_REFERENCE_PX;
  return { x: (x / mag) * unitScale, y: (y / mag) * unitScale };
}

export function createTiltBob() {
  return {
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    accumulatorS: 0,
    warnings: 0,
    tilted: false,
    // Persistent (not a per-call local): a nudge's impulse and the integrator's own decay can
    // each independently move energy across TILT_WARNING_ENERGY, at two different call sites
    // (nudgeTiltBob, tickTiltBob) and at arbitrarily different times. Tracking "was it above
    // last time anyone checked" ON THE BOB (rather than recomputing a before/after pair inside
    // a single call) is what lets both call sites detect the same crossing exactly once,
    // whichever of them actually causes it — see registerCrossing below. An earlier version of
    // this file recomputed the before/after pair only inside tickTiltBob's own loop, which
    // silently missed every crossing caused by a nudge itself (a nudge already lands above
    // threshold by the time the next tick call looks at it, so it saw "was already above" and
    // never registered a warning at all) — found this by simulating rapid nudges and getting
    // zero warnings at any cadence, not by reasoning about it in advance.
    aboveThreshold: false,
  };
}

/** Called once per new ball (design: "Tilt state resets each ball") — a fresh bob, fresh
 * warning count. Does not touch `tilted`'s downstream consequences (main.js/rules/game.js own
 * those); this only resets the bob's own physical/warning state.
 *
 * Reset BY CONSTRUCTION, not by a hand-maintained field list: this just overwrites every field
 * with a freshly-built bob's own fields, so a field added to createTiltBob later is reset
 * correctly for free — there is no second list anywhere that also has to remember it exists.
 * Considered leaving this as an explicit per-field reset (matching how most of this codebase's
 * other per-ball state resets — e.g. rules/game.js's launchBall — do it field-by-field against
 * a player object with many OTHER fields that must NOT reset every ball), but this bob has no
 * such fields: everything on it is ball-scoped, so there's no risk of construction-by-reset
 * accidentally wiping something that was meant to survive. That asymmetry (a small, single-
 * purpose object with nothing but ball-scoped state) is what makes reset-by-construction safe
 * here specifically, not a rule to apply everywhere without checking it first — a richer
 * object with some fields that persist across balls and some that don't (most player state in
 * rules/game.js) genuinely needs an explicit, reasoned list; a small object where literally
 * everything is ball-scoped doesn't, and forcing reset-by-construction onto the former would
 * risk silently wiping something that was supposed to survive. */
export function resetTiltBob(bob) {
  Object.assign(bob, createTiltBob());
}

function tiltEnergy(bob) {
  return 0.5 * (bob.vel.x * bob.vel.x + bob.vel.y * bob.vel.y)
    + 0.5 * TILT_STIFFNESS * (bob.pos.x * bob.pos.x + bob.pos.y * bob.pos.y);
}

/** Checks the bob's CURRENT energy against TILT_WARNING_ENERGY and registers a warning/tilt
 * exactly once per upward crossing, regardless of what caused the crossing (a nudge's impulse
 * or the integrator's own step) or which function calls this. See createTiltBob's doc comment
 * on `aboveThreshold` for why this has to be persistent state, not a local before/after pair. */
function registerCrossing(bob) {
  const above = tiltEnergy(bob) >= TILT_WARNING_ENERGY;
  let result = null;
  if (above && !bob.aboveThreshold) {
    bob.warnings += 1;
    if (bob.warnings >= 3) {
      bob.tilted = true;
      result = 'tilt';
    } else {
      result = 'warning';
    }
  }
  bob.aboveThreshold = above;
  return result;
}

/** Applies one nudge (the SAME raw {x,y} passed to main.js's existing onNudge — a unit vector
 * from a keyboard nudge, or a raw pixel dx/dy from a two-finger swipe; see src/ui/input.js) to
 * the bob's velocity. Applied instantly, on whatever clock the caller calls this from (the
 * frame clock, in main.js — nudges are real input events, not something to buffer for the next
 * fixed step). Returns 'slam' if this single nudge alone was big enough to end the game
 * outright, 'warning'/'tilt' if this nudge's own impulse was what pushed the bob over
 * TILT_WARNING_ENERGY (checked immediately — see registerCrossing), or null. */
export function nudgeTiltBob(bob, { x, y }) {
  if (bob.tilted) return null;
  const units = nudgeUnits(x, y);
  const vx = units.x * TILT_NUDGE_GAIN;
  const vy = units.y * TILT_NUDGE_GAIN;
  const singleHitEnergy = 0.5 * (vx * vx + vy * vy);
  if (singleHitEnergy >= TILT_SLAM_ENERGY) {
    bob.tilted = true;
    return 'slam';
  }
  bob.vel.x += vx;
  bob.vel.y += vy;
  return registerCrossing(bob);
}

// The bob's own damped-spring integration deliberately runs on a FIXED step (physics/
// constants.js's STEP_DT), consumed from the caller's variable frame `dt` via an accumulator —
// the exact same fixed-step-from-variable-input pattern physics/world.js's advance() uses for
// the real solver, kept here (not imported) since this module owns its own integrator and
// physics/ is not this dispatch's to change. This is a deliberate choice, not a default:
// explicit-Euler-integrating a lightly-damped oscillator at a frame's own variable dt (0.05s
// worst case, per main.js's own dt clamp) would make the bob's decay rate and, worse, whether
// two nudges land in-phase or out-of-phase — which is the entire mechanism that makes rapid
// nudges dangerous and spaced-out ones safe — depend on the machine's framerate during that
// exact sequence. The measured cadence figures in rules/tilt.test.mjs are only meaningful if
// they don't change between a 240Hz test harness and a slow real frame; a fixed step guarantees
// that, a variable one does not.
const STEP_DT = 1 / 240;

/** Steps the bob forward by `dt` seconds (the caller's own frame dt — variable, real time) at
 * a fixed internal rate (see above), and reports an edge-triggered warning/tilt the instant the
 * bob's own energy crosses TILT_WARNING_ENERGY upward for the 1st/2nd/3rd time since the last
 * resetTiltBob. Returns 'warning' | 'tilt' | null. Never fires again once tilted (bob.tilted). */
export function tickTiltBob(bob, dt) {
  if (bob.tilted) return null;
  bob.accumulatorS += dt;
  let result = null;
  while (bob.accumulatorS >= STEP_DT) {
    bob.accumulatorS -= STEP_DT;

    // Damped spring-mass (unit mass): a = -k*x - c*v.
    const ax = -TILT_STIFFNESS * bob.pos.x - TILT_DAMPING * bob.vel.x;
    const ay = -TILT_STIFFNESS * bob.pos.y - TILT_DAMPING * bob.vel.y;
    bob.vel.x += ax * STEP_DT;
    bob.vel.y += ay * STEP_DT;
    bob.pos.x += bob.vel.x * STEP_DT;
    bob.pos.y += bob.vel.y * STEP_DT;

    // registerCrossing (shared with nudgeTiltBob) rather than a second, local before/after
    // pair here: an earlier version of this function tracked its own wasBelow/nowAbove locally
    // and never touched `bob.aboveThreshold`, which nudgeTiltBob's registerCrossing relies on
    // to know a crossing was already counted. In practice pure decay only ever *decreases*
    // energy (no impulse happens here), so that local pair could never itself fire — but it
    // was live, untested code that would have double-counted the very next nudge's crossing
    // (registerCrossing seeing `aboveThreshold` still false from a crossing this loop's own
    // logic had already silently counted) the moment anything here ever did add energy. One
    // shared crossing-check, not two independently-maintained ones.
    const r = registerCrossing(bob);
    if (r) {
      result = r;
      if (bob.tilted) break;
    }
  }
  return result;
}
