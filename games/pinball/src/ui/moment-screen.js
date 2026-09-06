// A "moment" screen — a held, multi-line overlay for end-of-ball/end-of-game summaries.
// Distinct from ui/callouts.js's single-line transient announcements: a callout describes
// something that just happened in one line ("SUPER JACKPOT!"); a moment describes what a
// ball or a game WAS, in several lines, and the two other screens the HUD backlog names
// (bonus breakdown, high-score table) are both that same shape — see haiku-fs2's HUD
// inventory (20260905T200000Z), which is why this is one new surface, not two, and not a
// stretch of callouts into something they aren't.
//
// Always REPLACES rather than queues (unlike callouts' FIFO): a second moment always
// describes a newer ball/game than whatever is already showing, so there's nothing worth
// preserving by queuing it — the old content is simply stale the instant a new one arrives.
// Always auto-dismisses on its own timer rather than waiting on a "press a button to
// continue" step that doesn't exist yet in this game, so a moment can never outlive the
// ball or game it describes even if nothing ever calls it again — the same "state
// surviving a boundary it should have died at" class of bug LIT-1/PLAYTEST-2 already found
// four instances of today, avoided here by construction (a fresh timer on every call, no
// state that only clears if some later event remembers to clear it).
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
  let timer = null;

  return {
    /** Shows `lines` (an array, one per row, or a single string) until `durationMs` elapses,
     * then fades out. Replaces whatever is currently showing immediately, canceling its
     * timer — see the file's own doc comment on why replace-not-queue is correct here. */
    show(lines, { durationMs = 3600 } = {}) {
      clearTimeout(timer);
      el.textContent = Array.isArray(lines) ? lines.join('\n') : lines;
      el.style.opacity = '1';
      timer = setTimeout(() => { el.style.opacity = '0'; }, durationMs);
    },
  };
}
