// A small transient message layer — "shows a string for a couple of seconds and gets out of
// the way." Built for TILT's two warnings and its own callout, but deliberately generic (one
// `show(text, opts)` call, no tilt-specific API) so the super jackpot / wizard-mode work this
// queued for uses the SAME layer instead of main.js growing a second one. The existing HUD (a
// single fixed div rewritten every frame with score/ball/game-over — see main.js) is untouched;
// this is a separate, additive layer, not a HUD rebuild.
//
// Calls queue (FIFO) rather than stomp each other: two callouts landing close together (e.g.
// TEACHER'S WATCHING fired twice in quick succession) both get their own on-screen moment
// instead of the second silently overwriting the first mid-display.
//
// SCOPES (CALLOUT-1, added after a review): a message can optionally carry a `scope` — an
// opaque value naming the state it describes. `endScope(scope)` ends every message tied to
// that scope: dismisses it immediately if it's the one currently showing, and drops it from
// the queue outright if it hasn't been shown yet (the review's own second bullet — "showing it
// after the fact is the same bug arriving late" — so the fix has to cover the queue, not just
// the visible message).
//
// NOT every message needs a scope, and this is the distinction that decides which ones do: a
// message describing something that ALREADY HAPPENED (a score, an award, a game-over) stays
// true forever — SUPER JACKPOT!, SENT TO THE PRINCIPAL, SLAM TILT all report a past event, so
// they're left unscoped (`scope: null`, the default) and simply run their own timeout, same as
// before this fix. A message describing CURRENT, ongoing state — "you have a tilt warning
// against you right now" — stops being true the instant that state ends, so TILT's own
// TEACHER'S WATCHING callout (see main.js) is the one caller here that actually needs a scope:
// tied to the ball generation it warned about, ended the instant a new ball is served. The bug
// this fixes: a warning shown at t=0 with an 1800ms timeout was still on screen 500ms after the
// ball that earned it had already drained and a fresh ball (with a freshly-reset tilt bob) had
// started — main.js had no way to say "this message belongs to that state, end it with it".
//
// Queue/scope bookkeeping is pure (createCalloutQueue/enqueueCallout/clearScope/advanceCallout
// below, no DOM) specifically so it can be unit-tested under `node --test` — this file also
// creates a real DOM element and uses setTimeout, which nothing else in ui/ has a test harness
// for (see ui/input.js, ui/debug.js: no test files, browser-verified only); splitting the logic
// out means the one new behaviour this dispatch adds doesn't have to go untested for that
// reason.

export function createCalloutQueue() {
  return { queue: [], current: null };
}

/** Adds a message to the queue. `scope` (default null = never auto-cleared) is an opaque value
 * a caller can later pass to clearScope to end every message tied to it. */
export function enqueueCallout(state, text, { durationMs = 1800, scope = null } = {}) {
  state.queue.push({ text, durationMs, scope });
}

/** Ends every message belonging to `scope`: removed from the queue outright (a queued message
 * for a state that has already ended must never be shown at all, not just cut short), and
 * reports whether `state.current` (the message actually on screen right now, if any) also
 * belongs to it — the caller (createCalloutLayer) uses that to know whether it must dismiss
 * the visible message and advance to whatever's next. Messages with `scope: null`, or a
 * different scope, are never touched. */
export function clearScope(state, scope) {
  // null is "not tied to any endable state", not a real scope identity — clearing it would
  // mean every unscoped (score/award-style) message becomes clearable by accident, which
  // defeats the entire point of leaving them unscoped. A genuine no-op, not an edge case
  // callers need to avoid triggering themselves.
  if (scope == null) return false;
  state.queue = state.queue.filter((m) => m.scope !== scope);
  return state.current !== null && state.current.scope === scope;
}

/** Pops the next queued message into `state.current` (null if the queue is empty) and returns
 * it. */
export function advanceCallout(state) {
  state.current = state.queue.length > 0 ? state.queue.shift() : null;
  return state.current;
}

export function createCalloutLayer(parent = document.body) {
  const el = document.createElement('div');
  el.id = 'callout';
  el.style.cssText = [
    'position:fixed', 'top:38%', 'left:50%', 'transform:translate(-50%,-50%)',
    'color:#fff', 'font:bold 28px monospace', 'text-shadow:0 2px 6px #000',
    'letter-spacing:1px', 'text-align:center', 'z-index:6', 'pointer-events:none',
    'opacity:0', 'transition:opacity 0.15s',
  ].join(';');
  parent.appendChild(el);

  const state = createCalloutQueue();
  let timer = null;

  function render() {
    if (!state.current) {
      el.style.opacity = '0';
      return;
    }
    el.textContent = state.current.text;
    el.style.opacity = '1';
  }

  function next() {
    advanceCallout(state);
    render();
    timer = state.current ? setTimeout(next, state.current.durationMs) : null;
  }

  return {
    /** Queues `text` (opts: `{durationMs, scope}`, see file doc comment on scope) to display,
     * then dismiss and show whatever's next in the queue. */
    show(text, opts) {
      enqueueCallout(state, text, opts);
      if (!state.current) next();
    },
    /** Ends every message tied to `scope` — see the file's own doc comment on which callers
     * need this. Safe to call with a scope nothing is queued under (a no-op). */
    endScope(scope) {
      const mustAdvance = clearScope(state, scope);
      if (mustAdvance) {
        clearTimeout(timer);
        next();
      }
    },
  };
}
