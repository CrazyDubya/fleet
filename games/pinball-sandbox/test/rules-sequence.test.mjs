// Tests for the 'rules-sequence' scenario kind (SBX-SCENARIO-3) — the sandbox harness's first
// kind that stages a RULES situation instead of a physics one. See scenarios.js's own doc
// comment above SCENARIOS for the full rationale. Both scenarios below reproduce REAL bugs
// found and fixed on 2026-09-05 (LIT-1, SEAM-1) — from a different vantage point than the
// hand-written tests that first caught them (games/pinball/test/modes.test.mjs,
// games/pinball/test/tilt-jackpot-frame-order.test.mjs), never duplicating their assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, formatReport } from '../src/scenarios.js';

test("drain-with-mode-flags-lit: sandboxLit and hopscotchJackpot.lit are both genuinely earned before the drain (precondition)", () => {
  const r = runScenario('drain-with-mode-flags-lit');
  // Index 2 = the step right after both flags were earned (25 pop hits, then the HOPSCOTCH
  // completion), before the drain — confirms the setup actually worked, not just the outcome.
  assert.equal(r.timeline[2].reads['modesState.sandboxLit'], true);
  assert.equal(r.timeline[2].reads['modesState.hopscotchJackpot.lit'], true);
});

test('drain-with-mode-flags-lit: neither flag survives onto the next ball (LIT-1, reproduced through the real SW_DRAIN + launchBall path)', () => {
  const r = runScenario('drain-with-mode-flags-lit');
  const last = r.timeline.at(-1);
  assert.equal(last.step.type, 'launchBall');
  assert.equal(last.reads['modesState.sandboxLit'], false, 'sandboxLit must not carry over — see LIT-1');
  assert.equal(last.reads['modesState.hopscotchJackpot.lit'], false, 'hopscotchJackpot.lit must not carry over — see LIT-1');
});

test('drain-with-mode-flags-lit: the drain step itself (before the next ball is served) still shows both flags lit — the reset happens at launchBall, not at the drain', () => {
  const r = runScenario('drain-with-mode-flags-lit');
  const drainEntry = r.timeline.find((e) => e.step.type === 'events' && e.step.tags?.includes('drain'));
  assert.ok(drainEntry, 'must find the SW_DRAIN step');
  assert.equal(drainEntry.reads['modesState.sandboxLit'], true, 'the drain event alone does not reset ball-scoped state — resetForNewBall runs in launchBall');
  assert.equal(drainEntry.reads['modesState.hopscotchJackpot.lit'], true);
});

test('tilt-jackpot-same-tick: the setup genuinely lights the super jackpot before the constructed same-tick collision (precondition)', () => {
  const r = runScenario('tilt-jackpot-same-tick', { tiltFirst: true });
  const beforeSameTick = r.timeline.at(-3); // the 3rd jackpot collection, right before the tilt/event pair
  assert.equal(beforeSameTick.reads['multiball.superJackpotLit'], true, 'setup: super jackpot must be lit before the constructed same-tick steps');
});

test('tilt-jackpot-same-tick, hazard order (tiltFirst: true): the super jackpot award is lost — REPRODUCED', () => {
  const r = runScenario('tilt-jackpot-same-tick', { tiltFirst: true });
  const lastTwo = r.timeline.slice(-2);
  assert.equal(lastTwo[0].step.type, 'tilt', 'hazard order: tilt runs first');
  assert.equal(lastTwo[1].step.type, 'events');
  assert.ok(
    !lastTwo[1].display.some((d) => d.kind === 'superJackpotAwarded'),
    'REPRODUCED: no superJackpotAwarded — the same-frame tilt force-ended multiball before this tick\'s own MONKEY BARS tag reached processEvents'
  );
  assert.equal(lastTwo[1].reads['multiball.superJackpotLit'], false, 'already cleared by forceEnd, not by a legitimate collection');
});

test('tilt-jackpot-same-tick, fixed order (tiltFirst: false — main.js\'s actual order today): the award survives — FIXED', () => {
  const r = runScenario('tilt-jackpot-same-tick', { tiltFirst: false });
  const lastTwo = r.timeline.slice(-2);
  assert.equal(lastTwo[0].step.type, 'events', 'fixed order: the same-tick collision runs first');
  assert.equal(lastTwo[1].step.type, 'tilt');
  assert.ok(
    lastTwo[0].display.some((d) => d.kind === 'superJackpotAwarded'),
    'FIXED: the collection is banked while multiball is still active, before the tilt gets a chance to force-end it'
  );
});

test('formatReport renders each step\'s display-event kinds and the requested reads, for both rules-sequence scenarios', () => {
  const text1 = formatReport(runScenario('drain-with-mode-flags-lit'));
  assert.ok(text1.includes('drain-with-mode-flags-lit'));
  assert.ok(text1.includes('modesState.sandboxLit'));

  const text2 = formatReport(runScenario('tilt-jackpot-same-tick'));
  assert.ok(text2.includes('tilt-jackpot-same-tick'));
  assert.ok(text2.includes('multiball.superJackpotLit'));
});

test('an unknown step type is refused, not silently skipped', () => {
  assert.throws(
    () => runScenario('drain-with-mode-flags-lit', { steps: [{ type: 'bogus', atS: 0 }] }),
    /unknown step type/
  );
});

test('every scenario reports the step count it actually ran, including the initial launch', () => {
  const r = runScenario('drain-with-mode-flags-lit');
  assert.equal(r.stepsRun, r.timeline.length);
  assert.ok(r.stepsRun > 1);
});
