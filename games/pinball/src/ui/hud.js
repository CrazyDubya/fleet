// HUD-CHALK (design doc §4.2: "The backglass is a chalk drawing on a blackboard. The score
// display is a chalk-on-slate 'DMD'... drawn in chalk white on slate, with a chalk-dust
// particle puff when it updates.") — the score/ball/player readout, the one piece of UI that
// is on screen every single second of play and was, until tonight, a bare white-on-nothing
// `hud.textContent = ...` div, unstyled placeholder text sitting over a fully art-directed
// table.
//
// SCOPE CUT, stated rather than built partially, per this dispatch's own "score display only":
// no low-res dot-grid canvas texture, no chalk-dust particle puff on update. Three reasons,
// not one:
//   1. The dispatch's own priority order — "legibility beats fidelity... beautiful score
//      nobody can read mid-ball is worse than the monospace it replaced" — argues directly
//      against a stylised dot-matrix rendering, which trades crisp glyph edges for period
//      texture at exactly the moment (small text, bright sunlit playfield behind it, a moving
//      ball) legibility is hardest to keep.
//   2. The dispatch's own update-frequency warning — "adding texture and styling to a
///     per-frame rewrite is how a phone drops frames" — argues against a canvas texture
//      redrawn on every score change, which costs strictly more per update than styled DOM
//      text (a canvas repaint plus a texture re-upload to the GPU vs. a single textContent
//      write). A per-update chalk-dust particle system is the same cost shape again, layered
//      on top, for a purely decorative flourish.
//   3. attract.js / highscores.js / menus.js are ALL cut for this same tier (T12, then again
//      here) — a bespoke canvas-texture renderer is exactly the kind of standalone subsystem
//      those cuts were made to avoid building piecemeal.
// A future dispatch that specifically wants the dot-grid/chalk-dust look has this file's own
// doc comment to start from, not a silent gap.
//
// STYLE, and how it relates to callouts.js / moment-screen.js (this dispatch's third ask —
// "three overlay styles on one table is worse than one plain one"): all three now share ONE
// visual language — white/off-white chalk-colored monospace text, with a soft multi-layer
// text-shadow standing in for chalk grain (see CHALK_TEXT_SHADOW below) — and differ only in
// how persistent and how "boarded" each one is, which is a property of what each one IS, not
// a separate skin:
//   - callouts.js: a transient one-liner floating directly over the 3D scene, no backing
//     panel at all — it describes something that just happened, gone in ~2s, and a panel
//     behind it would obscure the shot that just paid off.
//   - moment-screen.js: a persistent-until-dismissed multi-line panel with a dark
//     semi-opaque backing (already close to a chalkboard placard before this dispatch touched
//     it) — bonus breakdowns, high scores, the start/pause menus, all things you stop to read.
//   - hud.js (here): a persistent, ALWAYS-visible placard, styled as an actual small
//     chalkboard (slate background, thin frame) rather than moment-screen's plain dark panel,
//     because this is the one surface that has to read as "part of the machine's furniture"
//     at a glance rather than as a transient overlay — it is up for the entire game, not one
//     moment of it.
// The chalk text-shadow recipe below is the one piece of styling shared verbatim with what a
// future moment-screen/callouts pass could reuse, rather than three independently-tuned looks.

// Warm off-white, not pure #fff — real chalk dust is never optically white, and a slightly
// warm tone reads as chalk against the cool slate background rather than as a UI label.
const CHALK_COLOR = '#f0ead8';
// Chalk grain, cheap: two small-radius shadows (tight, for the "packed dust at the stroke
// edge" look) plus one wider, low-opacity shadow (a soft dust halo) — three shadow layers is
// a fixed per-paint cost paid once per textContent write, not per animation frame, so it
// costs nothing beyond what changing the text already costs (see the update-skip below).
const CHALK_TEXT_SHADOW = [
  '0 0 1px rgba(240,234,216,0.9)',
  '0 0 2px rgba(240,234,216,0.5)',
  '0 1px 3px rgba(0,0,0,0.6)',
].join(',');

const HUD_STYLE = [
  'position:fixed', 'top:8px', 'right:8px', 'z-index:5', 'pointer-events:none',
  'padding:6px 12px', 'border-radius:4px',
  // Slate: a dark, slightly desaturated green-grey (a real chalkboard is green-black, not
  // pure black) — distinct from moment-screen's neutral dark-grey panel, so the HUD reads as
  // its own board rather than a copy of the moment-screen treatment.
  'background:linear-gradient(160deg, #263b30, #1a2b22)',
  'border:1px solid rgba(240,234,216,0.35)', // a thin chalk-tray-colored frame edge
  `color:${CHALK_COLOR}`, 'font:bold 15px monospace', 'letter-spacing:0.5px',
  `text-shadow:${CHALK_TEXT_SHADOW}`,
].join(';');

/** Creates the always-visible score/ball/player placard. Distinct from moment-screen.js and
 * callouts.js (see the file's own doc comment on why this is a third, necessarily-different
 * shape rather than a reuse of either) but sharing their chalk-on-dark visual language.
 *
 * update-frequency (this dispatch's second ask): `update(text)` is called every frame from
 * main.js's own render loop (the HUD's source values — score, ball, turn — are read fresh
 * every frame the same way every other live indicator on this page already is, per that
 * existing convention), but a DOM write only actually happens when `text` differs from what's
 * already showing. A pinball score is unchanged on almost every frame (60fps, score changes
 * only on a switch hit), so this turns ~60 DOM writes/sec into one write per actual score
 * change — the layout/paint work `textContent =` triggers is real cost that the previous
 * unconditional per-frame rewrite paid 60x more often than the text ever actually changed. */
export function createHud(parent = document.body) {
  const el = document.createElement('div');
  el.id = 'hud';
  el.style.cssText = HUD_STYLE;
  parent.appendChild(el);
  let last = null;
  return {
    update(text) {
      if (text === last) return;
      last = text;
      el.textContent = text;
    },
  };
}
