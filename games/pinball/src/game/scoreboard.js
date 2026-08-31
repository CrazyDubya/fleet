// Provisional per-switch scoring stub for the HUD/debug event log. Real scoring rules
// (multipliers, modes, bonus) are T6+; this exists only so T4's mechanisms are visibly
// wired end-to-end, per the design doc §9 T4 row ("emit switch events + provisional scores
// to the HUD area").
import {
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  SW_HOPSCOTCH_COMPLETE, SW_SAND_COMPLETE,
  SW_TREEHOUSE,
  SW_FUN_COMPLETE,
  SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
  SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT,
  SW_SANDBOX_ENTRY, SW_SANDBOX_EJECT,
} from '../table/switches.js';

const POINTS = new Map([
  [SW_POP_DUCK, 5000], [SW_POP_HORSE, 5000], [SW_POP_ROCKET, 5000],
  [SW_SLING_LEFT, 1000], [SW_SLING_RIGHT, 1000],
  [SW_HOPSCOTCH_COMPLETE, 500000], [SW_SAND_COMPLETE, 250000],
  [SW_TREEHOUSE, 10000],
  [SW_FUN_COMPLETE, 0], // multiplier award, not points (T6 will implement the +1x)
  [SW_TETHERBALL_SPIN, 2500], [SW_PINWHEEL_SPIN, 1000],
  [SW_SLIDE_EXIT, 100000], [SW_MONKEYBARS_EXIT, 150000], [SW_TUNNEL_EXIT, 50000],
  [SW_SANDBOX_ENTRY, 0], [SW_SANDBOX_EJECT, 10000],
]);

const HOPSCOTCH_TARGET_POINTS = 25000;
const SAND_TARGET_POINTS = 10000;

export function createScoreboard(logSize = 12) {
  return { score: 0, log: [], logSize };
}

/** tag: switch id. Individual hopscotch/sand target tags aren't in the flat POINTS map
 * (their value depends on which bank they belong to), so the caller passes a fallback. */
export function applySwitch(board, tag, fallbackPoints = 0) {
  const points = POINTS.has(tag) ? POINTS.get(tag) : fallbackPoints;
  board.score += points;
  board.log.push({ tag, points, at: board.score });
  if (board.log.length > board.logSize) board.log.shift();
  return points;
}

export function fallbackPointsFor(tag) {
  if (tag.startsWith('hopscotch_')) return HOPSCOTCH_TARGET_POINTS;
  if (tag.startsWith('sand_')) return SAND_TARGET_POINTS;
  return 0;
}
