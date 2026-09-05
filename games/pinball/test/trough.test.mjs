// TROUGH AND SERVE (2026-09-05). fs2's own structural mapping (haiku-fs2/
// 20260904-missing-mechanism-analogues.md, item 6): closest analogue is the SANDBOX scoop —
// capture zone + small state machine — but a trough holds several balls in arrival order and
// serves them out one at a time, FIFO, rather than a single ball on a fixed timer. No new
// physics primitive: this is pure rules-layer queueing state (game/mechanisms.js), wired into
// main.js's real serve/drain lifecycle in this same dispatch — replacing the unconditional
// "just spawn a fresh ball" main.js used to do with a real queue that tracks whether one was
// actually waiting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrough, captureInTrough, serveFromTrough, troughCount } from '../src/game/mechanisms.js';

test('a fresh trough starts pre-loaded with one ball — the very first serve of a game must succeed with nothing having drained yet', () => {
  const trough = createTrough();
  assert.equal(troughCount(trough), 1);
  const served = serveFromTrough(trough);
  assert.ok(served, 'the first-ever serve must find a ball waiting');
  assert.equal(troughCount(trough), 0, 'serving the pre-loaded ball empties the trough');
});

test('createTrough accepts an explicit initial count', () => {
  assert.equal(troughCount(createTrough(0)), 0);
  assert.equal(troughCount(createTrough(3)), 3);
});

test('captured balls serve out in FIFO order — first drained, first served', () => {
  const trough = createTrough(0);
  captureInTrough(trough, 1.0);
  captureInTrough(trough, 2.0);
  captureInTrough(trough, 3.0);
  assert.equal(troughCount(trough), 3);

  assert.equal(serveFromTrough(trough).capturedAtS, 1.0, 'the FIRST one captured must be the FIRST one served');
  assert.equal(serveFromTrough(trough).capturedAtS, 2.0);
  assert.equal(serveFromTrough(trough).capturedAtS, 3.0);
  assert.equal(troughCount(trough), 0);
});

test('serving from an empty trough returns null rather than fabricating a ball or throwing', () => {
  const trough = createTrough(0);
  assert.equal(serveFromTrough(trough), null);
  assert.equal(serveFromTrough(trough), null, 'still null, not something that only fails once');
});

test('capture and serve interleave correctly — a trough is a real FIFO queue, not a counter', () => {
  const trough = createTrough(0);
  captureInTrough(trough, 1.0);
  assert.equal(serveFromTrough(trough).capturedAtS, 1.0);
  assert.equal(serveFromTrough(trough), null, 'nothing left after serving the only ball');

  captureInTrough(trough, 2.0);
  captureInTrough(trough, 3.0);
  assert.equal(serveFromTrough(trough).capturedAtS, 2.0, 'a fresh capture after emptying still serves in arrival order');
  assert.equal(troughCount(trough), 1);
});

// Reproduces the exact sequence main.js's own drain-loop and serveToChute now use — one
// captureInTrough per ordinary drain, one serveFromTrough per ordinary serve — to confirm the
// production wiring's own invariant holds: under ordinary single-ball play, a serve is never
// preceded by an empty trough. main.js itself isn't importable under node --test (bare 'three'
// specifier — see glue-scope.test.mjs), so this exercises the same two calls in the same order
// against the real trough state, the same discipline kickback-ball-save-interaction.test.mjs
// and diverter.test.mjs used for their own main.js wiring.
test('production sequence: drain then serve, repeated, never finds the trough empty in ordinary single-ball play', () => {
  const trough = createTrough(); // main.js's own troughState, same default
  for (let ball = 0; ball < 5; ball++) {
    // ballServed/ballSaved always follows a drain (rules/game.js's handleDrain), except the
    // very first serve of a game, which the pre-loaded ball above covers.
    if (ball > 0) captureInTrough(trough, ball); // the drain that ended the previous ball
    const served = serveFromTrough(trough);
    assert.ok(served, `serve #${ball} must find a ball waiting — a null here is exactly the drain/serve imbalance main.js's own warning exists to catch`);
  }
  assert.equal(troughCount(trough), 0, 'no balls left over — every capture was matched by exactly one serve');
});
