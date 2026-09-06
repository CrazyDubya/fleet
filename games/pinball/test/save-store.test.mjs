// save/store.js — SAVE-T13's three real asks, each with its own test group below: migration
// of the two pre-existing legacy keys, quota/private-browsing fallback, and the "something
// should know" notice when a write doesn't land.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, STORAGE_KEY } from '../src/save/store.js';

function mockStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
    _data: data,
  };
}

test('a fresh store with no prior data of any kind starts at the schema default', () => {
  const store = createStore(mockStorage());
  assert.deepEqual(store.get(), { v: 1, highScores: [], settings: { muted: false } });
});

test('MIGRATION: an existing player\'s two legacy keys are imported into the new blob the first time it loads', () => {
  const storage = mockStorage({
    'recess-pinball-high-scores': '[500000, 300000, 100000]',
    'recess-pinball-muted': 'true',
  });
  const store = createStore(storage);
  assert.deepEqual(store.get().highScores, [500000, 300000, 100000], 'their high scores are carried forward, not reset');
  assert.equal(store.get().settings.muted, true, 'their mute setting is carried forward, not reset');
});

test('MIGRATION: once the import succeeds and persists, the legacy keys are removed — the import runs exactly once, not on every load', () => {
  const storage = mockStorage({ 'recess-pinball-high-scores': '[100]', 'recess-pinball-muted': 'true' });
  createStore(storage);
  assert.equal(storage.getItem('recess-pinball-high-scores'), null, 'legacy high-scores key is cleaned up after a successful migration');
  assert.equal(storage.getItem('recess-pinball-muted'), null, 'legacy mute key is cleaned up after a successful migration');
  assert.ok(storage.getItem(STORAGE_KEY), 'the new blob now exists');
});

test('MIGRATION: a player with no legacy data at all just gets the default — nothing invented', () => {
  const store = createStore(mockStorage());
  assert.deepEqual(store.get().highScores, []);
  assert.equal(store.get().settings.muted, false);
});

test('MIGRATION: a corrupt blob at the new key falls back to a legacy import rather than throwing or trusting garbage', () => {
  const storage = mockStorage({ [STORAGE_KEY]: 'not json', 'recess-pinball-high-scores': '[100]' });
  const store = createStore(storage);
  assert.deepEqual(store.get().highScores, [100]);
});

test('QUOTA FALLBACK: update() never throws when the store cannot persist, and the in-memory copy still reflects the write', () => {
  const brokenStorage = { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); } };
  const store = createStore(brokenStorage);
  assert.doesNotThrow(() => store.update((data) => ({ ...data, highScores: [999] })));
  assert.deepEqual(store.get().highScores, [999], 'gameplay this session sees the write even though it will not survive a reload');
});

test('QUOTA FALLBACK: a failed legacy-import persist leaves the legacy keys in place rather than deleting a player\'s only remaining copy', () => {
  const storage = {
    getItem: (k) => (k === 'recess-pinball-high-scores' ? '[100]' : null),
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: () => { throw new Error('should never be called'); },
  };
  assert.doesNotThrow(() => createStore(storage));
});

test('OBSERVABILITY: isDegraded() flips true only after an actual failed persist, never before', () => {
  const store = createStore(mockStorage());
  assert.equal(store.isDegraded(), false);
  const brokenStore = createStore({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  assert.equal(brokenStore.isDegraded(), true, 'the very first (legacy-import) persist attempt already failed');
});

test('OBSERVABILITY: takeNotice() returns the one-line notice exactly once, then null on every later call, even across further failed writes', () => {
  const store = createStore({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  const first = store.takeNotice();
  assert.equal(typeof first, 'string');
  assert.ok(first.length > 0 && first.length < 60, 'a one-line notice, not a paragraph');
  assert.equal(store.takeNotice(), null, 'the notice is not re-shown on the next check');
  store.update((data) => ({ ...data, highScores: [1] }));
  assert.equal(store.takeNotice(), null, 'a second failed write does not queue a second notice this session');
});

test('two stores never share state — no module-level leakage between two pages, or two tests', () => {
  const storeA = createStore(mockStorage());
  const storeB = createStore(mockStorage());
  storeA.update((data) => ({ ...data, highScores: [42] }));
  assert.deepEqual(storeB.get().highScores, [], 'storeB is untouched by storeA\'s own update');
});
