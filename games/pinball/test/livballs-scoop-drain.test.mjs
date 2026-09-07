// LIVEBALLS-DRAIN (opus2, ledger/handoffs/opus2/20260907T060000Z-semantic-audit-run.md):
// main.js's drain loop used to compute `liveBallsRemaining` as
// `balls.filter((b) => !b.phys.captured).length` — excluding any ball currently held in the
// SANDBOX scoop, even though a captured-but-not-drained ball is still physically in the
// machine and about to be ejected, not gone. If the last FREE ball drained while another ball
// sat in the scoop's SCOOP_HOLD_S window, this read as 0 live balls, drainTagFor returned
// SW_DRAIN (ball over), and the ball ended with a ball still on the playfield/in the scoop.
//
// main.js itself isn't importable under node --test (bare 'three' specifier — see
// glue-scope.test.mjs, and scoop-orphan.test.mjs's own note on the same constraint), so this
// mirrors main.js's exact drain-loop shape closely enough to exercise the real bug/fix:
// `balls` only ever holds entries still physically in the machine (a drained entry is spliced
// out — main.js's despawnBall does this — before the live count is taken), and the fixed
// formula is simply the remaining array's length, not a filter over `captured`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drainTagFor, SW_DRAIN, SW_BALL_LOST } from '../src/table/switches.js';

// The fixed liveBallsRemaining computation, verbatim shape from main.js's drain loop
// (main.js:1610-1616): `entry` has already been removed from `balls` by despawnBall before
// this runs, by the time this function is called.
function liveBallsRemainingAfterDespawn(ballsAfterDespawn) {
  return ballsAfterDespawn.length;
}

// The PRE-FIX formula, kept here only to prove the repro actually distinguishes the two —
// not imported from anywhere, since the real source no longer contains it.
function buggyLiveBallsRemaining(ballsAfterDespawn) {
  return ballsAfterDespawn.filter((b) => !b.phys.captured).length;
}

test('scoop-hold-then-drain: a ball held in the sandbox scoop counts as live for the drain decision', () => {
  // The last FREE ball just drained (already removed from `balls` by despawnBall) while one
  // ball remains, captured, mid SCOOP_HOLD_S — exactly opus2's repro row 1.
  const remaining = [{ id: 'held', phys: { captured: true } }];

  const fixedCount = liveBallsRemainingAfterDespawn(remaining);
  assert.equal(fixedCount, 1, 'a captured (held-in-scoop) ball must still count as live');
  assert.equal(drainTagFor({ liveBallsRemaining: fixedCount }), SW_BALL_LOST,
    'the ball must NOT be called over while another ball is still in the scoop, about to be ejected');

  // Prove this is a real fix, not a test that would have passed either way: the old formula
  // reads 0 live balls for the identical state and calls the ball over.
  const buggyCount = buggyLiveBallsRemaining(remaining);
  assert.equal(buggyCount, 0, 'sanity check: the pre-fix formula really did miscount this state');
  assert.equal(drainTagFor({ liveBallsRemaining: buggyCount }), SW_DRAIN,
    'sanity check: the pre-fix formula really did end the ball while one was still held');
});

test('scoop-hold-then-drain: a free ball remaining still reads as ball-lost (unaffected by the fix)', () => {
  const remaining = [{ id: 'free', phys: { captured: false } }];
  const count = liveBallsRemainingAfterDespawn(remaining);
  assert.equal(count, 1);
  assert.equal(drainTagFor({ liveBallsRemaining: count }), SW_BALL_LOST);
});

test('nothing else in play: the last ball draining with an empty scoop is a real SW_DRAIN', () => {
  const remaining = [];
  const count = liveBallsRemainingAfterDespawn(remaining);
  assert.equal(count, 0);
  assert.equal(drainTagFor({ liveBallsRemaining: count }), SW_DRAIN,
    'a genuinely empty table must still end the ball — the fix must not paper over real drains');
});
