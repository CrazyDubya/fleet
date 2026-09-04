// Signature widening for the sandbox's live constants panel (2026-09-04):
// buildFlipperConfigs() gained an optional override parameter defaulting to the shipped
// constants — not a physics change. Needed because the right flipper's rest/active angle is a
// mirror of the left's (180 - value); reusing this builder for a live override avoids
// restating that mirror formula in the sandbox, which would be a copy, not a reuse. Guards
// both halves of that claim: every call site in games/pinball (no argument) is byte-identical
// to before the parameter existed, and a real override actually takes effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as recess from '../src/table/recess.js';
import { FLIPPER, E_FLIPPER } from '../src/physics/constants.js';

test('buildFlipperConfigs() with no argument is byte-identical to the shipped constants', () => {
  const configs = recess.buildFlipperConfigs();
  const left = configs.find((c) => c.name === 'left');
  const right = configs.find((c) => c.name === 'right');
  const upperLeft = configs.find((c) => c.name === 'upperLeft');

  assert.equal(left.restAngleDeg, FLIPPER.lower.restAngle);
  assert.equal(left.activeAngleDeg, FLIPPER.lower.activeAngle);
  assert.equal(left.upMs, FLIPPER.lower.upMs);
  assert.equal(left.restitution, E_FLIPPER);

  assert.equal(right.restAngleDeg, 180 - FLIPPER.lower.restAngle);
  assert.equal(right.activeAngleDeg, 180 - FLIPPER.lower.activeAngle);
  assert.equal(right.upMs, FLIPPER.lower.upMs);

  assert.equal(upperLeft.upMs, FLIPPER.upper.upMs);
  assert.equal(upperLeft.restAngleDeg, FLIPPER.upper.restAngle);
  assert.equal(upperLeft.activeAngleDeg, FLIPPER.upper.activeAngle);
});

test('buildFlipperConfigs(overrides) applies lower upMs/angles (mirrored to right) and upper upMs, restitution to all three', () => {
  const configs = recess.buildFlipperConfigs({
    lowerRestAngle: -40, lowerActiveAngle: 30, lowerUpMs: 16, lowerDownMs: 50,
    upperUpMs: 20, upperDownMs: 60, eFlipper: 0.7,
  });
  const left = configs.find((c) => c.name === 'left');
  const right = configs.find((c) => c.name === 'right');
  const upperLeft = configs.find((c) => c.name === 'upperLeft');

  assert.equal(left.restAngleDeg, -40);
  assert.equal(left.activeAngleDeg, 30);
  assert.equal(left.upMs, 16);
  assert.equal(left.downMs, 50);
  assert.equal(left.restitution, 0.7);

  assert.equal(right.restAngleDeg, 180 - -40);
  assert.equal(right.activeAngleDeg, 180 - 30);
  assert.equal(right.upMs, 16);
  assert.equal(right.restitution, 0.7);

  // Upper's own rest/active angles are NOT exposed — only its stroke timing and the shared
  // restitution are (matching the sandbox panel's scope).
  assert.equal(upperLeft.restAngleDeg, FLIPPER.upper.restAngle);
  assert.equal(upperLeft.activeAngleDeg, FLIPPER.upper.activeAngle);
  assert.equal(upperLeft.upMs, 20);
  assert.equal(upperLeft.downMs, 60);
  assert.equal(upperLeft.restitution, 0.7);
});
