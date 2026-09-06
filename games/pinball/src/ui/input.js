// Keyboard + touch input. DOM-only — never imported by physics/table/rules.
import { setActive } from '../physics/flipper.js';

/**
 * Wire keyboard + touch input to a set of named flippers and a plunger callback.
 * `flippers` = { left: Flipper, right: Flipper, upperLeft?: Flipper }.
 * `onPlungerChange(power01)` fires while charging (0..1) — on keydown this is a single call
 * at power 1 (Space has no analog hold); on touch it fires repeatedly as a plunge-zone drag
 * (see PLUNGE_ZONE_FRACTION below) pulls further down, so a caller wiring up a visible power
 * meter gets a live value either way. `onPlungerRelease()` fires on release (Space keyup, or
 * lifting the plunge-zone touch) — its own argument is unused downstream (main.js reads back
 * whatever `onPlungerChange` last reported) and kept only so both input paths call it with the
 * same shape.
 * `onNudge({x,y})` fires on a two-finger swipe (of the two touches NOT currently driving a
 * plunge drag — see onTouchStart) or a nudge key.
 */
export function wireInput(target, { flippers, onPlungerChange, onPlungerRelease, onNudge, onFlipperEdge } = {}) {
  let leftHeld = false;
  let rightHeld = false;
  const setLeft = (active) => {
    if (flippers.left) setActive(flippers.left, active);
    if (flippers.upperLeft) setActive(flippers.upperLeft, active);
    if (active && !leftHeld) onFlipperEdge?.('left');
    leftHeld = active;
  };
  const setRight = (active) => {
    if (flippers.right) setActive(flippers.right, active);
    if (active && !rightHeld) onFlipperEdge?.('right');
    rightHeld = active;
  };

  // --- Keyboard ---
  const keyDown = new Set();
  function onKeyDown(e) {
    if (keyDown.has(e.code)) return;
    keyDown.add(e.code);
    if (e.code === 'ArrowLeft' || e.code === 'ShiftLeft') setLeft(true);
    if (e.code === 'ArrowRight' || e.code === 'ShiftRight') setRight(true);
    if (e.code === 'Space') onPlungerChange?.(1);
    if (e.code === 'ArrowUp') onNudge?.({ x: 0, y: 1 });
    if (e.code === 'KeyA') onNudge?.({ x: -1, y: 0 });
    if (e.code === 'KeyD') onNudge?.({ x: 1, y: 0 });
  }
  function onKeyUp(e) {
    keyDown.delete(e.code);
    if (e.code === 'ArrowLeft' || e.code === 'ShiftLeft') setLeft(false);
    if (e.code === 'ArrowRight' || e.code === 'ShiftRight') setRight(false);
    if (e.code === 'Space') onPlungerRelease?.(1);
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // --- Touch: left half / right half of the target element are flippers; a narrow strip at
  // the right edge is the plunger — tracked by identifier. ---
  //
  // PLUNGE-TOUCH: there was no plunger binding on touch at all before this — Space was the
  // only path to it, keyboard-only. Found by the operator in ten seconds on a real phone;
  // missed by every prior playtest because all of them drove synthetic keydown events, never
  // an actual touch path (see this dispatch's own handoff for why that gap existed).
  //
  // PLUNGE_ZONE_FRACTION carves the plunger's touch region out of the right flipper's own
  // territory rather than adding a third, overlapping zone: a touch starting at or past this
  // fraction of the target's width is a plunge, never a flipper press, everywhere else is
  // unchanged (left half -> left flipper, the rest of the right half -> right flipper). 0.85
  // (the rightmost 15%) is a judgment call sized for a real thumb — no on-screen 3D-to-screen
  // projection of the physics launch lane's own narrow x-range is attempted here, since that
  // range is camera/pitch-dependent and a fixed touch-target width is what a real finger
  // needs regardless of how the table happens to be framed.
  const PLUNGE_ZONE_FRACTION = 0.85;
  // Full power at this many CSS pixels of downward pull — a real thumb-drag distance, not a
  // sourced figure; matches the same "generous enough for a real touch, not a physics
  // measurement" judgment call as the zone width above.
  const PLUNGE_MAX_PULL_PX = 120;

  const activeTouches = new Map(); // identifier -> 'left' | 'right' (flipper touches only)
  const nudgeTouches = new Map(); // identifier -> {x,y} start, only while exactly 2 NON-PLUNGE touches down
  let plungeTouchId = null; // at most one active plunge drag at a time
  let plungeStartY = 0;

  function zoneFor(clientX) {
    const rect = target.getBoundingClientRect();
    const frac = (clientX - rect.left) / rect.width;
    if (frac >= PLUNGE_ZONE_FRACTION) return 'plunge';
    return frac < 0.5 ? 'left' : 'right';
  }

  function onTouchStart(e) {
    for (const t of e.changedTouches) {
      const zone = zoneFor(t.clientX);
      if (zone === 'plunge') {
        if (plungeTouchId !== null) continue; // one plunge drag at a time
        plungeTouchId = t.identifier;
        plungeStartY = t.clientY;
        onPlungerChange?.(0); // immediate feedback: charging has begun, at zero power
        continue;
      }
      activeTouches.set(t.identifier, zone);
      if (zone === 'left') setLeft(true);
      else setRight(true);
    }
    // Nudge only ever considers non-plunge touches — a plunge drag plus one flipper press is
    // two simultaneous touches that must never be misread as a nudge swipe.
    const nonPlungeTouches = [...e.touches].filter((t) => t.identifier !== plungeTouchId);
    if (nonPlungeTouches.length === 2) {
      for (const t of nonPlungeTouches) nudgeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    e.preventDefault();
  }

  function onTouchMove(e) {
    if (plungeTouchId !== null) {
      for (const t of e.touches) {
        if (t.identifier !== plungeTouchId) continue;
        // "Pull down and drag": clientY increases downward, so a downward pull is a positive
        // delta — pulling UP or sideways contributes no power rather than going negative.
        const pull = Math.max(0, t.clientY - plungeStartY);
        onPlungerChange?.(Math.min(1, pull / PLUNGE_MAX_PULL_PX));
        break;
      }
    }
    if (nudgeTouches.size === 2) {
      for (const t of e.touches) {
        const start = nudgeTouches.get(t.identifier);
        if (!start) continue;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.hypot(dx, dy) > 40) {
          onNudge?.({ x: dx, y: -dy });
          nudgeTouches.clear();
          break;
        }
      }
    }
    e.preventDefault();
  }

  function release(identifier) {
    const side = activeTouches.get(identifier);
    if (!side) return;
    activeTouches.delete(identifier);
    const stillLeft = [...activeTouches.values()].includes('left');
    const stillRight = [...activeTouches.values()].includes('right');
    if (side === 'left' && !stillLeft) setLeft(false);
    if (side === 'right' && !stillRight) setRight(false);
  }

  function onTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === plungeTouchId) {
        plungeTouchId = null;
        onPlungerRelease?.(1); // argument unused downstream (see main.js) — kept for the same shape onKeyUp's Space release already calls with
      }
    }
    for (const t of e.changedTouches) release(t.identifier);
    for (const t of e.changedTouches) nudgeTouches.delete(t.identifier);
    e.preventDefault();
  }

  target.addEventListener('touchstart', onTouchStart, { passive: false });
  target.addEventListener('touchmove', onTouchMove, { passive: false });
  target.addEventListener('touchend', onTouchEnd, { passive: false });
  target.addEventListener('touchcancel', onTouchEnd, { passive: false });

  return function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('touchstart', onTouchStart);
    target.removeEventListener('touchmove', onTouchMove);
    target.removeEventListener('touchend', onTouchEnd);
    target.removeEventListener('touchcancel', onTouchEnd);
  };
}
