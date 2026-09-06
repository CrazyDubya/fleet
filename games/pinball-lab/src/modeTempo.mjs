// MODE-TEMPO: measure completed shots per mode-length window of real simulated play.
//
// Real table (buildTable/wireTable), real solver (advance), real flippers driven by a
// reactive autoplayer. "Shot" is the GAME'S OWN definition — rules/scoring.js's SHOT_TAGS,
// the set the bonus's "shots x 5000" term counts: slide_exit, monkeybars_exit, tunnel_exit,
// sandbox_entry. Ramp EXITS, so a ramp entered and rolled back does not count.
//
// The two arms differ by exactly one line: `world.gravity.y`. Everything else — table,
// policy, seeds, launch speeds, jitter draws — is identical, so the comparison is the
// gravity term and nothing else.
import { createWorld, addBall, addFlipper, advance } from '../../pinball/src/physics/world.js';
import { buildTable, wireTable } from '../../pinball/src/table/assemble.js';
import { createFlipper, setActive } from '../../pinball/src/physics/flipper.js';
import * as recess from '../../pinball/src/table/recess.js';
import { STEP_DT, BALL_RADIUS, PITCH_DEG, PLUNGER_MAX_SPEED } from '../../pinball/src/physics/constants.js';
import { SHOT_TAGS } from '../../pinball/src/rules/scoring.js';
import { createScoop, armScoop, tickScoop } from '../../pinball/src/game/mechanisms.js';
import { MODE_DURATION_S } from '../../pinball/src/rules/modes.js';
import { seededRng } from './seed.js';

const A_SLIDE = 9.81 * Math.sin((PITCH_DEG * Math.PI) / 180);          // pre-8e232ae
const A_ROLL = (5 / 7) * A_SLIDE;                                       // post-8e232ae

export const DEFAULT_POLICY = { lookaheadM: 0.30, skillS: 0.010, holdS: 0.090, relaunchS: 2.0 };
export const PROX_POLICY = { R: 0.16, L: 0.045, jitterS: 0.020, holdS: 0.090, relaunchS: 2.0 };

function build(gravY) {
  const world = createWorld({ pitchDeg: PITCH_DEG });
  world.gravity = { x: 0, y: gravY };            // <-- THE ONE LINE THAT DIFFERS
  const table = buildTable();
  wireTable(world, table);
  const flippers = {};
  for (const cfg of recess.buildFlipperConfigs()) {
    const f = createFlipper(cfg);
    addFlipper(world, f);
    flippers[cfg.name] = f;
  }
  return { world, flippers, table };
}

/** A captured ball is "pinned in a scoop/lock until the game layer ejects it"
 * (physics/world.js:197). Without this the very first sandbox_entry ends the window — the ball
 * sits in the scoop for the remaining 39 s. The SANDBOX path is replicated faithfully:
 * game/mechanisms.js's own armScoop/tickScoop, its real SCOOP_HOLD_S, and main.js's own
 * nudge-clear-then-eject (main.js:1536-1557). The MERRY-GO-ROUND lock is given the same timed
 * release, which is an APPROXIMATION — its real release is a rules-layer multiball decision.
 * Both arms get identical treatment, so it cannot bias the comparison. */
function makeEjector(table) {
  const scoop = createScoop();
  const mgrHeld = [];
  const zone = table.sandbox.captureZone;
  const evel = table.sandbox.eject.vel;
  const evLen = Math.hypot(evel.x, evel.y) || 1;
  const clear = zone.radius * 1.3;
  const release = (ball, centre, vx, vy, r) => {
    const L = Math.hypot(vx, vy) || 1;
    ball.pos = { x: centre.x + (vx / L) * r * 1.3, y: centre.y + (vy / L) * r * 1.3 };
    ball.vel = { x: vx, y: vy };
    ball.captured = false;
  };
  return {
    onCapture(tag, ball, t) {
      if (tag === 'sandbox_entry') armScoop(scoop, t, ball);
      else mgrHeld.push({ ball, at: t + 1.0 });
    },
    tick(t) {
      const out = tickScoop(scoop, t);
      if (out) for (const b of out) release(b, zone.centre, evel.x, evel.y, zone.radius);
      for (let i = mgrHeld.length - 1; i >= 0; i--) {
        if (t >= mgrHeld[i].at) {
          const z = table.merryGoRound.captureZone;
          release(mgrHeld[i].ball, z.centre, 0, -1.2, z.radius);
          mgrHeld.splice(i, 1);
        }
      }
    },
    reset() { scoop.balls = []; scoop.ejectAt = null; mgrHeld.length = 0; },
  };
}

/** ADAPTIVE player — the one that can actually answer this question.
 *
 * The proximity player below (`makeProximityPlayer`) fires a fixed latency after the ball
 * enters a fixed radius. That is NOT a player: a slower ball spends longer inside the radius,
 * so the flip lands at a systematically different point in its approach, and the measured
 * "gravity effect" is really that timing drift. Measured: the shift swings from -43.9% to
 * +7.6% across plausible R/L settings. Unusable.
 *
 * A real player times the flip to the BALL, not to a stopwatch. This one predicts when the
 * ball will reach the bat plane under the world's own gravity — which is what a player who has
 * internalised the table does — and fires one stroke-length before that, so the bat arrives as
 * the ball does, at the same phase of the approach in both arms. `skillS` is timing error.
 */
function makeAdaptivePlayer(flippers, rng, P, gravY) {
  const a = Math.abs(gravY);
  const st = {};
  for (const name of Object.keys(flippers)) st[name] = { releaseAt: null, committed: false };
  const strokeS = {};
  for (const [n, f] of Object.entries(flippers)) strokeS[n] = f.upMs / 1000;
  return function tick(t, balls) {
    for (const [name, f] of Object.entries(flippers)) {
      const s = st[name];
      if (s.releaseAt !== null) {
        if (t >= s.releaseAt) { setActive(f, false); s.releaseAt = null; s.committed = false; }
        continue;
      }
      for (const b of balls) {
        if (!b.active || b.captured || b.layer !== 'playfield') continue;
        if (b.vel.y >= 0) continue;
        const dy = b.pos.y - f.pivot.y;
        if (dy <= 0 || dy > P.lookaheadM) continue;
        if (Math.abs(b.pos.x - f.pivot.x) > f.length * 1.6) continue;   // this flipper's side
        const sp = Math.abs(b.vel.y);
        const tArrive = (-sp + Math.sqrt(sp * sp + 2 * a * dy)) / a;     // fall to the bat plane
        if (tArrive <= strokeS[name] + (rng() - 0.5) * 2 * P.skillS) {
          setActive(f, true); s.releaseAt = t + P.holdS; s.committed = true;
        }
        break;
      }
    }
  };
}

/** Fixed-latency reactive player — kept only to document what it does to the measurement. */
function makeProximityPlayer(flippers, rng, P) {
  const st = {};
  for (const name of Object.keys(flippers)) st[name] = { fireAt: null, releaseAt: null };
  return function tick(t, balls) {
    for (const [name, f] of Object.entries(flippers)) {
      const s = st[name];
      if (s.releaseAt !== null && t >= s.releaseAt) { setActive(f, false); s.releaseAt = null; }
      if (s.fireAt !== null) {
        if (t >= s.fireAt) { setActive(f, true); s.fireAt = null; s.releaseAt = t + P.holdS; }
        continue;
      }
      if (s.releaseAt !== null) continue;                 // already up
      for (const b of balls) {
        if (!b.active || b.layer !== 'playfield') continue;
        if (b.vel.y >= 0) continue;                       // only react to a descending ball
        if (Math.hypot(b.pos.x - f.pivot.x, b.pos.y - f.pivot.y) > P.R) continue;
        s.fireAt = t + P.L + (rng() - 0.5) * 2 * P.jitterS;
        break;
      }
    }
  };
}

export function runWindow(seed, gravY, P = DEFAULT_POLICY, durationS = MODE_DURATION_S) {
  const { world, flippers, table } = build(gravY);
  const ejector = makeEjector(table);
  const rng = seededRng(seed >>> 0);
  const player = P.R === undefined ? makeAdaptivePlayer(flippers, rng, P, gravY) : makeProximityPlayer(flippers, rng, P);

  let shots = 0, drains = 0, inPlaySteps = 0, rampEntries = 0, rollbacks = 0;
  const byTag = new Map();
  let ball = null, relaunchAt = 0;
  const steps = Math.round(durationS / STEP_DT);

  for (let i = 0; i < steps; i++) {
    const t = i * STEP_DT;
    if (ball === null && t >= relaunchAt) {
      const v = PLUNGER_MAX_SPEED * (0.85 + 0.15 * rng());
      ball = addBall(world, { id: 'b', pos: { x: recess.LAUNCH_POSITION.x, y: recess.LAUNCH_POSITION.y },
                              vel: { x: 0, y: v }, radius: BALL_RADIUS, layer: 'playfield', active: true });
    }
    if (ball !== null) {
      inPlaySteps++;
      player(t, world.balls);
      ejector.tick(t);
      for (const e of advance(world, STEP_DT)) {
        const tag = e.tag ?? e.primitive?.shape?.tag;
        if (!tag) continue;
        if (SHOT_TAGS.has(tag)) { shots++; byTag.set(tag, (byTag.get(tag) ?? 0) + 1); }
        if (e.captured) ejector.onCapture(tag, e.ball, t);
        if (e.gateEntered) rampEntries++;
        if (e.rampExit === 'bottom') rollbacks++;
      }
      if (recess.isDrained(ball)) {
        world.balls.length = 0; ball = null; drains++; relaunchAt = t + P.relaunchS; ejector.reset();
        for (const f of Object.values(flippers)) setActive(f, false);
      }
    }
  }
  return { shots, drains, inPlayS: inPlaySteps * STEP_DT, rampEntries, rollbacks, byTag };
}

export { A_SLIDE, A_ROLL };
