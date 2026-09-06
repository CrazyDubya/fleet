// SAVE-T13 (design doc §6): one JSON blob at `localStorage['recess.save.v1']`, schema-versioned
// (save/schema.js), replacing the two independent keys HISCORE (ui/high-scores.js) and
// AUDIO-T11 (audio/mute.js) invented before this file existed — "one place that knows how
// persistence works, rather than three," per the dispatch. `createStore(storage)` is a
// factory returning a stateful handle, the same shape as every other stateful DOM-adjacent
// module here (createSynth, createCalloutLayer, createMomentScreen) — not a bag of bare
// functions hiding module-level state, which would make two stores in the same page (or two
// tests in the same file) silently share state that belongs to neither.
//
// `storage` is an explicit argument (Storage-shaped: getItem/setItem, optionally removeItem),
// the same pattern ui/high-scores.js and audio/mute.js already established, for the same
// reason: this is unit-testable under `node --test` against a plain mock, never against a
// real browser.
import { CURRENT_VERSION, createDefaultSave, migrate } from './schema.js';

const STORAGE_KEY = 'recess.save.v1';
// The two keys this file replaces. Read once, on the very first load after this schema
// lands, and never written to again — see importLegacy's own comment on why.
const LEGACY_HIGH_SCORES_KEY = 'recess-pinball-high-scores';
const LEGACY_MUTED_KEY = 'recess-pinball-muted';

function readLegacyHighScores(storage) {
  try {
    const raw = storage.getItem(LEGACY_HIGH_SCORES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n) => Number.isFinite(n) && n >= 0) : null;
  } catch {
    return null;
  }
}

function readLegacyMuted(storage) {
  try {
    const raw = storage.getItem(LEGACY_MUTED_KEY);
    return raw === null ? null : raw === 'true';
  } catch {
    return null;
  }
}

/** MIGRATION (this dispatch's second ask — "say what happens to an existing player's high
 * scores when the schema arrives"): an existing player already has real state under the two
 * legacy keys above. The very first time this file finds no `recess.save.v1` blob yet, it
 * reads both legacy keys and carries forward whatever they hold — an existing player's high
 * scores and mute setting survive the schema landing, they are not reset to a fresh save.
 * Nothing is invented for a field neither legacy key ever tracked (there isn't one yet). */
function importLegacy(storage) {
  const base = createDefaultSave();
  const scores = readLegacyHighScores(storage);
  const muted = readLegacyMuted(storage);
  if (scores !== null) base.highScores = scores;
  if (muted !== null) base.settings.muted = muted;
  return base;
}

export function createStore(storage) {
  // `persistent`/`notice` are per-instance (closure) state, not module-level — two stores in
  // the same page, or two tests importing this same module, never bleed into each other. A
  // real page creates exactly one store (main.js, at startup); tests create one per test.
  let persistent = true;
  let pendingNotice = null;
  let hasWarned = false; // distinct from pendingNotice: that's cleared once TAKEN, this never
  // resets, so a second (or twentieth) failed write this session doesn't queue a second notice

  function persist(data) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(data));
      persistent = true;
    } catch {
      // QUOTA FALLBACK (this dispatch's first ask): Safari Private Browsing throws
      // synchronously on setItem, and a full quota does too — either way, the write did not
      // land. `data` was already applied to `current` below before this call, so the game
      // keeps running against the in-memory copy for the rest of THIS session; only actual
      // persistence across a reload is lost, never gameplay this session. A table that threw
      // out of a save attempt would be strictly worse than one that silently can't save.
      persistent = false;
      // OBSERVABILITY (this dispatch's third ask — "a save that silently fails is the shape
      // this fleet has spent a day finding; if a write does not land, something should
      // know"): one notice, queued for whoever calls takeNotice() next (main.js, via the
      // existing callout layer — see main.js's own wiring), not re-queued on every
      // subsequent failed write. A one-line notice shown once beats a callout retriggering on
      // every score this session, and it beats a console-only warning nobody watching a phone
      // screen will ever see.
      if (!hasWarned) {
        hasWarned = true;
        pendingNotice = "PROGRESS WON'T SAVE THIS SESSION";
      }
    }
  }

  let current = (() => {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw != null) return migrate(JSON.parse(raw));
    } catch {
      // A corrupt blob at the new key is exactly as untrusted as a corrupt blob ever was at
      // the old keys (see loadHighScores/loadMuted's own doc comments) — fall through to a
      // legacy import rather than trust or throw on it.
    }
    // No valid v1 blob yet: either a brand-new player, or an existing one whose data still
    // lives under the two legacy keys. importLegacy returns the same default shape either
    // way, and persisting it immediately is what makes "when the schema arrives" a one-time
    // event rather than a re-import on every load — a legacy key an existing player already
    // moved past does not resurrect old data every session. See onLegacyImportSuccess's
    // deletion of the legacy keys below.
    const imported = importLegacy(storage);
    persist(imported);
    // Deleting the legacy keys is safe to do ONLY once they're actually superseded by a
    // successfully persisted blob — if persist() just failed (quota/private-browsing), this
    // player's real high scores are the ones still sitting under the legacy key, and deleting
    // it would be a straight data loss on top of the same session's already-degraded save.
    if (persistent) {
      try { storage.removeItem?.(LEGACY_HIGH_SCORES_KEY); } catch { /* best-effort cleanup only */ }
      try { storage.removeItem?.(LEGACY_MUTED_KEY); } catch { /* best-effort cleanup only */ }
    }
    return imported;
  })();

  return {
    /** The current save data. Never a live reference the caller can mutate around `update` —
     * callers that want to change it go through `update`, which is what actually persists. */
    get() {
      return current;
    },
    /** Applies `mutator(current)` (must return the FULL next save object, not a partial patch
     * — callers spread `current` themselves, the same explicitness `rules/game.js`'s own
     * event-returning functions already use elsewhere in this codebase) and attempts to
     * persist it. Always updates the in-memory copy first, so a failed persist degrades
     * silently for THIS session's gameplay and loudly (see takeNotice) for anything that
     * checks. */
    update(mutator) {
      current = mutator(current);
      persist(current);
      return current;
    },
    /** True once a persist attempt has actually failed (still true even after a later
     * successful one — the notice already covers "this session," and un-degrading mid-session
     * on a flaky quota edge isn't a real distinction worth tracking). */
    isDegraded() {
      return !persistent;
    },
    /** Returns the one-line degradation notice exactly once (null before any failure, and null
     * again on every call after the first) — see persist()'s own comment on why this is
     * queued rather than re-shown. */
    takeNotice() {
      const notice = pendingNotice;
      pendingNotice = null;
      return notice;
    },
  };
}

export { STORAGE_KEY, CURRENT_VERSION };
