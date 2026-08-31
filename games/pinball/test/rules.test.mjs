import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, launchBall, processEvents, activePlayer, activePlayerIndex, ballNumber } from '../src/rules/game.js';
import { computeBonus } from '../src/rules/bonus.js';
import { SW_DRAIN, SW_SLING_LEFT, SW_TREEHOUSE, SW_POP_DUCK, SW_SLIDE_EXIT, SW_TUNNEL_EXIT, SW_FUN_COMPLETE } from '../src/table/switches.js';

test('a scripted switch sequence produces an exact expected score', () => {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 3 });
  launchBall(state, 0);
  const events = [
    SW_SLING_LEFT,          // 1000
    { tag: SW_TREEHOUSE },  // 10000 — object-shaped events (as physics/world.js emits) work too
    SW_POP_DUCK,            // 5000 (1st pop bumper hit this ball)
    SW_POP_DUCK,            // 5250 (2nd hit: +250 escalator per §4.4)
    SW_SLIDE_EXIT,          // 100000, and counts as one of the five §4.3 "shots"
  ];
  processEvents(state, events, 1);
  const p = activePlayer(state);
  assert.equal(p.score, 1000 + 10000 + 5000 + 5250 + 100000);
  assert.equal(p.shotsThisBall, 1);
  assert.equal(p.popHitsThisBall, 2);
});

test('1-4 players alternate turns through balls, round-robin not player-then-player', () => {
  for (const numPlayers of [1, 2, 3, 4]) {
    const ballsPerPlayer = 2;
    const state = createGame({ numPlayers, ballsPerPlayer });
    const seenOrder = [];
    let atS = 0;
    for (let turn = 0; turn < numPlayers * ballsPerPlayer; turn++) {
      seenOrder.push([activePlayerIndex(state), ballNumber(state)]);
      launchBall(state, atS);
      atS += 100; // well past any DO-OVER window, so this drain always ends the ball
      processEvents(state, [SW_DRAIN], atS);
    }
    assert.equal(state.gameOver, true, `numPlayers=${numPlayers}`);
    const expected = [];
    for (let b = 1; b <= ballsPerPlayer; b++) {
      for (let pl = 0; pl < numPlayers; pl++) expected.push([pl, b]);
    }
    assert.deepEqual(seenOrder, expected, `numPlayers=${numPlayers}`);
  }
});

test('DO-OVER ball save serves a replacement inside its window and not outside it', () => {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 2 });
  launchBall(state, 0); // ball 1: window is 12s (§4.4's first-ball exception)

  let display = processEvents(state, [SW_DRAIN], 5); // within the 12s window
  assert.ok(display.some((d) => d.kind === 'ballSaved'));
  assert.equal(activePlayer(state).ballActive, true);
  assert.equal(activePlayer(state).ball, 1);
  assert.equal(state.turnIndex, 0, 'the ball did not end');

  // A second drain, still inside the original window, must NOT save again — one DO-OVER
  // per ball, not a renewable window.
  display = processEvents(state, [SW_DRAIN], 6);
  assert.ok(!display.some((d) => d.kind === 'ballSaved'));
  assert.ok(display.some((d) => d.kind === 'bonus'));
  assert.equal(state.turnIndex, 1, 'the ball ended this time');

  // Ball 2: window is 10s (not the first ball). Draining after it elapses ends the ball
  // outright, no save.
  launchBall(state, 100);
  display = processEvents(state, [SW_DRAIN], 111); // 11s later, past the 10s window
  assert.ok(!display.some((d) => d.kind === 'ballSaved'));
  assert.ok(display.some((d) => d.kind === 'bonus'));
  assert.equal(state.gameOver, true);
});

test('end-of-ball bonus counts up per the RECESS BELL formula and applies bonus X', () => {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 1 });
  launchBall(state, 0);
  processEvents(state, [SW_FUN_COMPLETE, SW_SLIDE_EXIT, SW_TUNNEL_EXIT], 1);
  const p = activePlayer(state);
  assert.equal(p.bonusX, 2, 'F-U-N complete awards +1 bonus multiplier');
  assert.equal(p.shotsThisBall, 2);

  const scoreBeforeBonus = p.score;
  const display = processEvents(state, [SW_DRAIN], 20); // 20s playtime, past any save window
  const bonusEvent = display.find((d) => d.kind === 'bonus');
  const expected = computeBonus({ playtimeS: 20, shots: 2, modes: 0, bonusX: 2 });
  assert.equal(bonusEvent.amount, expected);
  assert.equal(bonusEvent.bonusX, 2);
  assert.equal(p.score, scoreBeforeBonus + expected);
});

test('end of game is reached and reported', () => {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 1 });
  launchBall(state, 0);
  const display = processEvents(state, [SW_DRAIN], 50);
  const gameOverEvent = display.find((d) => d.kind === 'gameOver');
  assert.ok(gameOverEvent);
  assert.deepEqual(gameOverEvent.scores, [activePlayer(state).score]);
  assert.equal(state.gameOver, true);
});

test('processEvents is a no-op once the game is over — no direct-call path around it', () => {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 1 });
  launchBall(state, 0);
  processEvents(state, [SW_DRAIN], 50);
  assert.equal(state.gameOver, true);
  const scoreAfterGameOver = activePlayer(state).score;
  const display = processEvents(state, [SW_SLIDE_EXIT], 51);
  assert.deepEqual(display, []);
  assert.equal(activePlayer(state).score, scoreAfterGameOver);
});

test('createGame rejects out-of-range player counts', () => {
  assert.throws(() => createGame({ numPlayers: 0 }));
  assert.throws(() => createGame({ numPlayers: 5 }));
});
