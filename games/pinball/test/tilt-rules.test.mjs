// TILT rules-layer behavior (design §4.4): bonus lost, no ball save, resets turn/game state
// correctly. rules/tilt.js's own bob is tested separately (test/tilt.test.mjs) — this tests
// rules/game.js's tiltBall/slamTilt, the functions main.js calls when the bob reports 'tilt'
// or 'slam'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, launchBall, activePlayer, activePlayerIndex, tiltBall, slamTilt } from '../src/rules/game.js';

test('tiltBall: bonus is lost (no bonus display event, score unchanged) even with real bonus material banked', () => {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 3 });
  launchBall(state, 0);
  const p = activePlayer(state);
  p.shotsThisBall = 10;
  p.modesCompletedThisBall = 2;
  p.bonusX = 4;
  const scoreBefore = p.score;

  const display = tiltBall(state, 5);
  assert.ok(!display.some((d) => d.kind === 'bonus'), 'a tilt must not emit a bonus display event at all');
  assert.equal(p.score, scoreBefore, 'score must be unchanged by a tilted ball');
});

test('tiltBall: no ball save, even while well inside the DO-OVER window', () => {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 3 });
  launchBall(state, 0); // ball 1: 12s DO-OVER window
  const display = tiltBall(state, 1); // 1s in — an ordinary drain here would be saved
  assert.ok(display.some((d) => d.kind === 'tilt'));
  assert.ok(!display.some((d) => d.kind === 'ballSaved'), 'tilt must bypass the save window entirely');
  assert.ok(display.some((d) => d.kind === 'turnChange' || d.kind === 'gameOver'), 'the ball must actually end');
});

test('tiltBall: advances the turn like an ordinary end-of-ball', () => {
  const state = createGame({ numPlayers: 2, ballsPerPlayer: 3 });
  launchBall(state, 0);
  const firstPlayer = activePlayerIndex(state);
  tiltBall(state, 1);
  assert.notEqual(activePlayerIndex(state), firstPlayer, 'turn must pass to the next player');
});

test('tiltBall: forces a running multiball to end (multiballForceEnd display event)', () => {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 3 });
  launchBall(state, 0);
  const p = activePlayer(state);
  p.multiball.active = true;
  p.multiball.locks = 2;

  const display = tiltBall(state, 1);
  assert.ok(display.some((d) => d.kind === 'multiballForceEnd'));
  assert.equal(p.multiball.active, false);
});

test('tiltBall on an already-inactive ball is a no-op', () => {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 3 });
  assert.deepEqual(tiltBall(state, 0), []);
});

test('slamTilt: ends the whole game immediately, regardless of remaining balls/players', () => {
  const state = createGame({ numPlayers: 2, ballsPerPlayer: 3 });
  launchBall(state, 0);
  const display = slamTilt(state, 1);
  assert.equal(state.gameOver, true);
  assert.ok(display.some((d) => d.kind === 'slamTilt'));
  assert.ok(display.some((d) => d.kind === 'gameOver'));
  const gameOverEvent = display.find((d) => d.kind === 'gameOver');
  assert.deepEqual(gameOverEvent.scores, state.players.map((p) => p.score));
});

test('slamTilt: still runs the same no-bonus, no-save, multiball-forceEnd path as an ordinary tilt', () => {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 3 });
  launchBall(state, 0);
  const p = activePlayer(state);
  p.bonusX = 5;
  p.shotsThisBall = 8;
  p.multiball.active = true;
  const scoreBefore = p.score;

  const display = slamTilt(state, 1);
  assert.ok(!display.some((d) => d.kind === 'bonus'));
  assert.equal(p.score, scoreBefore);
  assert.ok(display.some((d) => d.kind === 'multiballForceEnd'));
  assert.ok(!display.some((d) => d.kind === 'turnChange'), 'slam must not hand the turn to anyone — the game is over');
});
