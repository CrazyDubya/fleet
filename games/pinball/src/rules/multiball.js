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
// SUPER JACKPOT (§4.4: "After 3 jackpots, SUPER JACKPOT lights at MONKEY BARS for 1 500 000
// and relights the jackpots") — the design doc's own sourced figure, not tuned.
export const SUPER_JACKPOT_POINTS = 1500000;
// How many regular jackpot collections light the super jackpot. Scoped to the MULTIBALL RUN
// (reset alongside jackpotValue/jackpotLit/addABallUsed at the 3rd lock below, in
// onMerryGoRoundEntry) — deliberately not ball-scoped and not game-scoped. Game-scoped would
// let a climb toward super started in an earlier multiball this game silently carry into a
// later one; ball-scoped is the wrong UNIT even though it usually coincides with a multiball's
// own lifetime, because what actually bounds this counter is "how long has multiball been
// running", the same thing `m.active`/`onBallLost` already track, not which numbered ball is
// live. A state audit today found two OTHER pieces of state given the wrong scope
// (haiku-fs2's mode-completion-state audit; sandboxLit/hopscotchJackpot.lit, fixed as LIT-1,
// paid out unearned score on the next ball) — this counter's scope is decided here,
// deliberately, rather than discovered later as a third instance of the same bug.
export const JACKPOTS_FOR_SUPER = 3;
export const MULTIBALL_SAVE_S = 20; // "Ball save (DO-OVER) is on for 20s from multiball start" (§4.4)
export const RELOCK_MIN_INTERVAL_S = 1; // no real relock is physically possible faster than
  // this (ball must eject, travel, and re-enter) — defence in depth against a future geometry
  // or physics bug producing same-frame repeat captures, independent of the P0 geometry fix.
export const JACKPOT_MAX_VALUE = JACKPOT_BASE_POINTS * 32; // 16,000,000 — opus2's own
  // reference ceiling from the design doc's "five re-locks is comparable to the whole
  // 15-40M good-game scale" note (20260830T024139Z-pinball-design.md).

export function createMultiballState() {
  return {
    lockLit: false,
    locks: 0, // balls currently mounted at the merry-go-round, pre-multiball (0-2 while
              // building toward the 3rd; the 3rd lock immediately starts the release)
    active: false,
    fieldDay: false, // T9: true while THIS active run is FIELD DAY rather than an ordinary
                      // RECESS MULTIBALL — see startFieldDay's own doc comment. Never true
                      // while `active` is false.
    ballsInPlay: 0, // meaningful only while active — see onBallAdded/onBallLost
    jackpotLit: new Set(), // MODE_SHOT_TAGS shot at least once this multiball
    jackpotReady: false,
    jackpotValue: JACKPOT_BASE_POINTS,
    addABallUsed: false, // "once per multiball at the SANDBOX" (§4.4)
    lastRelockAtS: -Infinity, // last genuine relock's atS, for RELOCK_MIN_INTERVAL_S
    jackpotsCollected: 0, // toward JACKPOTS_FOR_SUPER — see collectJackpot/collectSuperJackpot
    superJackpotLit: false,
  };
}

/**
 * FIELD DAY (T9, design doc §4.4's wizard mode): "4-ball multiball... runs until one ball
 * remains." Reuses THIS module's own ball-count lifecycle (`active`/`ballsInPlay`/
 * `onBallAdded`/`onBallLost`) rather than a second, parallel ball-counter — "how many balls
 * are physically in play, ending when back to 1" is the exact same fact RECESS MULTIBALL
 * already tracks correctly, and a duplicate counter for the same physical fact is exactly the
 * kind of redundant state a scope audit found bugs in twice already today (LIT-1's
 * sandboxLit/hopscotchJackpot.lit, and JACKPOTS_FOR_SUPER's own deliberate scope note above).
 * `onBallLost`'s existing "ends multiball once back down to 1 ball in play" is, unmodified,
 * exactly "runs until one ball remains."
 *
 * Deliberately does NOT touch, reset, or read the jackpot/add-a-ball fields (jackpotLit,
 * jackpotValue, jackpotReady, jackpotsCollected, superJackpotLit, addABallUsed) — those belong
 * to RECESS MULTIBALL's lock-and-collect design, which FIELD DAY has nothing to do with (its
 * own "all five shots lit for 2 000 000, relighting, doubling every 5" is a flat,
 * always-lit-no-collection loop, tracked separately in rules/modes.js's own `fieldDay` state).
 * Whatever those fields held before FIELD DAY started is simply never consulted while
 * `m.fieldDay` is true — `m.fieldDay` is the tag rules/game.js reads (alongside `m.active`) to
 * route a shot's scoring to FIELD DAY's own logic instead of the jackpot path, without a second
 * "which kind of multiball is this" flag duplicating information `m.fieldDay` already carries.
 *
 * `ballsInPlay` starts at 1, not 0 — unlike the 3rd-lock path in onMerryGoRoundEntry, where the
 * triggering ball is itself captured (no longer "in play") until released alongside the other
 * 2. TREEHOUSE is a standup target: hitting it doesn't remove the ball from play, so the ball
 * that triggers FIELD DAY is ALREADY one of the 4 and never goes through onBallAdded — only the
 * 3 NEW balls main.js spawns do (3 calls to onBallAdded bring the count to 4, matching
 * FIELD_DAY_BALL_COUNT). Starting at 0 here would undercount by exactly the one ball that was
 * never "added," and the "ends at 1 remaining" check further down would fire one drain too
 * early.
 */
export function startFieldDay(m, atS) {
  m.active = true;
  m.fieldDay = true;
  m.ballsInPlay = 1;
  m.lockLit = false; // defensive: a lock lit mid-build shouldn't linger as a stale lamp for the
                      // whole FIELD DAY run — see startFieldDay's own doc comment in modes.js.
  return { startedAtS: atS };
}

/** TREEHOUSE hit: lights lock, if it isn't already lit, there's a slot free, and multiball
 * isn't already running. Returns a lamp display event, or null if this hit didn't change
 * anything (already lit, already at 3 locks, or mid-multiball).
 *
 * SIGNAL-LOST (display-event transit audit, haiku-fs2 20260905T215000Z): this 'lamp' event
 * has no handler in main.js's display loop, and deliberately so, not by oversight — main.js
 * already reads `multiball.lockLit` directly, every frame, to color the merry-go-round roof
 * (yellow when lit, green when unlit). That direct-state read can never go stale the way a
 * one-shot display event could (miss a frame, and the event is gone forever with no way to
 * re-derive "is it still lit"); the event fires here only because rules/game.js's own test
 * suite asserts on it (test/multiball.test.mjs) as a way to verify THIS function's own state
 * transition without reaching into the renderer. Left in for that reason, not consumed for
 * this one. */
export function onTreehouseHit(m) {
  if (m.active || m.locks >= LOCK_MAX || m.lockLit) return null;
  m.lockLit = true;
  return { kind: 'lamp', id: 'merry_go_round_lock', lit: true };
}

/**
 * A ball has physically settled into the merry-go-round (SW_MERRY_GO_ROUND). Returns one of:
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
    if (atS - m.lastRelockAtS < RELOCK_MIN_INTERVAL_S) return { action: 'eject' };
    m.lastRelockAtS = atS;
    m.jackpotValue = Math.min(JACKPOT_MAX_VALUE, m.jackpotValue * 2);
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
  m.lastRelockAtS = -Infinity;
  // A fresh multiball run always starts its own climb toward the super jackpot at 0 — see
  // JACKPOTS_FOR_SUPER's own doc comment on why this is scoped to the run, not the game.
  m.jackpotsCollected = 0;
  m.superJackpotLit = false;
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
 * value (the ordinary per-jackpot relight, which has always happened on every single
 * collection here — distinct from SUPER JACKPOT's own "relights the jackpots" at
 * JACKPOTS_FOR_SUPER, see collectSuperJackpot's own doc comment; the escalated value from
 * re-locks does NOT carry into the next cycle — it's this jackpot's payoff, not a permanent
 * multiplier). Also counts toward the super jackpot: every THIRD collection lights it. Returns
 * 0 if the jackpot isn't ready (caller falls back to normal SLIDE scoring). */
export function collectJackpot(m) {
  if (!m.active || !m.jackpotReady) return 0;
  const value = m.jackpotValue;
  m.jackpotLit = new Set();
  m.jackpotReady = false;
  m.jackpotValue = JACKPOT_BASE_POINTS;
  m.jackpotsCollected += 1;
  if (m.jackpotsCollected >= JACKPOTS_FOR_SUPER) m.superJackpotLit = true;
  return value;
}

/** MONKEY BARS, with the super jackpot lit: collects SUPER_JACKPOT_POINTS and resets the
 * count back to 0, so the NEXT super jackpot needs its own fresh JACKPOTS_FOR_SUPER regular
 * collections — collecting the super does not itself count as one of them. This is the
 * design doc's own "relights the jackpots" clause, read as describing what collecting the
 * SUPER does (re-arm the climb toward the next one), not the ordinary per-jackpot relight
 * collectJackpot already does unconditionally on every collection regardless of this counter —
 * the sentence doesn't fully settle which of the two it means, and both readings are
 * consistent with everything else §4.4 says, so this is the interpretation taken, stated here
 * rather than left implicit. Returns 0 if the super jackpot isn't lit (caller falls back to
 * normal MONKEY BARS scoring). */
export function collectSuperJackpot(m) {
  if (!m.active || !m.superJackpotLit) return 0;
  m.superJackpotLit = false;
  m.jackpotsCollected = 0;
  return SUPER_JACKPOT_POINTS;
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
  const wasFieldDay = m.fieldDay;
  m.fieldDay = false;
  // A partial climb toward the super jackpot does not survive the multiball run it happened
  // in (see JACKPOTS_FOR_SUPER's own doc comment on scope) — one collected jackpot when
  // multiball ends this way is simply gone, not a head start on the next multiball's own count.
  // Harmless no-op when this was FIELD DAY, which never touches these fields in the first place.
  m.jackpotsCollected = 0;
  m.superJackpotLit = false;
  return { kind: wasFieldDay ? 'fieldDayEnd' : 'multiballEnd' };
}

/** Called from endOfBall as a safety net (e.g. a tilt mid-multiball) — multiball has no
 * business surviving past the ball it was running on. Returns a display event only if it
 * actually had to force anything, so main.js knows to release/despawn whatever physical
 * balls are still out there. */
export function forceEnd(m) {
  if (!m.active && m.locks === 0) return null;
  const wasFieldDay = m.fieldDay;
  m.active = false;
  m.fieldDay = false;
  m.locks = 0;
  m.lockLit = false;
  // Same discard as onBallLost's ordinary multiball end — see its own comment.
  m.jackpotsCollected = 0;
  m.superJackpotLit = false;
  return { kind: wasFieldDay ? 'fieldDayForceEnd' : 'multiballForceEnd' };
}
