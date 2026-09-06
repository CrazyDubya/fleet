// SAVE-T13 (design doc §6): the schema for the one save blob, and the migration chain that
// brings whatever's actually in `localStorage` up to it. Pure — no `three`, no `window`/
// `document`, no `Date.now`/`Math.random` (test/purity.test.mjs checks this file by name, the
// same rule physics/table/rules already keep) — so save/store.js is the only place that ever
// touches a real Storage object, and this file is unit-testable with plain objects.
//
// SCOPE CUT, stated per the dispatch's own instruction: §6's full blob also names `champs`,
// `achievements`, `unlocks`, `xp`/`level`, `stats`, and richer `settings` (quality, keys,
// skin, ball, credits) — none of that exists yet (T13's own achievements/XP/skins tier is
// explicitly more than one dispatch, per the operator). This schema only carries what
// already has a real feature behind it: high scores (HISCORE) and mute (AUDIO-T11). Adding a
// field later is exactly what CURRENT_VERSION/migrate exist to do — this is the seed of that
// chain, not a placeholder pretending to be the whole thing.
//
// highScores stays the plain `number[]` HISCORE already shipped (ranked scores, no identity)
// rather than upgrading to §6's full `{id, initials, score, ts, table, version, players}`
// entry shape — that richer shape is meaningless without the initials-entry UI and per-player
// identity T12 already cut for the same reason (touch keyboard is its own surface). Widening
// the array element type is a schema version bump for whenever that UI actually exists, not
// a shape to half-build now.
export const CURRENT_VERSION = 1;

export function createDefaultSave() {
  return {
    v: CURRENT_VERSION,
    highScores: [],
    settings: { muted: false },
  };
}

/** Brings a parsed JSON value up to CURRENT_VERSION, or returns a fresh default if it isn't
 * recognizable as this codebase's own save data at all. Two failure shapes are treated
 * identically — not an object, and an object whose `v` this chain has no migration path
 * from — because both mean the same thing to a reader: this isn't a blob we know how to
 * trust, so start clean rather than guess. (When a real v2 exists, this is where
 * `if (data.v === 1) data = migrateV1toV2(data);` chains in — the single `!== CURRENT_VERSION`
 * check below is deliberately the smallest form that's still a real chain, not a placeholder
 * for one, since v1 is the first version and there is nothing yet to migrate FROM.)
 *
 * Every field is re-validated here even when `v` matches, the same "external state is
 * untrusted" rule loadHighScores/loadMuted already applied per-field before this file existed
 * (see ui/high-scores.js, audio/mute.js) — a hand-edited or foreign-origin blob can claim any
 * `v` it wants and still contain garbage in the fields underneath it. */
export function migrate(data) {
  const base = createDefaultSave();
  if (!data || typeof data !== 'object' || data.v !== CURRENT_VERSION) return base;
  return {
    ...base,
    highScores: Array.isArray(data.highScores)
      ? data.highScores.filter((n) => Number.isFinite(n) && n >= 0)
      : base.highScores,
    settings: {
      ...base.settings,
      muted: typeof data.settings === 'object' && data.settings !== null && typeof data.settings.muted === 'boolean'
        ? data.settings.muted
        : base.settings.muted,
    },
  };
}
