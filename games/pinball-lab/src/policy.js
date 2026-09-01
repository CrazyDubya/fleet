// Flipper actuation policies (program handoff §3.2 — "timing is measured, not assumed").
// Pure with respect to the trial: a policy only calls the game's own `setActive`, the same
// entry point a real touch/keyboard input drives (ui/input.js), so it exercises the shipped
// activation path rather than poking flipper.active directly.
import { setActive } from '../../pinball/src/physics/flipper.js';

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
