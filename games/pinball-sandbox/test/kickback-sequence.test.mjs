// Tests for the 'kickback-fires-once-per-ball' scenario (SBX-PARITY) — reproduces the
// kickback `lit` finding recorded in games/pinball/src/game/mechanisms.js's own tryKickback
// doc comment (2026-09-05): a successful fire correctly set `usedThisBall` but left `lit`
// untouched, so main.js's mesh (which reads `lit` alone) kept showing the kickback as armed
// for the rest of the ball even though a second contact was already being silently refused.
// See scenarios.js's own doc comment above SCENARIOS for why this needed its own scenario
// kind rather than fitting 'rules-sequence'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, formatReport } from '../src/scenarios.js';

test('kickback-fires-once-per-ball: a new ball starts with the kickback lit (precondition)', () => {
  const r = runScenario('kickback-fires-once-per-ball');
  const first = r.timeline[0];
  assert.equal(first.step.type, 'newBall');
  assert.equal(first.lit, true, 'KICKBACK_STARTS_LIT — a fresh ball must start armed');
  assert.equal(first.usedThisBall, false);
});

test('kickback-fires-once-per-ball: FIXED — the first contact fires AND clears `lit`, not just `usedThisBall`', () => {
  const r = runScenario('kickback-fires-once-per-ball');
  const firstFire = r.timeline[1];
  assert.equal(firstFire.step.type, 'fire');
  assert.equal(firstFire.result.fired, true, 'the first contact this ball must actually fire');
  assert.equal(
    firstFire.lit, false,
    'REPRODUCED (fixed): before this fix, `lit` stayed true here even though the kickback had already fired — a reader (or main.js\'s own mesh material choice) checking `lit` alone would see "still armed" for a kickback that had already spent its one use'
  );
  assert.equal(firstFire.usedThisBall, true);
});

test('kickback-fires-once-per-ball: a second contact the same ball is refused, and stays unlit', () => {
  const r = runScenario('kickback-fires-once-per-ball');
  const secondFire = r.timeline[2];
  assert.equal(secondFire.result.fired, false, 'usedThisBall must block a second use the same ball');
  assert.equal(secondFire.lit, false, 'not re-lit by a refused attempt');
});

test('formatReport renders the kickback-fires-once-per-ball timeline', () => {
  const text = formatReport(runScenario('kickback-fires-once-per-ball'));
  assert.ok(text.includes('kickback-fires-once-per-ball'));
  assert.ok(text.includes('usedThisBall'));
});

test('an unknown step type is refused, not silently skipped', () => {
  assert.throws(
    () => runScenario('kickback-fires-once-per-ball', { steps: [{ type: 'bogus' }] }),
    /unknown step type/
  );
});
