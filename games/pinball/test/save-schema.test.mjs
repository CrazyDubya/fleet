// save/schema.js — pure, so no mock Storage needed here at all; save-store.test.mjs covers
// the persistence layer built on top of this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_VERSION, createDefaultSave, migrate } from '../src/save/schema.js';

test('createDefaultSave: the shape SAVE-T13 actually has a feature behind (high scores, mute) — no achievements/xp/skins placeholders', () => {
  const save = createDefaultSave();
  assert.equal(save.v, CURRENT_VERSION);
  assert.deepEqual(save.highScores, []);
  assert.deepEqual(save.settings, { muted: false });
});

test('migrate: not an object at all (null, undefined, a string, an array) returns a fresh default rather than throwing', () => {
  for (const bad of [null, undefined, 'not an object', 42, []]) {
    assert.deepEqual(migrate(bad), createDefaultSave(), `migrate(${JSON.stringify(bad)}) should return a fresh default`);
  }
});

test('migrate: an unrecognized version is treated as foreign/corrupt, not guessed at', () => {
  assert.deepEqual(migrate({ v: 0, highScores: [1] }), createDefaultSave());
  assert.deepEqual(migrate({ v: 99, highScores: [1] }), createDefaultSave());
});

test('migrate: a valid v1 blob passes its real data through unchanged', () => {
  const data = { v: 1, highScores: [500000, 300000], settings: { muted: true } };
  assert.deepEqual(migrate(data), data);
});

test('migrate: sanitizes highScores the same way loadHighScores used to per-field — non-finite/negative/non-numeric entries dropped, a non-array reset to empty', () => {
  assert.deepEqual(
    migrate({ v: 1, highScores: [500000, -1, 'nope', null, 300000], settings: {} }).highScores,
    [500000, 300000],
  );
  assert.deepEqual(migrate({ v: 1, highScores: 'not an array', settings: {} }).highScores, []);
});

test('migrate: sanitizes settings.muted — anything but a real boolean falls back to the default', () => {
  assert.equal(migrate({ v: 1, highScores: [], settings: { muted: 'yes' } }).settings.muted, false);
  assert.equal(migrate({ v: 1, highScores: [], settings: null }).settings.muted, false);
  assert.equal(migrate({ v: 1, highScores: [] }).settings.muted, false);
  assert.equal(migrate({ v: 1, highScores: [], settings: { muted: true } }).settings.muted, true);
});
