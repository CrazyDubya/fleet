// SCOOP-1 (2026-09-05): armScoop's own doc comment used to call a second ball entering the
// sandbox before the first ejects "a rare edge case... not worth a queue for T8" — an outside
// review checked the actual consequence rather than accepting that framing. main.js's own drain
// loop skips `captured` balls, counts only non-captured balls as live, and clears `captured`
// only on the ball(s) an eject actually touches. Under the old single `scoop.ball` field, a
// second entry overwrote the first ball's reference entirely — nothing in main.js ever touched
// it again, so its `captured` flag stayed `true` forever: it never drained, never counted as
// live, and could never be reached again. A ball silently vanished mid-game.
//
// Reproduced directly (not assumed) before writing the fix: with `createScoop` reverted to
// `{ ejectAt, ball: null }` and `armScoop`/`tickScoop` reverted to their pre-fix single-ball
// form, this exact test — two balls captured within the one-second hold, both ejects allowed to
// run — left ball1 with `captured: true` after both scoop.tickScoop calls returned, exactly as
// described. Restored to the real (fixed) source before this file was committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScoop, armScoop, tickScoop } from '../src/game/mechanisms.js';

// Mirrors main.js's own eject application (main.js's SANDBOX scoop block) closely enough to
// exercise the real bug/fix: every ball tickScoop hands back gets captured=false and a fresh
// pos/vel, exactly as main.js does — main.js itself isn't importable under node --test (bare
// 'three' specifier — see glue-scope.test.mjs).
function applyEject(ejectedBalls) {
  if (!ejectedBalls) return;
  for (const ball of ejectedBalls) {
    ball.pos = { x: 0, y: 0 };
    ball.vel = { x: 0, y: 1 };
    ball.captured = false;
  }
}

test('a second ball entering the sandbox during the first ball\'s hold does not orphan the first — both are ejected, neither stays captured', () => {
  const scoop = createScoop();
  const ball1 = { id: 'b1', captured: true };
  const ball2 = { id: 'b2', captured: true };

  armScoop(scoop, 0.0, ball1); // ball1 captured at t=0, hold set to eject at t=1.0
  armScoop(scoop, 0.5, ball2); // ball2 captured at t=0.5, BEFORE ball1 would have ejected — hold extends to t=1.5

  // Nothing ejects at ball1's original t=1.0 — the hold was extended by ball2's entry, exactly
  // as it always has been (a second entry re-arms the SAME shared timer).
  assert.equal(tickScoop(scoop, 1.0), null, 'the hold was extended by the second entry — nothing should eject yet at the original t=1.0');
  assert.equal(ball1.captured, true, 'still captured — the hold has not elapsed');

  // At t=1.5, BOTH balls eject together.
  const ejected = tickScoop(scoop, 1.5);
  assert.ok(ejected, 'expected an eject at the extended hold time');
  assert.equal(ejected.length, 2, 'both balls that were captured during the hold must be in the eject batch');
  assert.ok(ejected.includes(ball1), 'ball1 must not have been silently dropped when ball2 arrived');
  assert.ok(ejected.includes(ball2));

  applyEject(ejected);
  assert.equal(ball1.captured, false, 'ball1 must be recovered — captured cleared, reachable and drainable again, not orphaned forever');
  assert.equal(ball2.captured, false);
});

test('a single ball captured and ejected with nobody else entering behaves exactly as before this fix', () => {
  const scoop = createScoop();
  const ball1 = { id: 'b1', captured: true };
  armScoop(scoop, 0.0, ball1);
  assert.equal(tickScoop(scoop, 0.5), null);
  const ejected = tickScoop(scoop, 1.0);
  assert.deepEqual(ejected, [ball1]);
  applyEject(ejected);
  assert.equal(ball1.captured, false);
});

test('three balls captured in quick succession during multiball all eject together, none orphaned', () => {
  const scoop = createScoop();
  const balls = [{ id: 'a', captured: true }, { id: 'b', captured: true }, { id: 'c', captured: true }];
  armScoop(scoop, 0.0, balls[0]);
  armScoop(scoop, 0.2, balls[1]);
  armScoop(scoop, 0.4, balls[2]);
  const ejected = tickScoop(scoop, 1.4); // last entry's hold: 0.4 + 1.0
  assert.equal(ejected.length, 3);
  for (const b of balls) assert.ok(ejected.includes(b));
  applyEject(ejected);
  for (const b of balls) assert.equal(b.captured, false);
});
