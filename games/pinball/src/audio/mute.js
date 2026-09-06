// Mute state persistence — AUDIO-T11, moved onto the shared save/store.js blob by SAVE-T13.
// This used to own a private `recess-pinball-muted` localStorage key directly; save/store.js's
// own doc comment covers the one-time migration of whatever an existing player already has
// under that key.

/** Reads the persisted mute flag from `store` (a save/store.js `createStore` handle — see
 * that file's own doc comment for why the persistence layer moved there). */
export function loadMuted(store) {
  return store.get().settings.muted;
}

/** Persists the mute flag via `store`. Failure handling (private browsing, quota, storage
 * disabled) lives in save/store.js now — this never throws because `store.update` never
 * does. */
export function saveMuted(muted, store) {
  store.update((data) => ({ ...data, settings: { ...data.settings, muted } }));
}
