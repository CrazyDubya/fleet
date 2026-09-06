// ui/moment-screen.js's pure bookkeeping and content logic — createMomentScreen itself
// touches the DOM (see that file's own doc comment on why the logic is split out to be
// testable here without one, the same pattern test/callouts.test.mjs already uses).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMomentState, setMoment, clearMomentIfCurrent, clearMomentScope, bonusBreakdownLines,
} from '../src/ui/moment-screen.js';

test('a new moment replaces whatever was showing, immediately', () => {
  const state = createMomentState();
  setMoment(state, ['first']);
  assert.deepEqual(state.current.lines, ['first']);
  setMoment(state, ['second']);
  assert.deepEqual(state.current.lines, ['second'], 'the second moment replaces the first outright, not queued behind it');
});

test('a stale dismiss (by id) cannot clear a NEWER moment that has already replaced it', () => {
  const state = createMomentState();
  const firstId = setMoment(state, ['ball 1 bonus']);
  setMoment(state, ['ball 2 bonus']); // ball 2's own bonus superseded ball 1's before ball 1's timer fired
  clearMomentIfCurrent(state, firstId); // ball 1's own (late) dismiss timer finally fires
  assert.deepEqual(state.current.lines, ['ball 2 bonus'], 'a stale clear for an old id must not touch the current, newer moment');
});

test('clearing an id that was never current is a no-op', () => {
  const state = createMomentState();
  setMoment(state, ['only moment']);
  clearMomentIfCurrent(state, 999);
  assert.deepEqual(state.current.lines, ['only moment']);
});

test('MOMENT-SCOPE regression: a moment survives the boundary that generated it, and is force-cleared one boundary later if nothing replaced it', () => {
  // Mirrors main.js's own onNewBall lagging: at each "new ball," clear the scope from BEFORE
  // the one just ending, never the one just ending (which may have just been shown in this
  // exact transition and must survive it) — see moment-screen.js's own MOMENT-SCOPE doc
  // comment for why a same-generation clear would hide a moment before it ever paints.
  const state = createMomentState();
  let ballGeneration = 1, previousBallGeneration = -1;
  function onNewBall() {
    clearMomentScope(state, `ball:${previousBallGeneration}`);
    previousBallGeneration = ballGeneration;
    ballGeneration += 1;
  }

  // Ball 1 ends with a bonus.
  setMoment(state, ['ball 1 bonus'], `ball:${ballGeneration}`); // scope ball:1
  onNewBall(); // ball 2 starts (this is the SAME transition the bonus was shown in) — must survive
  assert.deepEqual(state.current.lines, ['ball 1 bonus'], 'the moment just shown for the ball that just ended must not be cleared by that same ball\'s own new-ball transition');

  // Ball 2 drains instantly with a ZERO bonus — nothing replaces ball 1's moment.
  onNewBall(); // ball 3 starts
  assert.equal(state.current, null, 'once a ball has fully passed with nothing new shown, the stale moment must be gone by the ball after that');
});

test('a moment tied to a DIFFERENT scope is left alone', () => {
  const state = createMomentState();
  setMoment(state, ['ball moment'], 'ball:5');
  assert.equal(clearMomentScope(state, 'game:5'), false, 'a game-scoped clear must never match a ball-scoped moment even with the same bare number');
  assert.deepEqual(state.current.lines, ['ball moment']);
});

test('a moment with no scope is never cleared by clearMomentScope', () => {
  const state = createMomentState();
  setMoment(state, ['unscoped moment']);
  assert.equal(clearMomentScope(state, 'ball:1'), false);
  assert.deepEqual(state.current.lines, ['unscoped moment']);
});

test('HUD-BUILD regression: a zero bonus produces no lines at all — not a breakdown of zeros', () => {
  const zero = bonusBreakdownLines({ amount: 0, bonusX: 1, playtimePoints: 0, shotsPoints: 0, modesPoints: 0 });
  assert.equal(zero, null, 'a scoreless ball must show nothing, per the dispatch: an itemized zero looks like something happened when it didn\'t');
});

test('a non-zero bonus produces a labeled breakdown whose components appear alongside the total', () => {
  const lines = bonusBreakdownLines({ amount: 130000, bonusX: 2, playtimePoints: 50000, shotsPoints: 15000, modesPoints: 0 });
  assert.ok(Array.isArray(lines));
  assert.ok(lines.some((l) => l.includes('130,000')), 'total must be shown');
  assert.ok(lines.some((l) => l.includes('50,000')));
  assert.ok(lines.some((l) => l.includes('15,000')));
  assert.ok(lines.some((l) => l.includes('BONUS X2')));
});
