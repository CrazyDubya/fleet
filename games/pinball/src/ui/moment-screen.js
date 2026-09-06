// A "moment" screen — a held, multi-line overlay for end-of-ball/end-of-game summaries.
// Distinct from ui/callouts.js's single-line transient announcements: a callout describes
// something that just happened in one line ("SUPER JACKPOT!"); a moment describes what a
// ball or a game WAS, in several lines, and the two other screens the HUD backlog names
// (bonus breakdown, high-score table) are both that same shape — see haiku-fs2's HUD
// inventory (20260905T200000Z), which is why this is one new surface, not two, and not a
// stretch of callouts into something they aren't.
//
// Same split as ui/callouts.js: the "replace, never queue, always scoped" bookkeeping
// (createMomentState/setMoment/clearMomentIfCurrent/clearMomentScope below) is pure — no
// DOM, no setTimeout — specifically so it's unit-testable under `node --test` the way
// callouts.js's own queue logic is (see test/callouts.test.mjs's own doc comment on why).
// createMomentScreen is the thin DOM wrapper around it.
//
// MOMENT-SCOPE (haiku-opencode2's review, 20260905-moment-screen-review.md): a bonus
// breakdown has no business surviving into a LATER ball's own play, the same "state
// surviving a boundary it should have died at" shape as four other bugs found the same day
// — and the fix the review found for it is subtler than "clear on the next new ball," which
// would clear the very moment it was just asked to show (a bonus is generated in the SAME
// synchronous display batch as the turnChange that serves the next ball, so a naive
// same-generation clear would hide it before a single frame ever paints it). See
// `scope` below and main.js's own two-generations-back clearing in onNewBall for the
// resolution. `scope` is an opaque token, same convention as ui/callouts.js's own scope:
// a ball-scoped moment (the bonus screen) and a game-scoped moment (the high-score table)
// must never collide just because a ball-generation counter and a game-generation counter
// happen to reach the same integer — callers are expected to namespace their own tokens
// (e.g. `` `ball:${n}` `` vs `` `game:${n}` ``) rather than pass bare numbers.

export function createMomentState() {
  return { current: null, nextId: 1 };
}

/** A moment always REPLACES rather than queues (unlike callouts' FIFO): a second moment
 * always describes a newer ball/game than whatever's showing, so there's nothing worth
 * preserving by queuing it. Returns the id this call was assigned. */
export function setMoment(state, lines, scope = null) {
  const id = state.nextId++;
  state.current = { lines, id, scope };
  return id;
}

/** Clears `id`'s content — a no-op if a NEWER moment has already superseded it. Guards
 * against a moment's own dismiss timer firing late (a slow frame, a paused tab) after a
 * second moment has already replaced it: comparing ids means a late timer can only ever
 * clear the moment it was scheduled for, never something newer. */
export function clearMomentIfCurrent(state, id) {
  if (state.current && state.current.id === id) state.current = null;
}

/** Ends whatever's showing IF it belongs to `scope` (mirrors ui/callouts.js's own
 * clearScope). Returns whether it matched, so the DOM wrapper knows whether to hide
 * immediately. `scope: null` is "not tied to any endable state," never a real scope to
 * clear against — same convention as callouts.js, for the same reason (an unscoped moment
 * must never become accidentally clearable). */
export function clearMomentScope(state, scope) {
  if (scope == null) return false;
  if (state.current && state.current.scope === scope) {
    state.current = null;
    return true;
  }
  return false;
}

export function createMomentScreen(parent = document.body) {
  const el = document.createElement('div');
  el.id = 'moment-screen';
  el.style.cssText = [
    'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
    'color:#fff', 'font:bold 20px monospace', 'text-align:center', 'line-height:1.7',
    'letter-spacing:0.5px', 'z-index:7', 'pointer-events:none', 'white-space:pre',
    'background:rgba(20,20,20,0.72)', 'padding:20px 32px', 'border-radius:8px',
    'border:1px solid rgba(255,255,255,0.15)',
    'opacity:0', 'transition:opacity 0.15s',
  ].join(';');
  parent.appendChild(el);
  const state = createMomentState();
  let timer = null;

  return {
    /** Shows `lines` (an array, one per row, or a single string) until `durationMs` elapses,
     * then fades out. Replaces whatever is currently showing immediately. `scope` (opaque,
     * default null = never externally cleared) lets a caller later end it early via
     * `endScope` — see the file's own doc comment on why bare ball/game-generation numbers
     * must be namespaced before being passed here. */
    show(lines, { durationMs = 3600, scope = null } = {}) {
      const id = setMoment(state, lines, scope);
      clearTimeout(timer);
      el.textContent = Array.isArray(lines) ? lines.join('\n') : lines;
      el.style.opacity = '1';
      timer = setTimeout(() => {
        clearMomentIfCurrent(state, id);
        el.style.opacity = '0';
      }, durationMs);
    },
    /** Ends whatever's showing if it belongs to `scope`, hiding it immediately rather than
     * waiting for its own timer. Safe to call with a scope nothing is showing under (a
     * no-op) — same convention as callouts.js's own endScope. */
    endScope(scope) {
      if (clearMomentScope(state, scope)) {
        clearTimeout(timer);
        el.style.opacity = '0';
      }
    },
  };
}

/** Pure content builder for the end-of-ball bonus moment — HUD-BUILD's own regression test
 * target. Returns `null` for a zero bonus rather than an array of zeroed lines: per the
 * dispatch, "a ball that earned nothing should say so or say nothing, not display an
 * itemization of nothing" — the caller shows nothing when this returns `null`, so a ball
 * that earned zero gets no moment screen at all (the HUD's own unchanged score already says
 * it). `amount` is the already-rounded total computeBonus (rules/bonus.js) returns; the three
 * components are shown as-is, already display-rounded by computeBonus itself. */
export function bonusBreakdownLines({ amount, bonusX, playtimePoints, shotsPoints, modesPoints }) {
  if (amount <= 0) return null;
  return [
    'BALL BONUS',
    `PLAYTIME     ${playtimePoints.toLocaleString()}`,
    `SHOTS        ${shotsPoints.toLocaleString()}`,
    `MODES        ${modesPoints.toLocaleString()}`,
    `BONUS X${bonusX}`,
    `TOTAL        ${amount.toLocaleString()}`,
  ];
}
