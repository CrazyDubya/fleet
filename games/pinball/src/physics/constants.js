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
export const E_FLIPPER = 0.85;
export const MU = 0.06;
export const K_DRAG = 0.12;

// upMs lowered from the doc's 30ms starting value to 14ms during the T3 feel checkpoint:
// a live-browser measurement showed only ~2.3 m/s off a flip at 30ms, well short of the
// "shot" feel a real flipper has. At 14ms a resting ball
// leaves at ~4.9 m/s (verified in flipper.test.mjs), matching the design doc's own target.
// A 14ms stroke is faster than a real solenoid; that's an accepted simplification of this
// coarse (240 Hz) discrete-substep model, not a claim about real flipper timing.
// lower.restAngle widened from the doc's -28 to -50 after the T3b drain-sweep test found a
// dead pocket: collision treats each flipper as a capsule (segment padded by flipper.radius)
// against a ball also padded by its own radius, so the tips need a *centreline* gap of
// 2*(flipper.radius + ball.radius) ≈ 51mm, not just 2*ball.radius, before a centred ball can
// fall through. At -28 the tip-to-tip gap was only ~24mm (net negative clearance); -34 still
// left it under half the required width. -50 opens the tip-to-tip span to ~60mm.
export const FLIPPER = {
  lower: { length: 0.075, restAngle: -50, activeAngle: 32, upMs: 14, downMs: 45 },
  upper: { length: 0.065, restAngle: -25, activeAngle: 35, upMs: 14, downMs: 45 },
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
