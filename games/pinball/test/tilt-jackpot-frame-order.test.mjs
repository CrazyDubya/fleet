// SEAM-1: settles the frame-ordering risk flagged UNVERIFIED by
// ledger/handoffs/haiku-opencode2/20260905-tilt-jackpot-interaction.md (scenario #4) — if a
// tilt fires in the same frame MONKEY BARS is hit while the super jackpot is lit, does
// multiball.forceEnd beat collectSuperJackpot to the punch and silently discard 1,500,000
// points?
//
// It did. The first test below constructs the exact hazard at the rules layer (tiltBall
// called before the same frame's MONKEY BARS tag reaches processEvents) and reproduces the
// silent downgrade to ordinary MONKEY BARS points. Fixed in main.js: this frame's real
// physical collisions (frameMechanismTags, from processMechanismEvents) are now processed
// through processRules BEFORE the tilt check runs, instead of being batched with the rest of
// the frame's tags into one end-of-frame call — see main.js's own SEAM-1 comment at the top
// of frame(). The second test below constructs the FIXED order (processEvents runs first,
// tiltBall second — matching main.js's new order) and confirms the jackpot survives. Kept
// both as permanent regression tests: the first documents the hazard this ordering must keep
// avoiding, the second pins the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, launchBall, processEvents, activePlayer, tiltBall } from '../src/rules/game.js';
import { SWITCH_POINTS } from '../src/rules/scoring.js';
import {
  SW_TREEHOUSE, SW_MERRY_GO_ROUND, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_SANDBOX_ENTRY, SW_SLIDE_EXIT,
} from '../src/table/switches.js';

function freshGame(seed = 1) {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 3, seed });
  launchBall(state, 0);
  return state;
}

function lockThreeBalls(state) {
  for (let i = 0; i < 3; i++) {
    processEvents(state, [SW_TREEHOUSE], i * 2);
    processEvents(state, [SW_MERRY_GO_ROUND], i * 2 + 1);
  }
}

function collectOneJackpot(state, atSBase) {
  processEvents(state, [SW_MONKEYBARS_EXIT], atSBase);
  processEvents(state, [SW_TUNNEL_EXIT], atSBase + 1);
  processEvents(state, [SW_SANDBOX_ENTRY], atSBase + 2);
  return processEvents(state, [SW_SLIDE_EXIT], atSBase + 3);
}

test('super jackpot lit + tilt in the same frame as the MONKEY BARS hit: reproduces the silent loss', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);
  collectOneJackpot(state, 10);
  collectOneJackpot(state, 20);
  collectOneJackpot(state, 30); // 3rd collection lights the super jackpot
  assert.equal(p.multiball.superJackpotLit, true, 'setup: super jackpot must be lit before the constructed frame');
  const scoreBeforeFrame = p.score;

  // The constructed frame: tickTiltBob reports 'tilt' (main.js:1062) and tiltBall runs FIRST
  // (main.js:1063), synchronously force-ending multiball — before this same frame's scoreTags,
  // which already contain SW_MONKEYBARS_EXIT (captured earlier in the SAME frame at line 1045,
  // from this same physics tick's collision events), reach processRules (main.js:1140).
  const tiltDisplay = tiltBall(state, 40);
  assert.ok(tiltDisplay.some((d) => d.kind === 'multiballForceEnd'), 'setup: tilt must actually force-end multiball for this scenario to apply');
  assert.equal(p.multiball.active, false, 'multiball is already inactive by the time this frame\'s scoreTags are processed');
  assert.equal(p.multiball.superJackpotLit, false, 'forceEnd already cleared the lit flag before collectSuperJackpot ever runs');

  const monkeyBarsDisplay = processEvents(state, [SW_MONKEYBARS_EXIT], 40);

  // This is the bug: a super jackpot that was genuinely lit and genuinely earned (the ball
  // already landed MONKEY BARS with it lit) collapses to an ordinary MONKEY BARS hit, because
  // collectSuperJackpot's own `if (!m.active || ...) return 0` guard now reads m.active ===
  // false — set by forceEnd moments earlier in the exact same frame, for a reason (the tilt)
  // that has nothing to do with whether this collection was earned. Points are NOT zero (the
  // fallback ordinary-scoring branch in game.js still runs) — the loss is silent specifically
  // because a real, positive score event still fires, just for 1/10th the earned value, with
  // no signal anywhere that a super jackpot was in play at all.
  const ordinaryMonkeyBarsPoints = SWITCH_POINTS.get(SW_MONKEYBARS_EXIT);
  assert.ok(!monkeyBarsDisplay.some((d) => d.kind === 'superJackpotAwarded'),
    'REPRODUCED: no superJackpotAwarded event — confirms the frame-ordering risk is real, not merely reachable in theory');
  assert.equal(p.score - scoreBeforeFrame, ordinaryMonkeyBarsPoints,
    'REPRODUCED: only ordinary MONKEY BARS points are credited, not the super jackpot value');
  assert.equal(1500000 - ordinaryMonkeyBarsPoints > 0, true,
    'REPRODUCED: the gap between what was earned and what was credited is exactly the silently discarded amount');
});

test('fix: main.js\'s actual order (this frame\'s MONKEY BARS tag processed before the tilt check) preserves the super jackpot', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);
  collectOneJackpot(state, 10);
  collectOneJackpot(state, 20);
  collectOneJackpot(state, 30);
  assert.equal(p.multiball.superJackpotLit, true, 'setup: super jackpot must be lit before the constructed frame');
  const scoreBeforeFrame = p.score;

  // The fixed order: this frame's frameMechanismTags (which already contain SW_MONKEYBARS_EXIT,
  // from processMechanismEvents earlier in the same frame) are processed FIRST — matching
  // main.js's post-SEAM-1 frame(): applyDisplayEvents(processRules(rulesState,
  // frameMechanismTags, elapsedS)) runs before tickTiltBob's tilt handling.
  const monkeyBarsDisplay = processEvents(state, [SW_MONKEYBARS_EXIT], 40);
  assert.ok(monkeyBarsDisplay.some((d) => d.kind === 'superJackpotAwarded'),
    'FIXED: the collection is banked while multiball is still active, before the tilt gets a chance to force-end it');
  assert.equal(p.score - scoreBeforeFrame, 1500000, 'FIXED: the full super jackpot value is credited');

  // The tilt still fires and still ends the ball/multiball afterward — the fix only reorders
  // WHICH already-happened collision gets processed first, it doesn't suppress the tilt.
  const tiltDisplay = tiltBall(state, 40);
  assert.ok(tiltDisplay.some((d) => d.kind === 'multiballForceEnd'), 'the tilt itself still runs and still force-ends multiball, just after the collection was already banked');
  assert.equal(p.multiball.active, false);
});

test('control: the same collection order, without a same-frame tilt, awards the super jackpot normally', () => {
  const state = freshGame();
  const p = activePlayer(state);
  lockThreeBalls(state);
  collectOneJackpot(state, 10);
  collectOneJackpot(state, 20);
  collectOneJackpot(state, 30);
  assert.equal(p.multiball.superJackpotLit, true);
  const before = p.score;

  const display = processEvents(state, [SW_MONKEYBARS_EXIT], 40);
  assert.ok(display.some((d) => d.kind === 'superJackpotAwarded'));
  assert.equal(p.score - before, 1500000, 'control: without the same-frame tilt, the award goes through exactly as multiball.test.mjs already covers');
});
