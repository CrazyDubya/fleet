// Scenario harness tests — see src/scenarios.js for the "why a harness" doc comment. These
// assert on real, measured numbers from runScenario() (node /tmp probe scripts during
// development; see the handoff for the exact sweeps run), never a plausible-looking guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, formatReport, SCENARIOS } from '../src/scenarios.js';

test('scoop-two-balls: both balls captured on entry, then ejected together at hold expiry', () => {
  const r = runScenario('scoop-two-balls');
  assert.equal(r.balls.length, 2);

  // Both balls captured on the physics step they enter the zone (checkCaptures is a static
  // distance check, not a crossing event — see scenarios.js's doc comment).
  const captureEvents = r.events.filter((e) => e.type === 'captured');
  assert.deepEqual(captureEvents.map((e) => e.ball), ['a', 'b']);
  assert.equal(captureEvents[0].atS, 0);
  assert.ok(captureEvents[1].atS > 0 && captureEvents[1].atS < 1.0, 'ball b must enter within ball a\'s 1.0s hold window');

  // The armScoop/tickScoop fix (game/mechanisms.js, 2026-09-05): every ball captured since the
  // last eject leaves together, on the SAME tick — not one at a time, and neither is ever left
  // behind still `captured` (the orphaning bug this scenario was built to catch, since fixed).
  const ejectEvents = r.events.filter((e) => e.type === 'ejected');
  assert.equal(ejectEvents.length, 2, 'both balls must be ejected, not just one');
  assert.equal(ejectEvents[0].atS, ejectEvents[1].atS, 'both balls must eject on the same tick');
  assert.deepEqual(new Set(ejectEvents.map((e) => e.ball)), new Set(['a', 'b']));
  for (const b of r.balls) {
    assert.equal(b.captured, false, `ball ${b.id} must not still be captured after the scenario ends`);
  }
});

test('scoop-two-balls: a ball entering AFTER the first ball\'s eject is not swept up in it', () => {
  const r = runScenario('scoop-two-balls', {
    balls: [
      { id: 'a', spawnAtS: 0.0 },
      { id: 'c', spawnAtS: 1.2 }, // enters 0.2s after ball a's 1.0s hold already ejected it
    ],
    durationS: 2.5,
  });
  const captureEvents = r.events.filter((e) => e.type === 'captured');
  assert.deepEqual(captureEvents.map((e) => e.ball), ['a', 'c']);
  // Two separate ejects, one per hold window, not one combined eject.
  const ejectEvents = r.events.filter((e) => e.type === 'ejected');
  assert.equal(ejectEvents.length, 2);
  assert.notEqual(ejectEvents[0].atS, ejectEvents[1].atS);
  for (const b of r.balls) assert.equal(b.captured, false);
});

test('arc-containment: a ball at a realistic flipper-tip speed stays contained', () => {
  // 6.0 m/s: SCENARIOS' own default, chosen inside the flipper-tip range this table's own
  // FLIP_BAND readout (src/main.js) watches (4.5-6.0 m/s design band). Measured: the ball
  // reaches the backstop, bounces (E_WALL=0.45 restitution), and rolls back toward the open
  // end — never past the backstop's own outer surface.
  const r = runScenario('arc-containment');
  assert.equal(r.contained, true);
  assert.equal(r.escapedAtS, null);
  const { length, halfWidth } = SCENARIOS['arc-containment'].channel;
  assert.ok(r.maxY > 0, 'the ball must have travelled up the channel, not stayed at the entrance');
  assert.ok(r.maxY < length + halfWidth, 'contained means it never reached the backstop\'s outer surface');
});

test('arc-containment: measured across the full realistic flipper-speed range (0.5-8 m/s), containment holds', () => {
  // Swept 0.5 to 8 m/s in 0.5 m/s steps (a flipper's own tip tops out at ~4.9 m/s per
  // physics/constants.js's measured figure — see
  // ledger/handoffs/sonnet2/20260905T090000Z-captive-ball-finding.md, which found tunnelling
  // through a thinner captive-ball backstop starting at 6 m/s in ITS OWN differently-sized
  // channel). This scenario's own channel (1.6-ball-diameter width, 0.12m length,
  // zero-padding Arc backstop) does not reproduce that escape at any speed in this range —
  // measured here, not assumed to match. Recorded as a real finding: containment is sensitive
  // to the exact channel geometry, not just backstop thinness.
  for (let speed = 0.5; speed <= 8; speed += 0.5) {
    const r = runScenario('arc-containment', { ball: { speed, offset: 0 } });
    assert.equal(r.contained, true, `speed ${speed} m/s should stay contained in this channel`);
  }
});

test('arc-containment: a ball starting outside the channel walls is correctly reported as escaped', () => {
  // Proves the escape-detection path itself is real, not dead code: an offset placing the ball
  // outside both side walls never meets the channel or its backstop, so it must sail straight
  // through — a legitimate physics outcome (bad placement), not a fabricated one.
  const { halfWidth } = SCENARIOS['arc-containment'].channel;
  const r = runScenario('arc-containment', { ball: { speed: 3, offset: halfWidth * 2 }, durationS: 0.3 });
  assert.equal(r.contained, false);
  assert.ok(r.escapedAtS > 0 && r.escapedAtS < 0.3);
});

test('formatReport produces multi-line, human-readable text for both scenario kinds', () => {
  const scoopText = formatReport(runScenario('scoop-two-balls'));
  assert.ok(scoopText.includes('scoop-two-balls'));
  assert.ok(scoopText.includes('captured='));

  const arcText = formatReport(runScenario('arc-containment'));
  assert.ok(arcText.includes('arc-containment'));
  assert.ok(arcText.includes('contained: true'));
});
