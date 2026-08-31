// Keyboard + touch input. DOM-only — never imported by physics/table/rules.
import { setActive } from '../physics/flipper.js';

/**
 * Wire keyboard + touch input to a set of named flippers and a plunger callback.
 * `flippers` = { left: Flipper, right: Flipper, upperLeft?: Flipper }.
 * `onPlungerChange(power01)` fires while charging (0..1); `onPlungerRelease(power01)` on release.
 * `onNudge({x,y})` fires on a two-finger swipe or a nudge key.
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

  // --- Touch: left half / right half of the target element, tracked by identifier ---
  const activeTouches = new Map(); // identifier -> 'left' | 'right'
  const nudgeTouches = new Map(); // identifier -> {x,y} start, only while exactly 2 touches down

  function sideFor(clientX) {
    const rect = target.getBoundingClientRect();
    return clientX - rect.left < rect.width / 2 ? 'left' : 'right';
  }

  function onTouchStart(e) {
    for (const t of e.changedTouches) {
      const side = sideFor(t.clientX);
      activeTouches.set(t.identifier, side);
      if (side === 'left') setLeft(true);
      else setRight(true);
    }
    if (e.touches.length === 2) {
      for (const t of e.touches) nudgeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    e.preventDefault();
  }

  function onTouchMove(e) {
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
