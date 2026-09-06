// Tuning constants, all in one file per design doc §2.6. Pure data.

export const PITCH_DEG = 6.5;
export const BALL_RADIUS = 0.0135;
export const STEP_DT = 1 / 240;
export const MAX_IMPACTS = 8;

export const E_WALL = 0.45;
export const E_RUBBER = 0.85;
// Design doc §2.6 starts this at 0.30, but that value only yields ~3.4 m/s off a 2.6 m/s
// tip (v' = u(1+e)), not the ~5 m/s the doc's own §2.4 example claims. Tuned up to 0.85
// during the T2 flipper-feel pass so a flip actually snaps the ball away; recorded here
// per the doc's "adjust and record" note. Exposed live via ?debug=1 (see ui/debug.js).
//
// FLIPPER-EXIT (2026-09-06): left at 0.85, unchanged. The dispatch that opened this was aimed
// at the wrong constant — restitution was never the lever. Swept E_FLIPPER from 0 to 0.85 at
// the (then-shipped) upMs=14: even e=0, the physical floor, still exits the tip at 7.67 m/s
// and 0.8x length at 7.90 m/s, both over the 6.0 m/s ceiling. Exit speed here is set by the
// bat's own surface velocity (upMs, below), which (1+e) only scales by ~1.0-1.85x — nowhere
// near enough range to close a gap this size. See FLIPPER.lower/upper.upMs's own comment for
// where the actual fix landed. Restitution stays at its feel-tuned value because there was
// never a measured reason (for exit speed OR for cradling — see below) to move it.
export const E_FLIPPER = 0.85;
export const MU = 0.06;
export const K_DRAG = 0.12;

// upMs — FLIPPER-EXIT (2026-09-06), replacing the T3 feel-pass value below. The measured
// current (post-GRAVITY-ROLL, post-substep-fix) exit speed at upMs=14 was 14.18 m/s at the
// tip / 11.43 m/s at 0.8x length — the design doc's own true-to-physics standard targets
// 4.5-6.0 m/s off a resting ball, and this project's standard now treats that ceiling as a
// physics-correctness requirement, not a feel choice, once nothing else (E_FLIPPER above)
// can reach it. Swept upMs directly against the real solver (E_FLIPPER held at its shipped
// 0.85, corrected gravityForPitch, real single-impact N=24 resolution) rather than solving
// the impulse relation algebraically — a first attempt at (1+e)*omega*r predicted values
// nothing like the measured 6.31/14.18 history in this file, so the tidy closed form does
// not match where and when contact actually happens here closely enough to trust without
// checking every candidate against the real stroke.
//
//   LOWER: upMs=30 -> tip 6.62 (over); 33 -> 6.02 (over by 0.02); 34 -> 5.84, 0.8x 4.70 (BOTH
//          in range, real margin both ends); 36 -> 0.8x drops to 4.44 (under floor). Chosen: 34.
//   UPPER: (shorter length 0.065 vs 0.075, activeAngle 35 vs 32 — a different sweep, needs its
//          own value, not the lower flipper's) upMs=21 -> tip 6.00 (right at the ceiling);
//          22 -> tip 5.72, 0.8x 4.62 (BOTH in range, comfortable margin); 23 -> 0.8x drops to
//          4.41 (under floor). Chosen: 22.
//
// Both land squarely in "tens of milliseconds," the range real solenoid flippers actually
// operate in (haiku-fs7's real-machine-speeds handoff has no grounded or even ungrounded
// stroke-time figure to anchor to — checked, not assumed absent) — corroborating, not
// deciding: the sweep against this table's own geometry is what the value is chosen from.
// A 14ms stroke was never a considered value; it was the T3 feel pass's fix for an
// under-resolved (N=1) flipper that has since been properly resolved (N=24), the same shape
// of unmeasured-cost tune E_FLIPPER 0.85 turned out to be.
export const FLIPPER = {
  lower: { length: 0.075, restAngle: -50, activeAngle: 32, upMs: 34, downMs: 45 },
  upper: { length: 0.065, restAngle: -25, activeAngle: 35, upMs: 22, downMs: 45 },
};

export const POP_BUMPER_KICK = 2.6;
export const SLINGSHOT_KICK = 3.5;
export const SCOOP_EJECT = 2.2;
// Same category as the constants above it: a coil-strength velocity, not a grounded physical figure
// (see ledger/handoffs/opus2/20260904T180000Z-true-to-physics-standard.md §3 — "real coil
// strength varies by machine and by operator adjustment"). Whether the kickback FIRES on a
// given contact is a game-rule decision (lit/once-per-ball, game/mechanisms.js's
// tryKickback) — this constant is only the launch speed once that decision says yes.
export const KICKBACK_SPEED = 3.0;
// PLUNGER-SPEED: was 5.0 — measured (ledger/handoffs/opus2/20260906T020000Z-ball-speed.md §6)
// to carry ten table-lengths of energy on a table 1.067m long (apex 10.7m in free flight,
// 4.7 m/s still on arrival at the top). That analysis's own "~1.6" candidate was computed
// under a corrected-gravity model this dispatch does NOT apply (gravity is explicitly out of
// scope here — see the same doc §5, and the operator's own dispatch: it breaks ~15 timing
// windows and is the operator's call, not a plunger change). Re-measured free-flight under
// the ACTUAL shipped (uncorrected, sliding-point-mass) gravity instead of inheriting that
// number: under this table's real physics, 1.6 barely clears the table height at all
// (apex 1.072m against a 1.067m table — a 5mm margin), so it was rejected as too fragile.
//
// The binding constraint turned out not to be "does a full pull reach the top" but "does the
// WEAKEST possible tap still clear the lane" — onPlungerRelease (main.js) floors every launch
// to `max(0.6, power) * PLUNGER_MAX_SPEED`, specifically so a very light touch still leaves
// the chute, and there is no mechanism that re-arms a ball that rolls back down into the lane
// (chuteBall is set to null the instant a release is attempted, regardless of what happens
// physically afterward) — a floor that doesn't clear LANE_TOP_Y (0.9m) produces a genuinely
// stuck, un-replungeable ball. Measured directly, both in a headless free-flight harness and
// live in a browser: 2.2 fails this — a real touch-dispatched ~12% pull left the ball dead at
// y≈0.75, never reaching the field, with no way to relaunch it. 2.7 was chosen because its
// floor (0.6 × 2.7 = 1.62 m/s) clears LANE_TOP_Y with real margin (apex 1.024m, confirmed live
// via the same touch-dispatch test) while a full pull (2.7 m/s) still lands with real, but far
// more contained, energy (apex 2.79m in free flight vs the old 8.4m; ~2.10 m/s at the top vs
// 4.7 before — a 55% reduction).
//
// Verified live, not just measured in the abstract: the SAME weakest-possible touch that
// clears the lane at 2.7 also clips the lane-top deflector and gets redirected toward the
// SANDBOX scoop's own neighbourhood (traced within ~4cm of the capture radius before drifting
// past) — the super skill shot's physical path survives. A full pull, launched perfectly
// centred, actually landed IN the sandbox in that same test — real evidence the field is
// reachable with energy to spare, not just barely.
//
// PLUNGER-RECHECK (2026-09-06, after GRAVITY-ROLL corrected gravityForPitch to 5/7 of the
// value this constant was tuned against): re-measured both ends in a headless harness against
// the real solver, with recess.buildWalls() in play — not by scaling 2.7 by 7/5, since drag is
// not linear in gravity and the weak-tap floor is a hard threshold, not a formula. Weak tap
// (0.6 x 2.7 = 1.62 m/s) crosses LANE_TOP_Y at 0.99 m/s, MORE margin than under the old
// gravity (weaker gravity helps a slow climb, not hurts it) — the constraint this value was
// solved against only got easier. Full pull now arrives at LANE_TOP_Y at 2.32 m/s (was
// 2.10 m/s under the old gravity, +10.5%) — more energetic, as expected, since weaker gravity
// costs the ball less on the way up — but the lane-top deflector caps the ball's vertical
// excursion at the same ~1.025m regardless (both runs measured maxY 1.0245-1.0246m with real
// walls in place), so the extra energy becomes a livelier field shot after redirection, not an
// unbounded "off the top" rocket — nowhere near the original bug's 4.7 m/s. Confirmed: 2.7
// still satisfies both ends under corrected gravity; not changed.
export const PLUNGER_MAX_SPEED = 2.7;
export const NUDGE_IMPULSE = 0.35;
export const GATE_ONE_WAY_THRESHOLD = 0.2;

// Minimum inbound speed (component along a ramp/orbit gate's entry direction) for a shot
// to be captured into that layer, per design doc §9 T5. Deliberately low — the funnel
// geometry of the gate itself, not this threshold, is what makes a shot hard or easy.
export const RAMP_ENTRY_MIN_SPEED = 0.5;

// GRAVITY-ROLL: 9.81*sinθ is the sliding acceleration of a point mass. The ball in this sim
// has no rotational state anywhere (no angular velocity, no moment of inertia — see
// ledger/handoffs/opus2/20260906T020000Z-ball-speed.md §1) but it visually rolls, and a solid
// sphere rolling without slipping on an incline puts 2/7 of gravity's work into spin, leaving
// only 5/7 to accelerate its centre: a = (5/7) g sinθ. Measured against the shipped solver:
// the old term reproduced sliding-with-drag to 0.08%; this one reproduces rolling-with-drag to
// 0.02% (same handoff §2). Not a tuning choice — the solid-sphere factor is exact, and nothing
// else in the solver (impulses, kicks, restitution) is a function of gravity, so this is the
// whole correction. Downstream timing windows tuned against the old (too-fast) ball are
// retuned per-window in the GRAVITY-ROLL dispatch, not by scaling this constant back.
const ROLLING_SPHERE_FACTOR = 5 / 7;

export function gravityForPitch(pitchDeg = PITCH_DEG) {
  const g = 9.81 * Math.sin((pitchDeg * Math.PI) / 180) * ROLLING_SPHERE_FACTOR;
  return { x: 0, y: -g };
}

export function tuning(overrides = {}) {
  return { mu: MU, kDrag: K_DRAG, maxImpacts: MAX_IMPACTS, ...overrides };
}
