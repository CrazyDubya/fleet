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

test('add-a-ball at the SANDBOX fires once per multiball', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);

  let display = processEvents(state, [SW_SANDBOX_ENTRY], 10);
  assert.ok(display.some((d) => d.kind === 'addABall'));

  display = processEvents(state, [SW_SANDBOX_ENTRY], 11);
  assert.ok(!display.some((d) => d.kind === 'addABall'), 'only once per multiball');
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
