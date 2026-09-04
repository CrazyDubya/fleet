// Pure logic for src/render/presentationTween.js — the interpolation math behind every
// animated hand-off (ramp exit/rollback, scoop capture/eject). See render-hand-offs.test.mjs
// for the source-text checks that main.js feeds this REAL physics endpoints, not invented ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTween, tweenPosition, PRESENTATION_TWEEN_S } from '../src/render/presentationTween.js';

test('tweenPosition at t=0 (the start instant) returns exactly the from-point', () => {
  const tween = startTween({ x: -0.225, y: 0.85, z: 0.1 }, { x: -0.055, y: 0.17 }, 10.0, 0.15);
  const p = tweenPosition(tween, 10.0);
  assert.equal(p.x, -0.225);
  assert.equal(p.y, 0.85);
  assert.equal(p.z, 0.1);
  assert.equal(p.t, 0);
  assert.equal(p.done, false);
});

test('tweenPosition at t=duration (or later) returns exactly the to-point and reports done', () => {
  const tween = startTween({ x: -0.225, y: 0.85, z: 0.1 }, { x: -0.055, y: 0.17 }, 10.0, 0.15);
  const atEnd = tweenPosition(tween, 10.15);
  assert.equal(atEnd.x, -0.055);
  assert.equal(atEnd.y, 0.17);
  assert.equal(atEnd.z, 0, 'to.z defaults to 0 when not given');
  assert.equal(atEnd.t, 1);
  assert.equal(atEnd.done, true);

  const wellPastEnd = tweenPosition(tween, 999);
  assert.equal(wellPastEnd.x, -0.055);
  assert.equal(wellPastEnd.done, true, 'stays clamped at the endpoint, never overshoots');
});

test('tweenPosition at the midpoint is the exact linear midpoint of from and to', () => {
  const tween = startTween({ x: 0, y: 0, z: 0 }, { x: 1, y: -2, z: 0.4 }, 5.0, 0.2);
  const mid = tweenPosition(tween, 5.1); // halfway through the 0.2s duration
  assert.ok(Math.abs(mid.x - 0.5) < 1e-9, `expected x=0.5, got ${mid.x}`);
  assert.ok(Math.abs(mid.y - -1) < 1e-9, `expected y=-1, got ${mid.y}`);
  assert.ok(Math.abs(mid.z - 0.2) < 1e-9, `expected z=0.2, got ${mid.z}`);
  assert.ok(Math.abs(mid.t - 0.5) < 1e-9);
  assert.equal(mid.done, false);
});

test('tweenPosition before the start time clamps to the from-point (t never goes negative)', () => {
  const tween = startTween({ x: 3, y: 3 }, { x: 5, y: 5 }, 10.0, 0.15);
  const beforeStart = tweenPosition(tween, 9.0);
  assert.equal(beforeStart.x, 3);
  assert.equal(beforeStart.y, 3);
  assert.equal(beforeStart.t, 0);
});

test('a zero (or negative) duration completes instantly — a defensive edge case, not a real call pattern', () => {
  const tween = startTween({ x: 1, y: 1 }, { x: 9, y: 9 }, 0, 0);
  const p = tweenPosition(tween, 0);
  assert.equal(p.x, 9);
  assert.equal(p.y, 9);
  assert.equal(p.done, true);
});

test('startTween defaults to PRESENTATION_TWEEN_S when no duration is given', () => {
  const tween = startTween({ x: 0, y: 0 }, { x: 1, y: 1 }, 0);
  assert.equal(tween.durationS, PRESENTATION_TWEEN_S);
});
