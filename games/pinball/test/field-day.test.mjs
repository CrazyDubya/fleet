// FIELD DAY (T9, the wizard mode — design doc §4.4, "Completing all four lights FIELD DAY at
// the TREEHOUSE. 4-ball multiball, all five shots lit for 2 000 000, relighting; every 5 shots
// the value doubles. Bonus X locked at 25×. Runs until one ball remains."). See
// rules/modes.js's FIELD_DAY_* constants and startFieldDay, rules/multiball.js's startFieldDay,
// and rules/game.js's SW_TREEHOUSE branch / early FIELD_DAY_SHOT_TAGS check for the four scope
// decisions this dispatch asked to be made and stated:
//   1. `completed` resets at FIELD DAY's START, not its end — consumed like every other
//      "you earned this" flag (LIT-1's own precedent).
//   2. The 25x bonus lock reverts to whatever bonusX was immediately before FIELD DAY, when
//      FIELD DAY ends — not reset to 1, not left at 25.
//   3. The doubling is scoped to a single FIELD DAY run, not cumulative across the game.
//   4. FIELD DAY reuses multiball.js's own ball-count lifecycle (active/ballsInPlay/
//      onBallAdded/onBallLost) — the same "how many balls are in play, ending at 1" fact
//      RECESS MULTIBALL already tracks — but never touches its jackpot/add-a-ball fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, launchBall, processEvents, activePlayer } from '../src/rules/game.js';
import { MODE_DURATION_S, FIELD_DAY_BASE_VALUE, FIELD_DAY_BONUS_X, FIELD_DAY_BALL_COUNT } from '../src/rules/modes.js';
import {
  SW_TREEHOUSE, SW_BALL_ADDED, SW_BALL_LOST, SW_DRAIN,
  SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_SANDBOX_ENTRY, SW_ORBIT_EXIT,
  SW_POP_DUCK, SW_FUN_COMPLETE,
} from '../src/table/switches.js';

function freshGame(seed = 1) {
  const state = createGame({ numPlayers: 1, ballsPerPlayer: 3, seed });
  launchBall(state, 0);
  return state;
}

/** White-box shortcut (same pattern as test/modes.test.mjs's own forceStartMode): forces
 * `name` to the front of the queue and starts it, so each of the four base modes can be
 * completed on its own real completion path without waiting on the other three or the
 * queue's own natural order. */
function forceStartMode(state, name, atS) {
  const p = activePlayer(state);
  p.modesState.queue = [name, ...p.modesState.queue.filter((m) => m !== name)];
  p.modesState.sandboxLit = true;
  const display = processEvents(state, [SW_SANDBOX_ENTRY], atS);
  assert.ok(display.some((d) => d.kind === 'modeStart' && d.mode === name), `${name} did not start`);
}

/** Completes `name` via ITS OWN real success path (never a shortcut that merely marks it
 * done) — KICKBALL's four bases in order, DODGEBALL's 20 pop hits, HIDE_SEEK/JUMP_ROPE's own
 * 40s timeout (both modes' real completion condition, per modes.js's tickModes — HIDE_SEEK
 * never completes by hit count, and an unspun JUMP_ROPE completes at exactly its own
 * MODE_DURATION_S, per its own `elapsed >= MODE_DURATION_S` success clause). Returns the
 * display array from the completing event. */
function completeMode(state, name, atS) {
  forceStartMode(state, name, atS);
  if (name === 'KICKBALL') {
    processEvents(state, [SW_SLIDE_EXIT], atS + 1);
    processEvents(state, [SW_MONKEYBARS_EXIT], atS + 2);
    processEvents(state, [SW_TUNNEL_EXIT], atS + 3);
    return processEvents(state, [SW_SANDBOX_ENTRY], atS + 4);
  }
  if (name === 'DODGEBALL') {
    let display;
    for (let i = 0; i < 20; i++) display = processEvents(state, [SW_POP_DUCK], atS + 1 + i);
    return display;
  }
  // HIDE_SEEK and JUMP_ROPE: tickModes fires on ANY processEvents call once enough time has
  // elapsed — an empty event batch at exactly startAtS + MODE_DURATION_S is enough.
  return processEvents(state, [], atS + MODE_DURATION_S);
}

/** Completes all four base modes in MODE_ORDER, asserting each one actually finished, and
 * returns the display array from the fourth (the one that should light FIELD DAY). */
function completeAllFourModes(state) {
  let atS = 1;
  let display;
  for (const name of ['KICKBALL', 'HIDE_SEEK', 'DODGEBALL', 'JUMP_ROPE']) {
    display = completeMode(state, name, atS);
    assert.ok(display.some((d) => d.kind === 'modeEnd' && d.mode === name), `${name} did not report modeEnd`);
    atS += 100;
  }
  return display;
}

test('completing all four base modes lights FIELD DAY at the TREEHOUSE (decision #1: `completed` has not been touched yet — still lights on the natural queue order)', () => {
  const state = freshGame();
  const p = activePlayer(state);
  assert.equal(p.modesState.fieldDayLit, false);
  completeAllFourModes(state);
  assert.equal(p.modesState.fieldDayLit, true);
  assert.equal(p.modesState.completed.length, 4);
});

test('TREEHOUSE while FIELD DAY is lit starts it: 4-ball multiball, 25x bonus lock, `completed` reset at START (decision #1)', () => {
  const state = freshGame();
  const p = activePlayer(state);
  completeAllFourModes(state);
  p.bonusX = 3; // simulate some ordinary pre-FIELD-DAY bonus X progress this ball

  const display = processEvents(state, [SW_TREEHOUSE], 1000);
  assert.ok(display.some((d) => d.kind === 'fieldDayStart'), 'must report fieldDayStart');

  // Reuses multiball.js's own ball-count lifecycle (decision #4) — active + a distinct
  // `fieldDay` tag, not a second parallel "is a wizard mode running" flag.
  assert.equal(p.multiball.active, true);
  assert.equal(p.multiball.fieldDay, true);
  // The triggering ball (a TREEHOUSE standup hit, not a capture) is already one of the 4 and
  // was never "added" — starts at 1, climbs to FIELD_DAY_BALL_COUNT via 3 more SW_BALL_ADDED.
  assert.equal(p.multiball.ballsInPlay, 1);

  // 25x bonus lock (decision #2's "start" half).
  assert.equal(p.bonusX, FIELD_DAY_BONUS_X);
  assert.ok(display.some((d) => d.kind === 'bonusX' && d.value === FIELD_DAY_BONUS_X));

  // `completed` reset at START (decision #1), not left sitting at length 4 for the whole run.
  assert.deepEqual(p.modesState.completed, []);
  assert.equal(p.modesState.fieldDayLit, false, 'consumed — the flag does not stay lit through the run');

  // FIELD DAY's own scoring state starts fresh.
  assert.equal(p.modesState.fieldDay.shotsHit, 0);
  assert.equal(p.modesState.fieldDay.value, FIELD_DAY_BASE_VALUE);
});

test('four-ball start: 3 SW_BALL_ADDED (the 3 new balls main.js spawns) bring ballsInPlay to FIELD_DAY_BALL_COUNT', () => {
  const state = freshGame();
  const p = activePlayer(state);
  completeAllFourModes(state);
  processEvents(state, [SW_TREEHOUSE], 1000);
  assert.equal(p.multiball.ballsInPlay, 1);
  processEvents(state, [SW_BALL_ADDED, SW_BALL_ADDED, SW_BALL_ADDED], 1001);
  assert.equal(p.multiball.ballsInPlay, FIELD_DAY_BALL_COUNT);
  assert.equal(FIELD_DAY_BALL_COUNT, 4, "design doc's own \"4-ball multiball\"");
});

test('all five shots are lit for 2,000,000 during FIELD DAY, overriding their ordinary scoring/side-effects, and relight (no lock-out)', () => {
  const state = freshGame();
  const p = activePlayer(state);
  completeAllFourModes(state);
  processEvents(state, [SW_TREEHOUSE], 1000);
  processEvents(state, [SW_BALL_ADDED, SW_BALL_ADDED, SW_BALL_ADDED], 1001);

  for (const tag of [SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_SANDBOX_ENTRY, SW_ORBIT_EXIT]) {
    const before = p.score;
    const display = processEvents(state, [tag], 1002);
    assert.equal(p.score - before, FIELD_DAY_BASE_VALUE, `${tag} must score the FIELD DAY value, not its ordinary points`);
    assert.ok(display.some((d) => d.kind === 'score' && d.tag === 'field_day' && d.points === FIELD_DAY_BASE_VALUE));
    // Overrides ordinary side-effects: no mode start, no multiball jackpot lighting, no
    // add-a-ball — none of those display kinds should appear for a FIELD DAY shot.
    assert.ok(!display.some((d) => ['modeStart', 'lamp', 'addABall', 'jackpotValue'].includes(d.kind)));
  }
  // "relighting" — nothing about hitting all five once locks any of them out; the same shot
  // scores again immediately (at the now-doubled value — 5 shots have been hit at this point,
  // so the value has already stepped up once; see the doubling test below for that half).
  const before = p.score;
  processEvents(state, [SW_SLIDE_EXIT], 1010);
  assert.equal(p.score - before, FIELD_DAY_BASE_VALUE * 2, 'SLIDE relights and scores again, at the current (now-doubled) value, never a one-shot lockout');
});

test('the value doubles every 5 shots, scoped to this FIELD DAY run (decision #3) — not before it starts, not cumulative across separate runs', () => {
  const state = freshGame();
  const p = activePlayer(state);
  completeAllFourModes(state);
  processEvents(state, [SW_TREEHOUSE], 1000);
  processEvents(state, [SW_BALL_ADDED, SW_BALL_ADDED, SW_BALL_ADDED], 1001);

  const tags = [SW_SLIDE_EXIT, SW_MONKEYBARS_EXIT, SW_TUNNEL_EXIT, SW_SANDBOX_ENTRY, SW_ORBIT_EXIT];
  for (let i = 0; i < 4; i++) {
    const before = p.score;
    processEvents(state, [tags[i]], 1002 + i);
    assert.equal(p.score - before, FIELD_DAY_BASE_VALUE, `shot ${i + 1} of 5 must still be at the base value`);
  }
  // 5th shot: still scores the base value (the doubling applies going FORWARD from the 5th,
  // not retroactively to it — modes.js's onFieldDayShot doubles AFTER crediting this shot).
  let before = p.score;
  processEvents(state, [tags[4]], 1006);
  assert.equal(p.score - before, FIELD_DAY_BASE_VALUE, '5th shot is the last one at the base value');
  assert.equal(p.modesState.fieldDay.value, FIELD_DAY_BASE_VALUE * 2);

  // 6th shot: now doubled.
  before = p.score;
  processEvents(state, [tags[0]], 1007);
  assert.equal(p.score - before, FIELD_DAY_BASE_VALUE * 2, '6th shot must be doubled');
});

test('bonus X is locked at 25x for the run: an F-U-N completion during FIELD DAY does not change it', () => {
  const state = freshGame();
  const p = activePlayer(state);
  completeAllFourModes(state);
  processEvents(state, [SW_TREEHOUSE], 1000);
  assert.equal(p.bonusX, FIELD_DAY_BONUS_X);

  // Without the lock, SW_FUN_COMPLETE would run `Math.min(BONUS_X_MAX, bonusX + 1)` with
  // BONUS_X_MAX=10, which would actually LOWER bonusX from 25 to 10 — the exact regression
  // this guard exists to prevent, not just an unwanted increment.
  const display = processEvents(state, [SW_FUN_COMPLETE], 1001);
  assert.equal(p.bonusX, FIELD_DAY_BONUS_X, 'bonusX must stay locked at 25x through an F-U-N completion');
  assert.ok(!display.some((d) => d.kind === 'bonusX'), 'no bonusX display event during the lock');
});

test('FIELD DAY runs until one ball remains, then ends: bonus X restored to its pre-FIELD-DAY value (decision #2\'s "end" half), fieldDaysCompleted counted', () => {
  const state = freshGame();
  const p = activePlayer(state);
  completeAllFourModes(state);
  p.bonusX = 4;
  processEvents(state, [SW_TREEHOUSE], 1000); // bonusX -> 25, bonusXBeforeFieldDay saved as 4
  processEvents(state, [SW_BALL_ADDED, SW_BALL_ADDED, SW_BALL_ADDED], 1001); // 4 balls in play
  assert.equal(p.modesState.fieldDaysCompleted, 0);

  processEvents(state, [SW_BALL_LOST], 1002); // 4 -> 3
  assert.equal(p.multiball.active, true, 'still running with 3 balls');
  processEvents(state, [SW_BALL_LOST], 1003); // 3 -> 2
  assert.equal(p.multiball.active, true, 'still running with 2 balls');

  const display = processEvents(state, [SW_BALL_LOST], 1004); // 2 -> 1: ends
  assert.ok(display.some((d) => d.kind === 'fieldDayEnd'));
  assert.equal(p.multiball.active, false);
  assert.equal(p.multiball.fieldDay, false);
  assert.equal(p.bonusX, 4, 'restored to the pre-FIELD-DAY value, not left at 25 and not reset to 1');
  assert.ok(display.some((d) => d.kind === 'bonusX' && d.value === 4));
  assert.equal(p.modesState.fieldDaysCompleted, 1);

  // The one remaining ball keeps playing normally under the restored bonusX; its own eventual
  // drain computes the RECESS BELL bonus with THAT value, not 25. Well past both the 12s
  // launch DO-OVER window AND FIELD DAY's own 20s-from-start ball-save (FIELDDAY-FIX: FIELD
  // DAY start now grants one, atS 1000-1020 — see the SW_TREEHOUSE branch in game.js — so this
  // drain has to land after 1020, not just after the original 12s launch window, to actually
  // end the ball rather than being saved).
  const drainDisplay = processEvents(state, [SW_DRAIN], 1025);
  const bonusEvent = drainDisplay.find((d) => d.kind === 'bonus');
  assert.ok(bonusEvent, 'the drain must end the ball and compute the RECESS BELL bonus');
  assert.equal(bonusEvent.bonusX, 4, 'end-of-ball bonus must use the restored bonusX, not the 25x FIELD DAY lock');
});

// FIELDDAY-FIX (playtest, sonnet3 20260905T230811Z): FIELD DAY starts with only ONE ball
// physically on the table — the TREEHOUSE hit is a standup target, so the triggering ball is
// never captured, unlike RECESS MULTIBALL's 3rd-lock balls (already mounted/captured, so
// nothing is left on the table that CAN drain during their own staggered release). The 3 new
// balls main.js spawns arrive staggered ~400ms apart, not instantly. Before this fix, if that
// lone ball reached the drain in the gap before the 3rd new ball landed, `endOfBall`'s
// `multiball.forceEnd` safety net correctly-but-prematurely ended FIELD DAY — reproduced by
// actually playing it: TREEHOUSE hit, "FIELD DAY!" flash, "FIELD DAY COMPLETE" ~2s later,
// `ballsInPlay` never having left 1.
test('FIELD DAY survives the lone starting ball draining before the other 3 land: ball-saved, not force-ended', () => {
  const state = freshGame();
  const p = activePlayer(state);
  completeAllFourModes(state);
  processEvents(state, [SW_TREEHOUSE], 1000); // FIELD DAY starts; ballsInPlay = 1 (the trigger ball)
  assert.equal(p.multiball.active, true);
  assert.equal(p.multiball.ballsInPlay, 1);

  // The lone trigger ball drains before any of the 3 new balls have arrived — exactly the
  // race the playtest found, well within the 20s window the fix grants at FIELD DAY start.
  const drainDisplay = processEvents(state, [SW_DRAIN], 1001);
  assert.ok(!drainDisplay.some((d) => d.kind === 'fieldDayForceEnd' || d.kind === 'fieldDayEnd'),
    'a drain inside the ball-save window must not force-end FIELD DAY');
  assert.equal(p.multiball.active, true, 'FIELD DAY is still running');
  assert.equal(p.bonusX, FIELD_DAY_BONUS_X, 'the 25x lock is untouched — FIELD DAY never actually ended');
  assert.ok(drainDisplay.some((d) => d.kind === 'ballSaved'), 'the drain must take the DO-OVER path');
  assert.equal(p.ballActive, true);

  // The 3 already-scheduled spawns still land on schedule (main.js's fieldDayReleaseQueue is
  // independent of this drain) and reach the full 4-ball count as designed — ballsInPlay is
  // untouched by the save (no onBallLost ran), so it climbs the same 1 -> 4 it always did.
  processEvents(state, [SW_BALL_ADDED, SW_BALL_ADDED, SW_BALL_ADDED], 1002);
  assert.equal(p.multiball.ballsInPlay, FIELD_DAY_BALL_COUNT, 'reaches the full 4-ball count');
});
