import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, launchBall, processEvents, activePlayer } from '../src/rules/game.js';
import {
  SW_SAND_COMPLETE, SW_SANDBOX_ENTRY, SW_SOFT_PLUNGE,
  SW_FUN, SW_SLING_LEFT,
  SW_POP_DUCK, SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_TETHERBALL_SPIN,
  SW_HOPSCOTCH_COMPLETE,
} from '../src/table/switches.js';

function freshGame(seed = 1) {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 3, seed });
  launchBall(state, 0);
  return state;
}

/** Lights the SANDBOX and forces the given mode to the front of the queue, then starts it —
 * a white-box shortcut so each mode can be tested in isolation without playing the other
 * three first. */
function forceStartMode(state, name, atS = 0) {
  const p = activePlayer(state);
  p.modesState.queue = [name, ...p.modesState.queue.filter((m) => m !== name)];
  p.modesState.sandboxLit = true;
  const display = processEvents(state, [SW_SANDBOX_ENTRY], atS);
  assert.ok(display.some((d) => d.kind === 'modeStart' && d.mode === name), `${name} did not start`);
}

test('KICKBALL: each lit shot advances a base in order, the 4th is a HOME RUN, and it scores per §4.4', () => {
  const state = freshGame();
  forceStartMode(state, 'KICKBALL', 1);
  const p = activePlayer(state);
  const before = p.score;

  processEvents(state, [SW_SLIDE_EXIT], 2);
  assert.equal(p.modesState.activeMode.base, 1);
  processEvents(state, [SW_MONKEYBARS_EXIT], 3);
  assert.equal(p.modesState.activeMode.base, 2);
  processEvents(state, [SW_TUNNEL_EXIT], 4);
  assert.equal(p.modesState.activeMode.base, 3);
  const display = processEvents(state, [SW_SANDBOX_ENTRY], 5);

  assert.ok(display.some((d) => d.kind === 'modeEnd' && d.mode === 'KICKBALL' && d.success === true));
  assert.equal(p.modesState.activeMode, null);
  assert.equal(p.modesCompletedThisBall, 1);
  assert.ok(p.score - before >= 2000000, 'home run pays 2,000,000');
});

test('HIDE & SEEK: wrong shots score 100,000 (plus the shot\'s own value) and hint, the hidden one scores 1,000,000 and moves', () => {
  const state = freshGame();
  forceStartMode(state, 'HIDE_SEEK', 1);
  const p = activePlayer(state);
  // Each shot's own normal score still applies alongside the HIDE & SEEK bonus (a mode
  // layers on top of, not instead of, base scoring — same rule as every other linkage).
  const shots = [
    [SW_SLIDE_EXIT, 100000],
    [SW_MONKEYBARS_EXIT, 150000],
    [SW_TUNNEL_EXIT, 50000],
    [SW_SANDBOX_ENTRY, 0],
  ];

  let foundCount = 0;
  let wrongCount = 0;
  let atS = 2;
  for (const [tag, ownValue] of shots) {
    const before = p.score;
    const hiderBefore = p.modesState.activeMode.hider;
    const display = processEvents(state, [tag], atS++);
    const delta = p.score - before;
    if (delta === ownValue + 1000000) {
      foundCount++;
      assert.ok(display.some((d) => d.kind === 'hideSeekFound'));
      // The test's own name claims "the hidden one... moves" — pinned here (2026-09-05, a
      // file-thread sweep: the old test only ever checked >= 1 found across 4 shots, which
      // would pass identically whether or not the hider actually relocated afterward, since
      // nothing compared its position before and after a find). rules/modes.js's own logic
      // (`while (next === mode.hider) next = ...`) guarantees a genuinely different position;
      // this asserts that guarantee actually held, not just that scoring behaved as if it did.
      assert.notEqual(p.modesState.activeMode.hider, hiderBefore, 'the hider must relocate to a different shot after being found — a bug that left it in place would still pass a >= 1 found check');
    } else {
      assert.equal(delta, ownValue + 100000);
      wrongCount++;
      assert.ok(display.some((d) => d.kind === 'hideSeekHint'));
      assert.equal(p.modesState.activeMode.hider, hiderBefore, 'a WRONG shot must not move the hider — only a find does');
    }
  }
  // The hider moves to a new spot every time it's found, so a 4-shot sweep can find it more
  // than once — just not never.
  assert.ok(foundCount >= 1, 'at least one of the four shots finds the hider');
  assert.equal(foundCount + wrongCount, 4);
});

test('DODGEBALL: 20 spring-rider hits succeed for 2,500,000; slingshots subtract one', () => {
  const state = freshGame();
  forceStartMode(state, 'DODGEBALL', 1);
  const p = activePlayer(state);

  processEvents(state, [SW_SLING_LEFT], 2); // -1, floored at 0 — doesn't go negative
  assert.equal(p.modesState.activeMode.hits, 0);

  const before = p.score;
  let atS = 3;
  let display = [];
  for (let i = 0; i < 20; i++) display = processEvents(state, [SW_POP_DUCK], atS++);

  assert.ok(display.some((d) => d.kind === 'modeEnd' && d.mode === 'DODGEBALL' && d.success === true));
  assert.ok(p.score - before >= 2500000, 'dodgeball success pays 2,500,000');
});

test('JUMP ROPE: revolutions add time and build a multiplier; it ends when the spinner stalls for 4s', () => {
  const state = freshGame();
  forceStartMode(state, 'JUMP_ROPE', 0);
  const p = activePlayer(state);

  const before = p.score;
  processEvents(state, [SW_TETHERBALL_SPIN], 1); // a rev: extends remainingS, builds the multiplier
  assert.ok(p.score > before, 'a rev scores points');
  assert.ok(p.modesState.activeMode.mult > 1);

  // Not stalled yet (< 4s since the rev) — mode still running.
  let display = processEvents(state, [], 4.5);
  assert.equal(p.modesState.activeMode?.name, 'JUMP_ROPE');

  // 4s with no further spin — the spinner has stopped, mode ends.
  display = processEvents(state, [], 6);
  assert.ok(display.some((d) => d.kind === 'modeEnd' && d.mode === 'JUMP_ROPE'));
  assert.equal(p.modesState.activeMode, null);
});

test('JUMP ROPE: the 50x multiplier cap is reached at exactly 98 revs, not 97', () => {
  const state = freshGame();
  forceStartMode(state, 'JUMP_ROPE', 0);
  const p = activePlayer(state);

  for (let rev = 1; rev <= 97; rev++) {
    processEvents(state, [SW_TETHERBALL_SPIN], rev);
  }
  assert.equal(p.modesState.activeMode.mult, 49.5, '97 revs at 0.5/rev from a base of 1 should reach 49.5, not the 50x cap');

  processEvents(state, [SW_TETHERBALL_SPIN], 98);
  assert.equal(p.modesState.activeMode.mult, 50, '98th rev should hit the 50x cap exactly');
});

test('skill shot: landing the lit F-U-N lane at plunge scores 250,000 x ball number', () => {
  const state = freshGame();
  const p = activePlayer(state);
  const litTag = SW_FUN[0]; // launched at atS=0, so lane index floor(0/1.5)%3 === 0
  const before = p.score;
  const display = processEvents(state, [litTag], 0);
  assert.equal(p.score - before, 250000 * p.ball);
  assert.ok(display.some((d) => d.kind === 'score' && d.tag === 'skill_shot'));
  assert.equal(p.freshLaunch, false);
});

test('missing the lit lane at plunge scores no skill shot, and consumes the window', () => {
  const state = freshGame();
  const p = activePlayer(state);
  // At atS=2, floor(2/1.5)%3 === 1, so lane 0 is not lit.
  const before = p.score;
  processEvents(state, [SW_FUN[0]], 2);
  assert.equal(p.score, before);
  assert.equal(p.freshLaunch, false);
});

test('super skill shot: a soft plunge into the SANDBOX scores 1,000,000 and pre-lights the next mode', () => {
  const state = freshGame();
  const p = activePlayer(state);
  const before = p.score;
  const display = processEvents(state, [SW_SOFT_PLUNGE, SW_SANDBOX_ENTRY], 0);
  assert.equal(p.score - before, 1000000);
  assert.ok(display.some((d) => d.kind === 'score' && d.tag === 'super_skill_shot'));
  assert.equal(p.modesState.sandboxLit, true);
  assert.equal(p.modesState.activeMode, null, 'the mode is pre-lit, not started on this same entry');
});

test('RECESS METER: fills pay EXTRA BALL first, then SPECIAL', () => {
  const state = freshGame();
  const p = activePlayer(state);
  let atS = 1;
  let sawExtraBall = false;
  for (let i = 0; i < 15; i++) {
    const display = processEvents(state, [SW_TUNNEL_EXIT], atS++);
    if (display.some((d) => d.kind === 'extraBall')) sawExtraBall = true;
  }
  assert.ok(sawExtraBall, 'the first fill awards EXTRA BALL');
  assert.equal(p.extraBallsPending, 1);

  let sawSpecial = false;
  for (let i = 0; i < 15; i++) {
    const display = processEvents(state, [SW_TUNNEL_EXIT], atS++);
    if (display.some((d) => d.kind === 'special')) sawSpecial = true;
  }
  assert.ok(sawSpecial, 'the second fill awards SPECIAL');
  assert.equal(state.credits, 1);
});

test('EXTRA BALL actually grants another ball: draining past the save window keeps the same player and ball number', () => {
  const state = createGame({ numPlayers: 2, ballsPerPlayer: 3, seed: 1 });
  launchBall(state, 0);
  const p = activePlayer(state);
  p.extraBallsPending = 1;
  const ballBefore = p.ball;
  const turnBefore = state.turnIndex;

  const display = processEvents(state, ['drain'], 100); // well past any DO-OVER window
  assert.ok(display.some((d) => d.kind === 'extraBallGranted'));
  assert.ok(display.some((d) => d.kind === 'ballServed'));
  assert.equal(state.turnIndex, turnBefore, 'the turn did not pass to the next player');
  assert.equal(activePlayer(state).ball, ballBefore);
  assert.equal(activePlayer(state).extraBallsPending, 0);
});

test('linkage: HOPSCOTCH bank completion lights the SLIDE for the jackpot instead of paying flat', () => {
  const state = freshGame();
  const p = activePlayer(state);

  let display = processEvents(state, [SW_HOPSCOTCH_COMPLETE], 1);
  assert.ok(!display.some((d) => d.kind === 'score'), 'completion itself pays nothing directly');
  assert.equal(p.modesState.hopscotchJackpot.lit, true);

  const before = p.score;
  display = processEvents(state, [SW_SLIDE_EXIT], 2);
  assert.equal(p.score - before, 500000, 'first completion this game');
  assert.equal(p.modesState.hopscotchJackpot.lit, false, 'unlit after being cashed in');
  assert.ok(display.some((d) => d.tag === 'hopscotch_jackpot'));

  processEvents(state, [SW_HOPSCOTCH_COMPLETE], 3);
  const before2 = p.score;
  processEvents(state, [SW_SLIDE_EXIT], 4);
  assert.equal(p.score - before2, 750000, 'second completion this game: +250,000');
});

test('linkage: MONKEY BARS every-3rd shot draws a HANG TIME award from the seeded PRNG, deterministically', () => {
  const stateA = freshGame(7);
  const stateB = freshGame(7);
  let displayA, displayB;
  for (let i = 0; i < 3; i++) {
    displayA = processEvents(stateA, [SW_MONKEYBARS_EXIT], i + 1);
    displayB = processEvents(stateB, [SW_MONKEYBARS_EXIT], i + 1);
  }
  const hangA = displayA.find((d) => d.kind === 'hangTime');
  const hangB = displayB.find((d) => d.kind === 'hangTime');
  assert.ok(hangA, 'the 3rd MONKEY BARS shot draws a HANG TIME award');
  assert.ok(['bonusX', 'ballSave', 'points'].includes(hangA.reward));
  assert.equal(hangA.reward, hangB.reward, 'same seed, same draw — deterministic');
});

test('linkage: THE SLIDE and TETHERBALL/TUNNEL combo multipliers build on consecutive shots and decay', () => {
  const state = freshGame();
  const p = activePlayer(state);

  let before = p.score;
  processEvents(state, [SW_SLIDE_EXIT], 0);
  assert.equal(p.score - before, 100000, 'first slide shot: base value, no combo yet');

  before = p.score;
  processEvents(state, [SW_SLIDE_EXIT], 1); // within the 8s decay window
  assert.equal(p.score - before, 200000, 'consecutive slide shot: 2x combo');

  before = p.score;
  processEvents(state, [SW_SLIDE_EXIT], 20); // 19s later — decayed
  assert.equal(p.score - before, 100000, 'combo decayed after 8s without a slide shot');

  // TUNNEL loops light TETHERBALL for 10,000/rev with their own consecutive-loop combo.
  processEvents(state, [SW_TUNNEL_EXIT], 21);
  before = p.score;
  processEvents(state, [SW_TETHERBALL_SPIN], 21);
  assert.equal(p.score - before, 10000, 'lit by a tunnel loop: 10,000/rev, 1x combo');

  processEvents(state, [SW_TUNNEL_EXIT], 22); // a second consecutive loop within 8s
  before = p.score;
  processEvents(state, [SW_TETHERBALL_SPIN], 22);
  assert.equal(p.score - before, 20000, '2x tunnel combo');

  before = p.score;
  processEvents(state, [SW_TETHERBALL_SPIN], 40); // long after the tunnel combo decayed
  assert.equal(p.score - before, 2500, 'falls back to the unlit base value once decayed');
});

test('linkage: 25 lifetime spring-rider hits light DODGEBALL at the SANDBOX out of turn', () => {
  const state = freshGame();
  const p = activePlayer(state);
  assert.ok(p.modesState.queue[0] !== 'DODGEBALL', 'DODGEBALL is not first in the default order');

  let atS = 1;
  for (let i = 0; i < 25; i++) processEvents(state, [SW_POP_DUCK], atS++);

  assert.equal(p.modesState.queue[0], 'DODGEBALL', 'moved to the front of the queue');
  assert.equal(p.modesState.sandboxLit, true, 'and the SANDBOX is lit for it');
});
