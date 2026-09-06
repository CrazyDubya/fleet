// Tests for the 'fieldday-lone-ball-drain' scenario (SBX-PARITY) — reproduces the
// FIELDDAY-FIX finding (games/pinball/rules/game.js's SW_TREEHOUSE branch, 2026-09-06) from a
// different vantage point than games/pinball/test/field-day.test.mjs's own regression test,
// which drives the same fix through direct-write preconditions (forceStartMode) this harness's
// rules-sequence contract rules out. See scenarios.js's own doc comment above SCENARIOS for
// the full rationale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, formatReport } from '../src/scenarios.js';

test('fieldday-lone-ball-drain: FIELD DAY is genuinely lit only after all 4 real mode completions (precondition)', () => {
  const r = runScenario('fieldday-lone-ball-drain');
  // Index -6 = right after JUMP_ROPE's own timeout (the step at atS=112) — the moment FIELD
  // DAY becomes lit, before TREEHOUSE is ever hit.
  const lightingStep = r.timeline.find((e) => e.step.atS === 112);
  assert.ok(lightingStep, 'must find the JUMP_ROPE timeout step');
  assert.equal(lightingStep.reads['modesState.fieldDayLit'], true, 'the 4th real mode completion must light FIELD DAY');
  const beforeLighting = r.timeline.find((e) => e.step.atS === 70);
  assert.equal(beforeLighting.reads['modesState.fieldDayLit'], false, 'not lit before all 4 are actually done — confirms this is earned, not a shortcut');
});

test('fieldday-lone-ball-drain: FIELD DAY starts with exactly one ball in play (the trigger ball, never captured) — precondition', () => {
  const r = runScenario('fieldday-lone-ball-drain');
  const startStep = r.timeline.find((e) => e.step.atS === 113);
  assert.ok(startStep.display.some((d) => d.kind === 'fieldDayStart'));
  assert.equal(startStep.reads['multiball.active'], true);
  assert.equal(startStep.reads['multiball.fieldDay'], true);
  assert.equal(startStep.reads['multiball.ballsInPlay'], 1, 'only the trigger ball — the 3 replacements have not landed yet');
  assert.equal(startStep.reads.bonusX, 25, 'the 25x lock engages at start');
});

test('fieldday-lone-ball-drain: FIXED — the lone ball draining inside the ball-save window is SAVED, not a force-end', () => {
  const r = runScenario('fieldday-lone-ball-drain');
  const drainStep = r.timeline.find((e) => e.step.atS === 114);
  assert.ok(
    drainStep.display.some((d) => d.kind === 'ballSaved'),
    'the drain must take the DO-OVER path, not endOfBall\'s'
  );
  assert.ok(
    !drainStep.display.some((d) => d.kind === 'fieldDayForceEnd' || d.kind === 'fieldDayEnd'),
    'REPRODUCED (fixed): a drain inside the ball-save window must not force-end FIELD DAY — before FIELDDAY-FIX, this exact drain ended it here'
  );
  assert.equal(drainStep.reads['multiball.active'], true, 'FIELD DAY is still running');
  assert.equal(drainStep.reads['multiball.fieldDay'], true);
  assert.equal(drainStep.reads.bonusX, 25, 'the 25x lock is untouched — FIELD DAY never actually ended');
});

test('fieldday-lone-ball-drain: the 3 already-scheduled replacement balls still land, reaching the full 4-ball count', () => {
  const r = runScenario('fieldday-lone-ball-drain');
  const last = r.timeline.at(-1);
  assert.equal(last.step.atS, 114.3);
  assert.equal(last.reads['multiball.ballsInPlay'], 4, 'reaches FIELD_DAY_BALL_COUNT, as designed — the save did not cost it any of the 3 replacements');
  assert.equal(last.reads['multiball.active'], true);
});

test('formatReport renders the fieldday-lone-ball-drain timeline', () => {
  const text = formatReport(runScenario('fieldday-lone-ball-drain'));
  assert.ok(text.includes('fieldday-lone-ball-drain'));
  assert.ok(text.includes('multiball.ballsInPlay'));
});
