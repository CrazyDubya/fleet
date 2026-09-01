// Flipper actuation policies (program handoff §3.2 — "timing is measured, not assumed").
// Pure with respect to the trial: a policy only calls the game's own `setActive`, the same
// entry point a real touch/keyboard input drives (ui/input.js), so it exercises the shipped
// activation path rather than poking flipper.active directly.
import { setActive } from '../../pinball/src/physics/flipper.js';
import { FLIPPER } from '../../pinball/src/physics/constants.js';

/**
 * `createPolicy(cfg)` returns `{ tick(elapsedS, ball, flippers) }`, called once per physics
 * substep. `flippers` = { left, right } (the real Flipper objects). Returns an array of
 * `{ side, firedAtS }` for any flipper whose fire command fired *this* substep — empty most
 * ticks. instrument.js keeps its own map of side -> firedAtS to compute `dt` (fire-to-contact
 * latency) once a contact on that flipper is observed.
 */
export function createPolicy(cfg) {
  if (cfg.pol === 'never') {
    return { tick: () => [] };
  }

  if (cfg.pol === 'fixedDelay') {
    const fireAtS = cfg.d / 1000;
    let fired = false;
    return {
      tick(elapsedS, ball, flippers) {
        if (fired || elapsedS < fireAtS) return [];
        fired = true;
        // Fire the flipper nearer the ball's current x — the side a player would actually
        // press, given the ball's approach; both flippers share the same fixed delay policy
        // parameter, only the choice of *which* one fires is geometry-driven.
        const side = ball.pos.x < 0 ? 'left' : 'right';
        setActive(flippers[side], true);
        return [{ side, firedAtS: elapsedS }];
      },
    };
  }

  // §3.5 cradle family: both flippers raised at t=0 and held — "the flipper is held active
  // from t=0", not fired in response to the ball at all.
  if (cfg.pol === 'heldActive') {
    let fired = false;
    return {
      tick(elapsedS, ball, flippers) {
        if (fired) return [];
        fired = true;
        setActive(flippers.left, true);
        setActive(flippers.right, true);
        return [{ side: 'left', firedAtS: elapsedS }, { side: 'right', firedAtS: elapsedS }];
      },
    };
  }

  // §3.1 E4 family: proximity-armed with latency `cfg.L`, then held forever once fired (never
  // released) — the "live catch" case, the harder real-pinball skill E4's fireAndHold family
  // measures against `heldActive`'s dead-catch baseline. Structurally `proximity` minus the
  // second flipper never firing independently of the first (both fire together once armed, to
  // match `heldActive`'s "both flippers up" — a single-sided catch is a different experiment).
  if (cfg.pol === 'fireAndHold') {
    const latencyS = cfg.L / 1000;
    let armedAtS = null;
    let fired = false;
    return {
      tick(elapsedS, ball, flippers) {
        if (fired) return [];
        if (armedAtS === null) {
          const dLeft = Math.hypot(ball.pos.x - flippers.left.pivot.x, ball.pos.y - flippers.left.pivot.y);
          const dRight = Math.hypot(ball.pos.x - flippers.right.pivot.x, ball.pos.y - flippers.right.pivot.y);
          if (Math.min(dLeft, dRight) <= cfg.R) armedAtS = elapsedS + latencyS;
        }
        if (armedAtS !== null && elapsedS >= armedAtS) {
          fired = true;
          setActive(flippers.left, true);
          setActive(flippers.right, true);
          return [{ side: 'left', firedAtS: elapsedS }, { side: 'right', firedAtS: elapsedS }];
        }
        return [];
      },
    };
  }

  // §3.1 E4 Stage C: held from t=0 (like heldActive); once the trial loop tells us (via
  // `state.settledAtS`, instrument.js's fourth tick argument) that the ball has come to rest,
  // waits `cfg.releaseDelayMs` past that instant, drops both flippers (`setActive(false)`),
  // then — once `downMs + 10ms` has passed, long enough for the down-stroke to finish — fires
  // them again once, the "does a subsequent flip actually shoot it" release.
  if (cfg.pol === 'holdThenRelease') {
    let heldAt0 = false;
    let droppedAtS = null;
    let refired = false;
    const releaseDelayS = cfg.releaseDelayMs / 1000;
    const downTailS = (FLIPPER.lower.downMs + 10) / 1000;
    return {
      tick(elapsedS, ball, flippers, state) {
        const events = [];
        if (!heldAt0) {
          heldAt0 = true;
          setActive(flippers.left, true);
          setActive(flippers.right, true);
          events.push({ side: 'left', firedAtS: elapsedS }, { side: 'right', firedAtS: elapsedS });
        }
        if (droppedAtS === null && state?.settledAtS != null && elapsedS >= state.settledAtS + releaseDelayS) {
          droppedAtS = elapsedS;
          setActive(flippers.left, false);
          setActive(flippers.right, false);
        }
        if (droppedAtS !== null && !refired && elapsedS >= droppedAtS + downTailS) {
          refired = true;
          setActive(flippers.left, true);
          setActive(flippers.right, true);
          events.push({ side: 'left', firedAtS: elapsedS }, { side: 'right', firedAtS: elapsedS });
        }
        return events;
      },
    };
  }

  if (cfg.pol === 'proximity') {
    const { R, L } = cfg;
    const latencyS = L / 1000;
    const armedAtS = { left: null, right: null };
    const fired = { left: false, right: false };
    return {
      tick(elapsedS, ball, flippers) {
        const events = [];
        for (const side of ['left', 'right']) {
          if (fired[side]) continue;
          const flipper = flippers[side];
          if (armedAtS[side] === null) {
            const d = Math.hypot(ball.pos.x - flipper.pivot.x, ball.pos.y - flipper.pivot.y);
            if (d <= R) armedAtS[side] = elapsedS + latencyS;
          }
          if (armedAtS[side] !== null && elapsedS >= armedAtS[side]) {
            setActive(flipper, true);
            fired[side] = true;
            events.push({ side, firedAtS: elapsedS });
          }
        }
        return events;
      },
    };
  }

  throw new Error(`unknown policy '${cfg.pol}'`);
}
