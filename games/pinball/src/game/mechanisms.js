// T4 runtime mechanism state: drop-target banks, F-U-N lamp/lane rotation, spinner decay.
// This is explicitly a STUB standing in for the real rules core (T6) — per the design doc
// §9 T4 row, it only needs to consume switch events and produce provisional scores/lamp
// state for the HUD and debug log. It is not `rules/` and is not held to the physics
// purity contract (`purity.test.mjs` only greps physics/, table/, rules/, save/schema.js).
import { SW_HOPSCOTCH, SW_HOPSCOTCH_COMPLETE, SW_SAND, SW_SAND_COMPLETE, SW_FUN, SW_FUN_COMPLETE } from '../table/switches.js';

const DROP_RESPAWN_S = 3;

/** One bank of drop targets. `targets` is the array of {tag, shape} from table/mechanisms.js. */
export function createDropBank(id, targets, completeTag) {
  return { id, targets, completeTag, dropped: new Set(), respawnAt: null };
}

/** Feed a tick of wall-clock seconds; respawns a completed bank after DROP_RESPAWN_S. */
export function tickDropBank(bank, elapsedS) {
  if (bank.respawnAt !== null && elapsedS >= bank.respawnAt) {
    for (const t of bank.targets) t.shape.active = true;
    bank.dropped.clear();
    bank.respawnAt = null;
  }
}

/**
 * Apply a hit event (by tag) to a bank; returns the list of switch tags fired this hit
 * (the target's own tag, plus the bank-complete tag if this was the last one standing).
 */
export function applyDropHit(bank, tag, elapsedS) {
  const target = bank.targets.find((t) => t.tag === tag);
  if (!target || bank.dropped.has(tag)) return [];
  target.shape.active = false;
  bank.dropped.add(tag);
  const fired = [tag];
  if (bank.dropped.size === bank.targets.length) {
    fired.push(bank.completeTag);
    bank.respawnAt = elapsedS + DROP_RESPAWN_S;
  }
  return fired;
}

export function createHopscotchBank(targets) {
  return createDropBank('hopscotch', targets, SW_HOPSCOTCH_COMPLETE);
}
export function createSandBank(targets) {
  return createDropBank('sand', targets, SW_SAND_COMPLETE);
}

/** F-U-N: one lane is "lit" at a time; flipper presses rotate which; landing the lit lane
 * lights that letter permanently until all three are lit, then the set fires complete and
 * resets. */
export function createFunLamps() {
  return { lit: new Set(), pointer: 0 };
}

export function advanceFunPointer(lamps) {
  lamps.pointer = (lamps.pointer + 1) % SW_FUN.length;
}

/** Returns the switch tags fired: the crossed lane's own tag always, plus fun_complete if
 * this crossing completed the set (and resets the lamps for the next cycle). */
export function applyFunCross(lamps, tag) {
  const fired = [tag];
  const idx = SW_FUN.indexOf(tag);
  if (idx === lamps.pointer) {
    lamps.lit.add(tag);
    if (lamps.lit.size === SW_FUN.length) {
      fired.push(SW_FUN_COMPLETE);
      lamps.lit.clear();
    }
  }
  return fired;
}

/** Spinner: an angular-velocity accumulator, kicked by each crossing and decaying over
 * time — drives both the "clicks" scoring (via the caller counting events) and a visual
 * spin rate for rendering. Not physics — purely cosmetic/scoring bookkeeping. */
export function createSpinner() {
  return { angle: 0, angularVel: 0 };
}

const SPINNER_KICK = 18; // rad/s per crossing
const SPINNER_DECAY = 3.5; // 1/s

export function registerSpinnerHit(spinner) {
  spinner.angularVel += SPINNER_KICK;
}

export function tickSpinner(spinner, dt) {
  spinner.angle += spinner.angularVel * dt;
  spinner.angularVel = Math.max(0, spinner.angularVel - SPINNER_DECAY * spinner.angularVel * dt);
}

/** SANDBOX scoop: captures on entry (physics/world.js pins the ball and reports the
 * capture event), holds it for `delayS`, then the caller ejects it. This module only owns
 * the timer — the actual capture/eject of the ball's pos/vel lives in world.js/main.js,
 * since only physics touches ball state directly. */
const SCOOP_HOLD_S = 1.0;

export function createScoop() {
  return { ejectAt: null, ball: null };
}

// `ball` (T8): which physical ball entered, so the eject can reposition the right one now
// that more than one ball can be in play at once. If a second ball enters the sandbox
// before the first is ejected (only possible during multiball), it overwrites `ball` — the
// scoop holds one ball's worth of state, and a simultaneous second entry is a rare edge case
// the design doc doesn't specifically cover; not worth a queue for T8.
export function armScoop(scoop, elapsedS, ball) {
  scoop.ejectAt = elapsedS + SCOOP_HOLD_S;
  scoop.ball = ball;
}

/** Returns true exactly once, on the tick the hold period elapses. */
export function tickScoop(scoop, elapsedS) {
  if (scoop.ejectAt !== null && elapsedS >= scoop.ejectAt) {
    scoop.ejectAt = null;
    return true;
  }
  return false;
}
