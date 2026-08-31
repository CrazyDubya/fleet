// Switch id constants. Pure data — the vocabulary rules/game.js consumes from physics events.
export const SW_DRAIN = 'drain';
export const SW_LAUNCH = 'launch';
// Synthetic, like SW_DRAIN: main.js pushes this onto the frame's tag batch (never calls
// into rules directly) when a plunge released under 35% power (§4.4's super skill shot).
export const SW_SOFT_PLUNGE = 'soft_plunge';
export const SW_FLIPPER_LEFT = 'flipper_left';
export const SW_FLIPPER_RIGHT = 'flipper_right';
export const SW_FLIPPER_UPPER_LEFT = 'flipper_upper_left';

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
