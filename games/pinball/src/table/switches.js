// Switch id constants. Pure data — the vocabulary rules/game.js consumes from physics events.
export const SW_DRAIN = 'drain';
// Synthetic, like SW_DRAIN: main.js pushes this onto the frame's tag batch (never calls
// into rules directly) when a plunge released under 35% power (§4.4's super skill shot).
export const SW_SOFT_PLUNGE = 'soft_plunge';

// T4 — scoring mechanisms (design doc §4.2/§4.3/§4.4).
export const SW_POP_DUCK = 'pop_duck';
export const SW_POP_HORSE = 'pop_horse';
export const SW_POP_ROCKET = 'pop_rocket';

export const SW_SLING_LEFT = 'sling_left';
export const SW_SLING_RIGHT = 'sling_right';

export const SW_HOPSCOTCH = ['hopscotch_1', 'hopscotch_2', 'hopscotch_3', 'hopscotch_4'];
export const SW_HOPSCOTCH_COMPLETE = 'hopscotch_complete';

// Deviation, recorded: "S-A-N-D 3-bank" in §4.3 is taken as a typo for a 4-target bank
// spelling S-A-N-D (the name itself has four letters); built as 4 targets.
export const SW_SAND = ['sand_s', 'sand_a', 'sand_n', 'sand_d'];
export const SW_SAND_COMPLETE = 'sand_complete';

export const SW_TREEHOUSE = 'treehouse';

export const SW_FUN = ['fun_f', 'fun_u', 'fun_n'];
export const SW_FUN_COMPLETE = 'fun_complete';

export const SW_TETHERBALL_SPIN = 'tetherball_spin';
export const SW_PINWHEEL_SPIN = 'pinwheel_spin';

// T5 — ramps, orbits and the SANDBOX scoop (design doc §4.2/§4.3/§9 T5 row).
export const SW_SLIDE_ENTER = 'slide_enter';
export const SW_SLIDE_EXIT = 'slide_exit';
export const SW_MONKEYBARS_ENTER = 'monkeybars_enter';
export const SW_MONKEYBARS_EXIT = 'monkeybars_exit';
export const SW_TUNNEL_ENTER = 'tunnel_enter';
export const SW_TUNNEL_EXIT = 'tunnel_exit';

export const SW_SANDBOX_ENTRY = 'sandbox_entry';
export const SW_SANDBOX_EJECT = 'sandbox_eject';

// T8 — RECESS MULTIBALL (design doc §4.4/§9 T8 row). SW_MERRY_GO_ROUND fires on every
// physical capture by the merry-go-round zone, whether or not lock is lit — rules/multiball.js
// decides what that capture means (lock, re-lock jackpot escalator, or an unlit pass-through
// eject). SW_BALL_ADDED/SW_BALL_LOST are synthetic, like SW_DRAIN/SW_SOFT_PLUNGE: main.js
// pushes them onto a frame's tag batch (never mutates rules state directly) whenever it
// physically puts an extra ball into play (a staggered multiball release, or the SANDBOX
// add-a-ball) or removes one while other balls remain live (so the drain isn't the final one).
export const SW_MERRY_GO_ROUND = 'merry_go_round';
export const SW_BALL_ADDED = 'ball_added';
export const SW_BALL_LOST = 'ball_lost';

/** Which drain switch a ball's removal fires: the last live ball ends the ball (SW_DRAIN),
 * any earlier one just costs multiball a sibling (SW_BALL_LOST) — rules/multiball.js's
 * onBallLost is what actually ends multiball once back down to one. Moved here (rather than
 * left as a bare ternary in main.js) because it's a game-behaviour decision, not glue, and
 * a glue-layer ternary referencing a switch constant is exactly the shape of the
 * SW_BALL_LOST-import bug this function exists to make impossible to repeat unnoticed. */
export function drainTagFor({ liveBallsRemaining }) {
  return liveBallsRemaining > 0 ? SW_BALL_LOST : SW_DRAIN;
}

/** Every physics-event tag that's a genuine T4/T5/T8 scoring switch — anything else (plain
 * walls, the launch-lane floor, the flipper capsules) is plumbing and must not reach
 * rules/game.js or the event log. Moved here from main.js (a game-behaviour allowlist, not
 * glue) so it lives next to the switch constants it's built from instead of only being
 * cross-checked against rules/scoring.js by hand. `slide`/`monkeyBars`/`tunnel` supply each
 * ramp's exit/rollback tag family, derived from that ramp's own id (table/ramps.js) rather
 * than a switches.js export, since "did the shot make it" isn't itself scored — see
 * physics/world.js's stepRampLayerBall/tryEnterGate. */
export function mechanismTags({ slide, monkeyBars, tunnel }) {
  return new Set([
    SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
    SW_SLING_LEFT, SW_SLING_RIGHT,
    ...SW_HOPSCOTCH, ...SW_SAND,
    SW_TREEHOUSE,
    ...SW_FUN,
    SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
    SW_SLIDE_ENTER, SW_MONKEYBARS_ENTER, SW_TUNNEL_ENTER,
    `${slide}_exit`, `${monkeyBars}_exit`, `${tunnel}_exit`,
    `${slide}_rollback`, `${monkeyBars}_rollback`, `${tunnel}_rollback`,
    SW_SANDBOX_ENTRY, SW_SANDBOX_EJECT,
    SW_MERRY_GO_ROUND,
  ]);
}
