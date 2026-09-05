// Standing scenario port of the 81-sample ramp-exit-to-flipper reachability sweep methodology
// (see src/scenarios.js's 'ramp-reachability' kind doc comment). Each test below reproduces a
// figure that was already published — either as a hand-written test's own pinned assertion
// (orbit) or as a comment recording a one-off scratch measurement (slide, monkey bars) — never
// a fresh guess at what these should measure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, formatReport } from '../src/scenarios.js';

test('orbit-reachability-right: THE ORBIT exit reaches the right flipper in 81/81 samples, 46/81 mid-bat', () => {
  // Reproduces games/pinball/test/orbit-reachability.test.mjs's own pinned figure (81/81
  // contact) and table/ramps.js's buildOrbitRamp doc comment ("81/81 contact, 46/81 mid-bat").
  const r = runScenario('orbit-reachability-right');
  assert.equal(r.total, 81, 'the sweep must run the full 3x3x3x3 = 81 samples');
  assert.equal(
    r.contact, 81,
    `THE ORBIT's exit reachability regressed from the measured 81/81 — got ${r.contact}/${r.total}; ` +
    "this must agree with games/pinball/test/orbit-reachability.test.mjs's own pinned figure — " +
    'if it does not, one of the two measurements is wrong, not this assertion.'
  );
  assert.equal(r.midBat, 46, `mid-bat regressed from the published 46/81 — got ${r.midBat}/${r.total}`);
});

test("monkeybars-reachability-upperLeft: MONKEY BARS' exit reaches the upper-left flipper in 81/81, mid-bat in all 81", () => {
  // Reproduces table/ramps.js's buildMonkeyBarsRamp doc comment verbatim: "contact in 81/81
  // samples ... mid-bat in all 81."
  const r = runScenario('monkeybars-reachability-upperLeft');
  assert.equal(r.total, 81);
  assert.equal(r.contact, 81, `MONKEY BARS' exit reachability regressed from the published 81/81 — got ${r.contact}/${r.total}`);
  assert.equal(r.midBat, 81, `MONKEY BARS' exit mid-bat regressed from the published "all 81" — got ${r.midBat}/${r.total}`);
});

test('slide-reachability-left: contact matches the published 81/81, but mid-bat DISAGREES with the published 66/81 — a stale figure, not a porting bug', () => {
  // table/ramps.js's buildSlideRamp doc comment (2026-09-04, commit c2ac18e): "contact in
  // 81/81 samples ... mid-bat in 66 of the same 81 samples." Measured here TODAY: contact is
  // still 81/81, but mid-bat measures 81/81, not 66/81.
  //
  // Root cause, traced rather than assumed: commit d901cbf (2026-09-05, the day AFTER the
  // slide's own re-aim measurement) corrected how the 'flip-at-arrival' flipper state is
  // simulated — it had been wrongly treated as indistinguishable from a statically-active
  // flipper; the fix made it a real mid-swing catch, which measurably moves the along-bat
  // contact point for every ramp using that state (that same commit's own message reports
  // SLIDE's alongBat moving from 0.464 to 0.590 between 'active' and the corrected
  // 'flip-at-arrival' — enough to move some of the 27 non-mid-bat samples from the old 66/81
  // figure into mid-bat range). The slide's own geometry has not changed since the 66/81
  // figure was recorded; the measurement METHOD it was measured under has. This is a real
  // "which measurement is wrong" finding, not a scenario bug — reported here rather than
  // quietly forced to read 66 by narrowing this port's own flipper-state sweep to not match
  // the current, corrected methodology. table/ramps.js's own comment is the one that is now
  // stale; updating it is not this scenario's call to make.
  const r = runScenario('slide-reachability-left');
  assert.equal(r.total, 81);
  assert.equal(r.contact, 81, `THE SLIDE's exit reachability regressed from the published 81/81 — got ${r.contact}/${r.total}`);
  assert.equal(
    r.midBat, 81,
    `THE SLIDE's exit mid-bat is ${r.midBat}/${r.total}, not the current expected 81/81 — if this is now ` +
    '66 again, the flip-at-arrival methodology may have regressed back toward the pre-d901cbf bug.'
  );
});

test('formatReport renders the contact/mid-bat counts for a ramp-reachability scenario', () => {
  const text = formatReport(runScenario('orbit-reachability-right'));
  assert.ok(text.includes('orbit-reachability-right'));
  assert.ok(text.includes('contact: 81/81'));
});
