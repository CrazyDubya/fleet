// RECESS MULTIBALL (T8 — design doc §4.4/§9 T8 row). Pure state machine, same purity
// contract as the rest of rules/: no threejs/DOM/Date.now/Math.random, every timer takes
// the caller-supplied `atS`. Deliberately does not touch player fields directly (score,
// ballSaveUntilS, doOverUsed) — same boundary rules/modes.js keeps; rules/game.js applies
// the effects this module reports.
//
// This module also does not touch physics ball objects — it has no idea how many balls
// physically exist. main.js is the only thing that knows that, and it tells this module
// about ball count changes via two synthetic tags (table/switches.js's SW_BALL_ADDED/
// SW_BALL_LOST) the same way SW_DRAIN is synthesized from a geometric check rather than a
// physics collision event. See rules/game.js's onBallAdded/onBallLost.
import { MODE_SHOT_TAGS } from './modes.js';

export const LOCK_MAX = 3;
export const JACKPOT_BASE_POINTS = 500000;
export const MULTIBALL_SAVE_S = 20; // "Ball save (DO-OVER) is on for 20s from multiball start" (§4.4)

export function createMultiballState() {
  return {
    lockLit: false,
    locks: 0, // balls currently mounted at the merry-go-round, pre-multiball (0-2 while
              // building toward the 3rd; the 3rd lock immediately starts the release)
    active: false,
    ballsInPlay: 0, // meaningful only while active — see onBallAdded/onBallLost
    jackpotLit: new Set(), // MODE_SHOT_TAGS shot at least once this multiball
    jackpotReady: false,
    jackpotValue: JACKPOT_BASE_POINTS,
    addABallUsed: false, // "once per multiball at the SANDBOX" (§4.4)
  };
}

/** TREEHOUSE hit: lights lock, if it isn't already lit, there's a slot free, and multiball
 * isn't already running. Returns a lamp display event, or null if this hit didn't change
 * anything (already lit, already at 3 locks, or mid-multiball). */
export function onTreehouseHit(m) {
  if (m.active || m.locks >= LOCK_MAX || m.lockLit) return null;
  m.lockLit = true;
  return { kind: 'lamp', id: 'merry_go_round_lock', lit: true };
}

/**
 * A ball has physically settled into the merry-go-round (SW_MERRYGOROUND). Returns one of:
 *   { action: 'eject' }                    — not lit: kicked straight back into play
 *   { action: 'relock', jackpotValue }     — already in multiball: doubles the jackpot,
 *                                             then also ejected (locking further during an
 *                                             active multiball would shrink the ball count
 *                                             we're trying to keep in play)
 *   { action: 'lock', locks }              — a genuine lock (1st or 2nd); ball stays mounted
 *   { action: 'startMultiball' }           — the 3rd lock: releases all 3 mounted balls
 * `atS` seeds the 20s DO-OVER period on startMultiball; rules/game.js applies it to the
 * player's actual ballSaveUntilS/doOverUsed fields (same boundary as onMonkeyBarsExit's
 * 'ballSave' HANG TIME reward).
 */
export function onMerryGoRoundEntry(m, atS) {
  if (m.active) {
    m.jackpotValue *= 2;
    return { action: 'relock', jackpotValue: m.jackpotValue };
  }
  if (!m.lockLit) return { action: 'eject' };

  m.lockLit = false;
  m.locks += 1;
  if (m.locks < LOCK_MAX) return { action: 'lock', locks: m.locks };

  // 3rd lock: start the release. ballsInPlay starts at 0 — the ball that just triggered
  // this is itself one of the 3 mounted balls (there is no separate "ball still in
  // play" at this instant, since locking always captures the ball that made the shot), and
  // each of the 3 counts toward ballsInPlay only once main.js physically releases it
  // (see onBallAdded) — the staggered 400ms release the design doc calls for is exactly
  // that: 3 separate SW_BALL_ADDED ticks, not one.
  m.locks = 0;
  m.active = true;
  m.ballsInPlay = 0;
  m.jackpotLit = new Set();
  m.jackpotReady = false;
  m.jackpotValue = JACKPOT_BASE_POINTS;
  m.addABallUsed = false;
  return { action: 'startMultiball', saveUntilS: atS + MULTIBALL_SAVE_S };
}

/** One of the four §4.3 shots was made while multiball is active — lights it toward the
 * jackpot. No-op once the jackpot is already lit and waiting to be collected. */
export function onModeShotDuringMultiball(m, tag) {
  if (!m.active || m.jackpotReady || !MODE_SHOT_TAGS.includes(tag)) return;
  m.jackpotLit.add(tag);
  if (m.jackpotLit.size >= MODE_SHOT_TAGS.length) m.jackpotReady = true;
}

/** THE SLIDE, with the jackpot lit: collects it and starts a fresh lighting cycle at base
 * value (§4.4's "relights the jackpots"; the escalated value from re-locks does NOT carry
 * into the next cycle — it's this jackpot's payoff, not a permanent multiplier). Returns 0
 * if the jackpot isn't ready (caller falls back to normal SLIDE scoring). */
export function collectJackpot(m) {
  if (!m.active || !m.jackpotReady) return 0;
  const value = m.jackpotValue;
  m.jackpotLit = new Set();
  m.jackpotReady = false;
  m.jackpotValue = JACKPOT_BASE_POINTS;
  return value;
}

/** SANDBOX entry while multiball is active: "add-a-ball once per multiball" (§4.4). Returns
 * true exactly once per multiball — the caller (rules/game.js) turns that into a
 * `{kind:'addABall'}` display event main.js acts on by physically spawning a ball and
 * reporting it back via SW_BALL_ADDED. */
export function onSandboxDuringMultiball(m) {
  if (!m.active || m.addABallUsed) return false;
  m.addABallUsed = true;
  return true;
}

/** main.js physically put another ball into active play (a staggered lock release, or the
 * SANDBOX add-a-ball) — see table/switches.js's SW_BALL_ADDED doc comment. No-op outside an
 * active multiball; a normal single-ball serve never fires this tag. */
export function onBallAdded(m) {
  if (m.active) m.ballsInPlay += 1;
}

/** main.js removed a ball that drained while at least one other ball was still live (see
 * SW_BALL_LOST's doc comment — the truly last ball goes through SW_DRAIN/handleDrain
 * instead, never this). Ends multiball once back down to a single ball in play, per the T8
 * dispatch's "multiball ends when back to 1 ball" — that lone ball keeps playing normally;
 * its own eventual drain is a plain SW_DRAIN, handled by the usual DO-OVER/endOfBall path. */
export function onBallLost(m) {
  if (!m.active) return null;
  m.ballsInPlay = Math.max(0, m.ballsInPlay - 1);
  if (m.ballsInPlay > 1) return null;
  m.active = false;
  return { kind: 'multiballEnd' };
}

/** Called from endOfBall as a safety net (e.g. a tilt mid-multiball) — multiball has no
 * business surviving past the ball it was running on. Returns a display event only if it
 * actually had to force anything, so main.js knows to release/despawn whatever physical
 * balls are still out there. */
export function forceEnd(m) {
  if (!m.active && m.locks === 0) return null;
  m.active = false;
  m.locks = 0;
  m.lockLit = false;
  return { kind: 'multiballForceEnd' };
}
