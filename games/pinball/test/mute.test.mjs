// audio/mute.js's persistence — SAVE-T13 moved it onto save/store.js's shared blob, so
// loadMuted/saveMuted now take a `createStore` handle rather than a raw Storage object; see
// save/store.test.mjs for the persistence/migration/quota-fallback behavior itself, this file
// only checks that mute.js reads/writes the right slice of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMuted, saveMuted } from '../src/audio/mute.js';
import { createStore } from '../src/save/store.js';

function mockStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
}

test('loadMuted defaults to false when nothing is persisted yet', () => {
  assert.equal(loadMuted(createStore(mockStorage())), false);
});

test('a round trip through saveMuted/loadMuted preserves true and false', () => {
  const store = createStore(mockStorage());
  saveMuted(true, store);
  assert.equal(loadMuted(store), true);
  saveMuted(false, store);
  assert.equal(loadMuted(store), false);
});

test('AUDIO-T11 regression, still true through SAVE-T13: an existing player\'s legacy mute flag survives the schema landing, and garbage never reads as muted', () => {
  assert.equal(loadMuted(createStore(mockStorage({ 'recess-pinball-muted': 'not a boolean' }))), false, 'anything other than the literal string "true" under the legacy key reads as not muted');
  assert.equal(loadMuted(createStore(mockStorage({ 'recess-pinball-muted': 'true' }))), true, 'a real legacy true is carried forward into the new schema');
});

test('saveMuted does not throw when the store cannot persist (private browsing, quota, disabled storage)', () => {
  const brokenStorage = { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); } };
  const store = createStore(brokenStorage);
  assert.doesNotThrow(() => saveMuted(true, store));
  assert.equal(loadMuted(store), true, 'the in-memory copy still reflects the change even though it could not persist');
});

test('loadMuted does not throw when storage.getItem throws', () => {
  const brokenStorage = { getItem: () => { throw new Error('storage disabled'); } };
  assert.doesNotThrow(() => loadMuted(createStore(brokenStorage)));
  assert.equal(loadMuted(createStore(brokenStorage)), false);
});
