// Local high-score table — HISCORE dispatch, last item in haiku-fs2's backlog: "tracks best
// scores, displayed after game over." Ranking and formatting (insertScore, highScoreLines)
// are pure, unchanged by SAVE-T13. Persistence (loadHighScores/saveHighScores) moved onto the
// shared save/store.js blob — this used to own a private `recess-pinball-high-scores`
// localStorage key directly; save/store.js's own doc comment covers the one-time migration of
// whatever an existing player already has under that key.
//
// MAX_ENTRIES: the design doc names the feature but not a table size — 5 is the common
// arcade-cabinet convention, a judgment call stated here rather than presented as spec-derived.
export const MAX_ENTRIES = 5;

/** Inserts `newScore` into `scores`, re-sorts descending, caps at `maxEntries`. Pure — the
 * caller decides whether the result gets persisted. */
export function insertScore(scores, newScore, maxEntries = MAX_ENTRIES) {
  return [...scores, newScore].sort((a, b) => b - a).slice(0, maxEntries);
}

/** Reads the persisted table from `store` (a save/store.js `createStore` handle, not a raw
 * Storage object — see that file's own doc comment for why the persistence layer moved
 * there). Sanitization of malformed entries now happens once, at the schema level
 * (save/schema.js's `migrate`), rather than per-field here — `store.get()` is already trusted
 * by the time it reaches this function. */
export function loadHighScores(store) {
  return store.get().highScores;
}

/** Persists `scores` via `store`. Failure handling (private browsing, quota, storage
 * disabled) lives in save/store.js now — this never throws because `store.update` never does,
 * see its own doc comment on why the in-memory copy always applies regardless. */
export function saveHighScores(scores, store) {
  store.update((data) => ({ ...data, highScores: scores }));
}

/** Pure content builder for the end-of-game moment. `thisScore` (this game's final score, if
 * it made the table) is marked so the player can find themselves in the list, not because the
 * table has any other notion of "whose" a score is — this build is single-player only (see
 * main.js's `createGame({ numPlayers: 1 })`); a real multi-player table would need its own
 * per-player identity, not invented here. Returns `null` for a scoreless game — same "say
 * nothing" rule the bonus screen uses (see moment-screen.js's bonusBreakdownLines), and for
 * the same reason: an empty/placeholder table for a 0-point game looks like an achievement. */
export function highScoreLines(scores, thisScore) {
  if (thisScore <= 0) return null;
  return [
    'HIGH SCORES',
    ...scores.map((s, i) => `${i + 1}.  ${s.toLocaleString()}${s === thisScore ? '  <<' : ''}`),
  ];
}
