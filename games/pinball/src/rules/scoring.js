// Switch -> score table for every T4/T5 mechanism, per design doc §4.4. Pure data + two
// small pure helpers — this is the retirement target for the old game/scoreboard.js T4
// stub: same numbers (that stub's values are carried over unchanged), now living inside
// the rules/ purity boundary as the single scoring path instead of a duplicate one.
//
// T7 (rules/modes.js) took over the four linkages this file used to defer: HOPSCOTCH bank
// completion now lights the SLIDE jackpot instead of paying the flat 500000 below (so
// SW_HOPSCOTCH_COMPLETE is no longer in SWITCH_POINTS — modes.hopscotchJackpotValue
// supplies it dynamically), SW_SLIDE_EXIT and SW_TETHERBALL_SPIN are likewise computed
// dynamically by modes.js's combo logic rather than listed here as flat values. Everything
// else below is unchanged from T6.
import {
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  SW_SAND_COMPLETE,
  SW_TREEHOUSE,
  SW_PINWHEEL_SPIN,
  SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_ORBIT_EXIT,
  SW_SANDBOX_ENTRY, SW_SANDBOX_EJECT,
} from '../table/switches.js';

export const POP_TAGS = new Set([SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET]);
export const POP_BASE_POINTS = 5000;
export const POP_ESCALATOR = 250; // "+250 per hit this ball" (§4.4), any pop bumper

export const SWITCH_POINTS = new Map([
  [SW_SLING_LEFT, 1000], [SW_SLING_RIGHT, 1000],
  [SW_SAND_COMPLETE, 250000],
  [SW_TREEHOUSE, 10000],
  [SW_PINWHEEL_SPIN, 1000],
  [SW_MONKEYBARS_EXIT, 150000], [SW_TUNNEL_EXIT, 50000],
  // ORBIT (2026-09-05): not in the design doc (this mechanism wasn't), so the value is a
  // design choice, not a sourced figure — pitched between the tunnel (another orbit-shaped
  // shot, 50000) and the monkey bars (a harder, overhead ramp, 150000), since a full
  // around-the-table orbit is a comparable-difficulty shot to the tunnel but longer.
  [SW_ORBIT_EXIT, 75000],
  [SW_SANDBOX_EJECT, 10000],
]);

const HOPSCOTCH_TARGET_POINTS = 25000;
const SAND_TARGET_POINTS = 10000;

/** Individual hopscotch_N / sand_N target tags aren't in the flat SWITCH_POINTS map (their
 * value depends on which bank they belong to, not the tag itself). */
export function fallbackPointsFor(tag) {
  if (tag.startsWith('hopscotch_')) return HOPSCOTCH_TARGET_POINTS;
  if (tag.startsWith('sand_')) return SAND_TARGET_POINTS;
  return 0;
}

// The five shots a player thinks about (§4.3) — counted for the RECESS BELL bonus's
// "shots x 5000" term. SANDBOX is counted on entry (that's the shot being made; the eject
// that follows is just the ball coming back out). Deliberately excludes TETHERBALL
// revolutions, which already score per-rev via SWITCH_POINTS and would make "shots"
// meaningless if also counted here.
export const SHOT_TAGS = new Set([SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_SANDBOX_ENTRY]);

export const BONUS_X_MAX = 10; // 25x in FIELD DAY is T9 (wizard mode) territory
