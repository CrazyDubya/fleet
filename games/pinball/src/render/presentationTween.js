// Presentation-only motion for instantaneous physics hand-offs — a ramp exit/rollback, a
// SANDBOX scoop capture/eject. physics/ramp.js's own doc comment states the model: "the
// habitrail's/wireform's/orbit's actual downhill return... collapses into a single
// deterministic hand-off" — there is no intermediate physics position between the ball's last
// tracked point and its new one, because the physics doesn't simulate one. A ball whose mesh
// just snaps between those two points in a single rendered frame reads as vanishing and
// reappearing, which is exactly the visual-accuracy failure this module exists to close.
//
// The fix is NOT a second, authored path — that would be a second source of truth for a
// geometry physics already owns, and it would drift the moment anyone re-aims an exit (as
// happened twice in one day to these same coordinates). Instead: draw a straight line between
// the two REAL endpoints the physics hand-off itself used (the ball's last known position
// before the teleport, and its new position after), over a short, clearly-presentation-only
// duration. Headless — no THREE, no DOM — so it can be unit-tested directly; main.js supplies
// the real endpoints and reads the interpolated point back into the mesh's position.
export const PRESENTATION_TWEEN_S = 0.15; // seconds — a fast, visible whoosh; no physics meaning, tune freely

/** `from`/`to`: `{x, y, z?}` — real physics positions (z defaults to 0, matching how every
 * teleport in main.js sets `ball.z = 0` on arrival at 'playfield'). Returns the tween state
 * object; `tweenPosition` reads it back. */
export function startTween(from, to, nowS, durationS = PRESENTATION_TWEEN_S) {
  return {
    from: { x: from.x, y: from.y, z: from.z ?? 0 },
    to: { x: to.x, y: to.y, z: to.z ?? 0 },
    startS: nowS,
    durationS,
  };
}

/** `{x, y, z, t, done}` at `nowS` — `t` clamped to [0,1], `done` true once the tween has fully
 * reached `to` (nowS >= startS + durationS, or durationS <= 0). Pure linear interpolation: the
 * physics hand-off itself is instantaneous and undirected between the endpoints, so nothing
 * about a curved or eased path would be "more correct" — a straight line between the two real
 * points is the honest presentation of "the physics doesn't know what happened in between." */
export function tweenPosition(tween, nowS) {
  const t = tween.durationS > 0
    ? Math.min(1, Math.max(0, (nowS - tween.startS) / tween.durationS))
    : 1;
  // t===1 returns `to` exactly (not from + (to-from)*1, which can carry float noise) — "done"
  // should mean truly AT the physics endpoint, not merely close to it.
  if (t >= 1) return { x: tween.to.x, y: tween.to.y, z: tween.to.z, t: 1, done: true };
  return {
    x: tween.from.x + (tween.to.x - tween.from.x) * t,
    y: tween.from.y + (tween.to.y - tween.from.y) * t,
    z: tween.from.z + (tween.to.z - tween.from.z) * t,
    t,
    done: false,
  };
}
