// LAB-11/P0-1: the shared §2.7 validity gate — one pure implementation now reused by every
// stage runner instead of "computed but never compared" (code review 20260902T130928Z).
import test from 'node:test';
import assert from 'node:assert/strict';
import { flagGateResult, FLAG_GATE_FRACTION } from '../src/gate.js';

test('flagGateResult: at or under 1% passes', () => {
  assert.equal(flagGateResult({ trials: 100000, flagged: 1000 }).ok, true); // exactly 1%
  assert.equal(flagGateResult({ trials: 100000, flagged: 999 }).ok, true);
});

test('flagGateResult: over 1% fails', () => {
  const r = flagGateResult({ trials: 100000, flagged: 1001 });
  assert.equal(r.ok, false);
  assert.ok(Math.abs(r.fraction - 0.01001) < 1e-9);
});

test('flagGateResult: zero trials does not divide by zero', () => {
  const r = flagGateResult({ trials: 0, flagged: 0 });
  assert.equal(r.fraction, 0);
  assert.equal(r.ok, true);
});

test('flagGateResult: honours a custom gateFraction (E4-style exclusion is the caller\'s job)', () => {
  const r = flagGateResult({ trials: 1000, flagged: 50, gateFraction: 0.1 });
  assert.equal(r.ok, true);
  assert.equal(FLAG_GATE_FRACTION, 0.01);
});
