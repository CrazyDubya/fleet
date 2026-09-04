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
export const PLUNGER_MAX_SPEED = 5.0;
export const NUDGE_IMPULSE = 0.35;
export const GATE_ONE_WAY_THRESHOLD = 0.2;

// Minimum inbound speed (component along a ramp/orbit gate's entry direction) for a shot
// to be captured into that layer, per design doc §9 T5. Deliberately low — the funnel
// geometry of the gate itself, not this threshold, is what makes a shot hard or easy.
export const RAMP_ENTRY_MIN_SPEED = 0.5;

export function gravityForPitch(pitchDeg = PITCH_DEG) {
  const g = 9.81 * Math.sin((pitchDeg * Math.PI) / 180);
  return { x: 0, y: -g };
}

export function tuning(overrides = {}) {
  return { mu: MU, kDrag: K_DRAG, maxImpacts: MAX_IMPACTS, ...overrides };
}
