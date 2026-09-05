// A small transient message layer — "shows a string for a couple of seconds and gets out of
// the way." Built for TILT's two warnings and its own callout, but deliberately generic (one
// `show(text, durationMs)` call, no tilt-specific API) so the super jackpot / wizard-mode work
// queued after this can call the SAME layer instead of main.js growing a second one. The
// existing HUD (a single fixed div rewritten every frame with score/ball/game-over — see
// main.js) is untouched; this is a separate, additive layer, not a HUD rebuild.
//
// Calls queue (FIFO) rather than stomp each other: two callouts landing close together (e.g.
// TEACHER'S WATCHING fired twice in quick succession) both get their own on-screen moment
// instead of the second silently overwriting the first mid-display.
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

  const queue = [];
  let showing = false;

  function next() {
    if (queue.length === 0) {
      showing = false;
      el.style.opacity = '0';
      return;
    }
    showing = true;
    const { text, durationMs } = queue.shift();
    el.textContent = text;
    el.style.opacity = '1';
    setTimeout(next, durationMs);
  }

  return {
    /** Queues `text` to display for `durationMs` (default 1800ms), then dismiss and show the
     * next queued callout, if any. */
    show(text, durationMs = 1800) {
      queue.push({ text, durationMs });
      if (!showing) next();
    },
  };
}
