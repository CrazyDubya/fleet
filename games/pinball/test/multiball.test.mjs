import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, launchBall, processEvents, activePlayer } from '../src/rules/game.js';
import {
  SW_TREEHOUSE, SW_MERRY_GO_ROUND, SW_BALL_ADDED, SW_BALL_LOST, SW_DRAIN,
  SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_SANDBOX_ENTRY,
} from '../src/table/switches.js';

function freshGame(seed = 1) {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 3, seed });
  launchBall(state, 0);
  return state;
}

/** Locks all three balls (TREEHOUSE -> MERRY-GO-ROUND, three times), returning the display
 * events from the 3rd (multiball-starting) merry-go-round entry. */
function lockThreeBalls(state) {
  let display;
  for (let i = 0; i < 3; i++) {
    processEvents(state, [SW_TREEHOUSE], i * 2);
    display = processEvents(state, [SW_MERRY_GO_ROUND], i * 2 + 1);
  }
  return display;
}

test('TREEHOUSE lights lock; an unlit MERRY-GO-ROUND entry is just an eject, no lock', () => {
  const state = freshGame();
  const p = activePlayer(state);

  let display = processEvents(state, [SW_MERRY_GO_ROUND], 0);
  assert.ok(display.some((d) => d.kind === 'merryGoRoundEject'), 'unlit entry ejects');
  assert.equal(p.multiball.locks, 0);

  display = processEvents(state, [SW_TREEHOUSE], 1);
  assert.ok(display.some((d) => d.kind === 'lamp' && d.id === 'merry_go_round_lock' && d.lit === true));
  assert.equal(p.multiball.lockLit, true);
});

test('locking the 1st and 2nd ball mounts it and serves a replacement; lock must be relit each time', () => {
  const state = freshGame();
  const p = activePlayer(state);

  processEvents(state, [SW_TREEHOUSE], 0);
  let display = processEvents(state, [SW_MERRY_GO_ROUND], 1);
  assert.ok(display.some((d) => d.kind === 'lock' && d.locks === 1));
  assert.ok(display.some((d) => d.kind === 'lockedBallServed'));
  assert.equal(p.multiball.locks, 1);
  assert.equal(p.multiball.lockLit, false, 'consumed — must be relit for the next lock');

  // A second MERRY-GO-ROUND entry without relighting TREEHOUSE just ejects.
  display = processEvents(state, [SW_MERRY_GO_ROUND], 2);
  assert.ok(display.some((d) => d.kind === 'merryGoRoundEject'));
  assert.equal(p.multiball.locks, 1, 'unlit entry does not consume a lock slot');

  processEvents(state, [SW_TREEHOUSE], 3);
  display = processEvents(state, [SW_MERRY_GO_ROUND], 4);
  assert.ok(display.some((d) => d.kind === 'lock' && d.locks === 2));
  assert.equal(p.multiball.active, false, 'not multiball yet — only 2 locks');
});

test('the 3rd lock starts multiball: releases (no lock display), arms a 20s DO-OVER window', () => {
  const state = freshGame();
  const p = activePlayer(state);
  p.ballSaveUntilS = 5; // simulate the normal launch save window having already lapsed
  p.doOverUsed = true;

  const display = lockThreeBalls(state);
  assert.ok(display.some((d) => d.kind === 'multiballStart'));
  assert.equal(p.multiball.active, true);
  assert.equal(p.multiball.locks, 0, 'lock counter resets once released');
  assert.equal(p.ballSaveUntilS, 5 + 20, 'a fresh 20s DO-OVER window from the start atS');
  assert.equal(p.doOverUsed, false, 'multiball grants a fresh save even if the launch one was used');
});

test('re-locking during an active multiball doubles the jackpot and ejects rather than mounting', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);

  const display = processEvents(state, [SW_MERRY_GO_ROUND], 10);
  assert.ok(display.some((d) => d.kind === 'merryGoRoundEject'));
  const jv = display.find((d) => d.kind === 'jackpotValue');
  assert.ok(jv);
  assert.equal(jv.value, 1000000, 'doubled from the 500,000 base');
  assert.equal(p.multiball.locks, 0, 'a re-lock never mounts a ball');
});

test('jackpot: lights when all four MODE_SHOT_TAGS are shot, collects at THE SLIDE for 500,000 base', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);

  processEvents(state, [SW_MONKEYBARS_EXIT], 10);
  processEvents(state, [SW_TUNNEL_EXIT], 11);
  processEvents(state, [SW_SANDBOX_ENTRY], 12);
  assert.equal(p.multiball.jackpotReady, false, 'SLIDE itself not yet shot this multiball');

  const before = p.score;
  const display = processEvents(state, [SW_SLIDE_EXIT], 13);
  assert.ok(display.some((d) => d.kind === 'score' && d.tag === 'multiball_jackpot' && d.points === 500000));
  assert.equal(p.score - before, 500000);
  assert.equal(p.multiball.jackpotReady, false, 'collected — relit for a fresh cycle');
});

/** Lights and collects one regular multiball jackpot (all four MODE_SHOT_TAGS, collected at
 * THE SLIDE) starting at atSBase — returns the display array from the collecting SLIDE shot. */
function collectOneJackpot(state, atSBase) {
  processEvents(state, [SW_MONKEYBARS_EXIT], atSBase);
  processEvents(state, [SW_TUNNEL_EXIT], atSBase + 1);
  processEvents(state, [SW_SANDBOX_ENTRY], atSBase + 2);
  return processEvents(state, [SW_SLIDE_EXIT], atSBase + 3);
}

test('super jackpot: lights after exactly 3 regular jackpot collections, not before', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);

  collectOneJackpot(state, 10);
  assert.equal(p.multiball.jackpotsCollected, 1);
  assert.equal(p.multiball.superJackpotLit, false);

  collectOneJackpot(state, 20);
  assert.equal(p.multiball.jackpotsCollected, 2);
  assert.equal(p.multiball.superJackpotLit, false);

  collectOneJackpot(state, 30);
  assert.equal(p.multiball.jackpotsCollected, 3);
  assert.equal(p.multiball.superJackpotLit, true, 'the 3rd regular jackpot must light the super');
});

test('super jackpot: collected at MONKEY BARS for 1,500,000, and relights (resets the count for the next climb)', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);
  collectOneJackpot(state, 10);
  collectOneJackpot(state, 20);
  collectOneJackpot(state, 30);
  assert.equal(p.multiball.superJackpotLit, true);

  const before = p.score;
  const display = processEvents(state, [SW_MONKEYBARS_EXIT], 40);
  assert.ok(display.some((d) => d.kind === 'score' && d.tag === 'super_jackpot' && d.points === 1500000));
  assert.ok(display.some((d) => d.kind === 'superJackpotAwarded'));
  assert.equal(p.score - before, 1500000);
  assert.equal(p.multiball.superJackpotLit, false, 'collected — no longer lit');
  assert.equal(p.multiball.jackpotsCollected, 0, "relit: §4.4's own phrase — the next super needs its own fresh 3 collections, this one didn't count as one of them");
});

test('super jackpot: MONKEY BARS scores normally when the super is not lit', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);
  const before = p.score;
  const display = processEvents(state, [SW_MONKEYBARS_EXIT], 10);
  assert.ok(!display.some((d) => d.kind === 'superJackpotAwarded'));
  assert.ok(display.some((d) => d.kind === 'score' && d.tag === SW_MONKEYBARS_EXIT));
  assert.ok(p.score - before < 1500000, 'ordinary MONKEY BARS points, not the super value');
});

test('a partial climb toward the super jackpot does not survive multiball ending (drain to 1 ball)', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);
  collectOneJackpot(state, 10);
  assert.equal(p.multiball.jackpotsCollected, 1);

  processEvents(state, [SW_BALL_ADDED], 20);
  processEvents(state, [SW_BALL_ADDED], 20.4);
  processEvents(state, [SW_BALL_ADDED], 20.8);
  processEvents(state, [SW_BALL_LOST], 30);
  processEvents(state, [SW_BALL_LOST], 31); // back to 1 ball — multiball ends
  assert.equal(p.multiball.active, false);
  assert.equal(p.multiball.jackpotsCollected, 0, 'the partial count from the ended multiball is discarded, not carried');

  lockThreeBalls(state);
  assert.equal(p.multiball.jackpotsCollected, 0, 'a brand new multiball climbs from zero, not from where the last one left off');
});

test('measured: a full multiball with 3 jackpots then a super scores 3,000,000 in jackpot/super points alone', () => {
  // No re-lock in this sequence, so each of the 3 regular jackpots collects at its unescalated
  // 500,000 base (collectJackpot resets jackpotValue after every payout regardless — a re-lock's
  // doubling, tested separately above, never carries between cycles). Summed from the actual
  // 'score' display events this run produced, not a hand-computed expectation: 3 x 500,000 +
  // 1,500,000 = 3,000,000, confirmed by running it below.
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);

  let jackpotPoints = 0;
  for (const atSBase of [10, 20, 30]) {
    const display = collectOneJackpot(state, atSBase);
    const scored = display.find((d) => d.kind === 'score' && d.tag === 'multiball_jackpot');
    assert.ok(scored, `jackpot at atS=${atSBase} must actually collect`);
    jackpotPoints += scored.points;
  }
  const superDisplay = processEvents(state, [SW_MONKEYBARS_EXIT], 40);
  const superScored = superDisplay.find((d) => d.kind === 'score' && d.tag === 'super_jackpot');
  assert.ok(superScored, 'the super jackpot must actually collect on this shot');
  jackpotPoints += superScored.points;

  assert.equal(jackpotPoints, 3000000, 'this is the real measured total for 3 base (unescalated) jackpots + one super, not a hand-computed expectation');
});

test('add-a-ball at the SANDBOX fires once per multiball', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);

  let display = processEvents(state, [SW_SANDBOX_ENTRY], 10);
  assert.ok(display.some((d) => d.kind === 'addABall'));

  display = processEvents(state, [SW_SANDBOX_ENTRY], 11);
  assert.ok(!display.some((d) => d.kind === 'addABall'), 'only once per multiball');
});

// fs2's coverage audit: SW_BALL_ADDED's own effect (multiball.onBallAdded incrementing
// ballsInPlay) was previously only exercised as SETUP inside the drain test below — three
// calls to reach ballsInPlay=3, with the drain behaviour that follows being what's actually
// asserted, not the increments themselves. This tests onBallAdded/SW_BALL_ADDED in isolation:
// that it increments once per tag while multiball is active, and that it's a genuine no-op
// (not a crash, not a silent miscount) outside one — a normal single-ball serve never fires
// this tag, per its own doc comment in table/switches.js, so nothing should happen if it did.
test('SW_BALL_ADDED increments ballsInPlay while multiball is active, and does nothing outside one', () => {
  const state = freshGame();
  const p = activePlayer(state);

  assert.equal(p.multiball.active, false, 'sanity: no multiball yet');
  assert.equal(p.multiball.ballsInPlay, 0, 'sanity: ballsInPlay is only meaningful while active, per its own doc comment');
  processEvents(state, [SW_BALL_ADDED], 1);
  assert.equal(p.multiball.ballsInPlay, 0, 'outside an active multiball, SW_BALL_ADDED must be a genuine no-op, not a silent miscount');

  lockThreeBalls(state);
  assert.equal(p.multiball.active, true);
  const before = p.multiball.ballsInPlay;

  processEvents(state, [SW_BALL_ADDED], 10);
  assert.equal(p.multiball.ballsInPlay, before + 1, 'one SW_BALL_ADDED, one increment');

  processEvents(state, [SW_BALL_ADDED], 10.4);
  processEvents(state, [SW_BALL_ADDED], 10.8);
  assert.equal(p.multiball.ballsInPlay, before + 3, 'three calls, three increments — each tag counts exactly once');
});

test('ball-count-aware drain: SW_BALL_LOST decrements, multiball ends back at 1 ball, SW_DRAIN still ends the last ball normally', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);

  processEvents(state, [SW_BALL_ADDED], 10); // 1st of the 3 staggered releases
  processEvents(state, [SW_BALL_ADDED], 10.4);
  processEvents(state, [SW_BALL_ADDED], 10.8);
  assert.equal(p.multiball.ballsInPlay, 3);

  let display = processEvents(state, [SW_BALL_LOST], 15);
  assert.equal(p.multiball.ballsInPlay, 2);
  assert.equal(p.multiball.active, true, 'still 2 in play');
  assert.ok(!display.some((d) => d.kind === 'multiballEnd'));

  display = processEvents(state, [SW_BALL_LOST], 16);
  assert.equal(p.multiball.ballsInPlay, 1);
  assert.equal(p.multiball.active, false, 'back to 1 ball — multiball is over');
  assert.ok(display.some((d) => d.kind === 'multiballEnd'));
  assert.equal(p.ballActive, true, 'the last ball keeps playing — no endOfBall yet');

  // That lone remaining ball now drains normally — well past any save window.
  display = processEvents(state, [SW_DRAIN], 200);
  assert.ok(display.some((d) => d.kind === 'bonus'), 'a plain end-of-ball, not another multiball event');
  assert.equal(p.ballActive, false);
});

test('forceEnd: a ball ending outright (e.g. tilt) while multiball is active does not survive to the next ball', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);
  assert.equal(p.multiball.active, true);

  const display = processEvents(state, [SW_DRAIN], 200); // well past any save window -> endOfBall
  assert.ok(display.some((d) => d.kind === 'multiballForceEnd'));
  assert.equal(p.multiball.active, false);
});
