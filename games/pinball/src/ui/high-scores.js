// Local high-score table — HISCORE dispatch, last item in haiku-fs2's backlog: "tracks best
// scores, displayed after game over." Persists via localStorage (a real browser, a real tab
// reload); ranking and formatting are pure and take an explicit `storage` argument rather than
// defaulting to `window.localStorage`, so they're unit-testable under `node --test` with a
// plain in-memory mock instead of a real browser.
//
// MAX_ENTRIES: the design doc names the feature but not a table size — 5 is the common
// arcade-cabinet convention, a judgment call stated here rather than presented as spec-derived.
const STORAGE_KEY = 'recess-pinball-high-scores';
export const MAX_ENTRIES = 5;

/** Inserts `newScore` into `scores`, re-sorts descending, caps at `maxEntries`. Pure — the
 * caller decides whether the result gets persisted. */
export function insertScore(scores, newScore, maxEntries = MAX_ENTRIES) {
  return [...scores, newScore].sort((a, b) => b - a).slice(0, maxEntries);
}

/** Reads the persisted table from `storage` (a Storage-shaped object: `getItem`/`setItem`).
 * Anything malformed (corrupt JSON, a non-array, non-finite/negative entries — a hand-edited
 * or foreign-origin value) is dropped rather than trusted, since this is real external state
 * a player's browser controls, not internal state this codebase itself only ever writes in
 * one valid shape. */
export function loadHighScores(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((n) => Number.isFinite(n) && n >= 0) : [];
  } catch {
    return [];
  }
}

/** Persists `scores` to `storage`. Swallows write failures (private browsing, quota, storage
 * disabled) — the table simply won't persist this session; not worth surfacing to the player
 * over a scoring screen. */
export function saveHighScores(scores, storage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(scores));
  } catch {
    // See doc comment above — deliberately silent.
  }
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
