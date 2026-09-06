// ui/high-scores.js's pure ranking/formatting logic (unchanged by SAVE-T13) and its
// persistence, which SAVE-T13 moved onto save/store.js's shared blob — loadHighScores/
// saveHighScores now take a `createStore` handle rather than a raw Storage object; see
// save/store.test.mjs for the persistence/migration/quota-fallback behavior itself, this
// file only checks that high-scores.js reads/writes the right slice of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { insertScore, loadHighScores, saveHighScores, highScoreLines, MAX_ENTRIES } from '../src/ui/high-scores.js';
import { createStore } from '../src/save/store.js';

function mockStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    _data: data,
  };
}

test('insertScore sorts descending and keeps the new score in its rank', () => {
  const result = insertScore([500000, 200000], 300000);
  assert.deepEqual(result, [500000, 300000, 200000]);
});

test('insertScore caps at maxEntries, dropping the lowest', () => {
  const result = insertScore([100, 90, 80, 70, 60], 50, 5);
  assert.deepEqual(result, [100, 90, 80, 70, 60], 'a score lower than every existing entry does not displace anything');
  const displaced = insertScore([100, 90, 80, 70, 60], 75, 5);
  assert.deepEqual(displaced, [100, 90, 80, 75, 70], '75 displaces the lowest (60)');
});

test('loadHighScores returns an empty table when nothing is persisted yet', () => {
  assert.deepEqual(loadHighScores(createStore(mockStorage())), []);
});

test('a round trip through saveHighScores/loadHighScores preserves the table', () => {
  const store = createStore(mockStorage());
  saveHighScores([500000, 300000, 100000], store);
  assert.deepEqual(loadHighScores(store), [500000, 300000, 100000]);
});

test('an existing player\'s legacy high scores (SAVE-T13\'s own migration) are still what loadHighScores reads', () => {
  const storage = mockStorage({ 'recess-pinball-high-scores': '[500000, -1, "nope", null, 300000]' });
  assert.deepEqual(
    loadHighScores(createStore(storage)),
    [500000, 300000],
    'non-finite, negative, and non-numeric entries are filtered out, valid ones kept — same sanitization, now at the schema level',
  );
});

test('saveHighScores does not throw when the store cannot persist (private browsing, quota, disabled storage)', () => {
  const brokenStorage = { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); } };
  const store = createStore(brokenStorage);
  assert.doesNotThrow(() => saveHighScores([100], store));
  assert.deepEqual(loadHighScores(store), [100], 'the in-memory copy still reflects the save even though it could not persist');
});

test('HISCORE regression: a zero-score game shows nothing — not a table, not a placeholder', () => {
  const lines = highScoreLines([500000, 300000], 0);
  assert.equal(lines, null, 'a scoreless game must show nothing, the same "say nothing" rule the bonus screen uses');
});

test('a non-zero score produces a labeled table with the current game marked', () => {
  const lines = highScoreLines([500000, 300000, 100000], 300000);
  assert.ok(Array.isArray(lines));
  assert.equal(lines[0], 'HIGH SCORES');
  const markedLine = lines.find((l) => l.includes('300,000'));
  assert.ok(markedLine.includes('<<'), 'the just-finished game\'s own score is marked in the table');
  const unmarkedLine = lines.find((l) => l.includes('500,000'));
  assert.ok(!unmarkedLine.includes('<<'), 'a different score in the table is not marked');
});

test('MAX_ENTRIES is exported so a caller never has to hardcode the table size elsewhere', () => {
  assert.equal(typeof MAX_ENTRIES, 'number');
  assert.ok(MAX_ENTRIES > 0);
});
