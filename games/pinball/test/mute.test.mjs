// audio/mute.js's pure persistence logic — tested against a plain in-memory mock, the same
// pattern test/high-scores.test.mjs already uses for its own localStorage-shaped state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMuted, saveMuted } from '../src/audio/mute.js';

function mockStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
}

test('loadMuted defaults to false when nothing is persisted yet', () => {
  assert.equal(loadMuted(mockStorage()), false);
});

test('a round trip through saveMuted/loadMuted preserves true and false', () => {
  const storage = mockStorage();
  saveMuted(true, storage);
  assert.equal(loadMuted(storage), true);
  saveMuted(false, storage);
  assert.equal(loadMuted(storage), false);
});

test('AUDIO-T11 regression: mute is read back BEFORE any sound would play — loadMuted never throws and never defaults to true on garbage input', () => {
  assert.equal(loadMuted(mockStorage({ 'recess-pinball-muted': 'not a boolean' })), false, 'anything other than the literal string "true" reads as not muted');
  assert.equal(loadMuted(mockStorage({ 'recess-pinball-muted': 'true' })), true);
});

test('saveMuted does not throw when storage.setItem throws (private browsing, quota, disabled storage)', () => {
  const brokenStorage = { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); } };
  assert.doesNotThrow(() => saveMuted(true, brokenStorage));
});

test('loadMuted does not throw when storage.getItem throws', () => {
  const brokenStorage = { getItem: () => { throw new Error('storage disabled'); } };
  assert.doesNotThrow(() => loadMuted(brokenStorage));
  assert.equal(loadMuted(brokenStorage), false);
});
