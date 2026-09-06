// Mute state persistence — AUDIO-T11. Same pattern as ui/high-scores.js: pure functions
// taking an explicit `storage` argument (not a `window.localStorage` default) so this is
// unit-testable under `node --test` against a plain mock instead of a real browser.
const STORAGE_KEY = 'recess-pinball-muted';

/** Reads the persisted mute flag. Anything that isn't the literal string this module itself
 * writes is treated as "not muted" — real external state a player's browser controls, not
 * trusted the way internal-only state would be (same reasoning as loadHighScores's own
 * corrupt-data handling). */
export function loadMuted(storage) {
  try {
    return storage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Persists the mute flag. Swallows write failures (private browsing, quota, storage
 * disabled) — muting simply won't persist this session, not worth surfacing over sound. */
export function saveMuted(muted, storage) {
  try {
    storage.setItem(STORAGE_KEY, muted ? 'true' : 'false');
  } catch {
    // See doc comment above — deliberately silent.
  }
}
