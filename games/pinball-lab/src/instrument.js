// buildWorld(cfg) / runTrial(cfg, seed) -> record. The ONLY file that touches
// `games/pinball/src/physics/*` directly for stepping a trial (arenas/ also imports the
// physics package to construct geometry, but the step loop — where determinism and the
// validity flags live — is here). Everything else (runner, worker, aggregate, replay) calls
// into this module rather than re-deriving any of it.
//
// Purity (test/purity.test.mjs enforces this): no wall-clock read and no unseeded source of
// randomness of any kind. All randomness comes from the game's own seeded `makeRng`, seeded by
// `(cfgId, seed)` per §2.4 — the same trial is bit-for-bit reproducible.
import { advance } from '../../pinball/src/physics/world.js';
import { STEP_DT, MAX_IMPACTS } from '../../pinball/src/physics/constants.js';
import { makeRng, range } from '../../pinball/src/physics/rng.js';
import { buildE1World, SHOT_LINE_Y } from './arenas/e1_flippers.js';
import { createPolicy } from './policy.js';

export const FLAGS = {
  IMPACTS_EXHAUSTED: 1,
  ESCAPED: 2,
  TIMEOUT: 4,
  STALLED: 8,
  NAN: 16,
};

const STALL_SPEED = 0.05; // m/s
const STALL_DURATION_S = 0.5;
const E1_TIMEOUT_S = 2.0; // §3.1

/** `(cfgId, seed) -> seeded rng`, per §2.4: the hash of cfgId XORed with the seed. cfgId is
 * already an 8-hex-char stable hash (sweep.js); folding it to a uint32 for the xorshift seed
 * is just a reinterpretation, not a second hash. */
export function rngForTrial(cfg, seed) {
  const cfgHash = parseInt(cfg.cfgId.slice(0, 8), 16) >>> 0;
  return makeRng((cfgHash ^ (seed >>> 0)) >>> 0);
}

function angleDeg(vec) {
  let a = (Math.atan2(vec.y, vec.x) * 180) / Math.PI;
  if (a < 0) a += 360;
  return a;
}

function classifyPhase(flipper) {
  if (flipper.active) return flipper.angle === flipper.activeAngle ? 'full' : 'rising';
  return flipper.angle === flipper.restAngle ? 'rest' : 'returning';
}

/** Build the world for one trial. Only 'e1' exists yet (LAB-1 scope); e2/e3 dispatch here
 * once their arenas land (LAB-3/LAB-4). */
export function buildWorld(cfg) {
  if (cfg.exp === 'e1') return buildE1World(cfg);
  throw new Error(`buildWorld: unknown exp '${cfg.exp}'`);
}

/** Run one E1 trial to a terminal state and return its §3.4 record (plus c/s/f/term). */
export function runTrial(cfg, seed) {
  if (cfg.exp !== 'e1') throw new Error(`runTrial: unknown exp '${cfg.exp}'`);
  return runE1Trial(cfg, seed).record;
}

/** Same as runTrial, plus the physics-step count — profile.js's µs/step needs a real step
 * count, not a wall-clock guess, and the spec's record format (§3.4) has no room for one.
 * `opts.onStep(snapshot)`, if given, is called once per substep — replay.js's `--trace`. */
export function runTrialWithMeta(cfg, seed, opts) {
  if (cfg.exp !== 'e1') throw new Error(`runTrialWithMeta: unknown exp '${cfg.exp}'`);
  return runE1Trial(cfg, seed, opts);
}

function runE1Trial(cfg, seed, opts) {
  const { world, flippers, ball, shotLineY, bounds } = buildWorld(cfg);
  const rng = rngForTrial(cfg, seed);

  // §3.3 inbound sampling: same distribution, same rng draw order, for every cfg — the same
  // seed gives the same inbound state under every cfg (a paired comparison across cfgs).
  const x0 = range(rng, -0.2, 0.2);
  const speed0 = range(rng, 0.3, 4.5);
  const angle0Deg = range(rng, 190, 350);
  const angle0 = (angle0Deg * Math.PI) / 180;
  ball.pos = { x: x0, y: shotLineY };
  ball.vel = { x: speed0 * Math.cos(angle0), y: speed0 * Math.sin(angle0) };

  const policy = createPolicy(cfg);
  const firedAtS = { left: null, right: null };

  let elapsedS = 0;
  let prevY = ball.pos.y;
  let flags = 0;
  let contacts = 0;
  let firstContact = null;
  let stallSinceS = null;
  let term = null;
  let crossing = null;
  let steps = 0;

  while (term === null) {
    steps += 1;
    const preVel = { x: ball.vel.x, y: ball.vel.y };

    for (const ev of policy.tick(elapsedS, ball, flippers)) firedAtS[ev.side] = ev.firedAtS;

    const events = advance(world, STEP_DT);
    elapsedS += STEP_DT;

    if (
      !Number.isFinite(ball.pos.x) || !Number.isFinite(ball.pos.y) ||
      !Number.isFinite(ball.vel.x) || !Number.isFinite(ball.vel.y)
    ) {
      flags |= FLAGS.NAN;
      term = 'nan';
      break;
    }

    if (events.length >= MAX_IMPACTS) flags |= FLAGS.IMPACTS_EXHAUSTED;

    const flipperEvents = events.filter((e) => e.primitive?.flipper);

    if (opts?.onStep) {
      opts.onStep({
        t: elapsedS,
        pos: { x: ball.pos.x, y: ball.pos.y },
        vel: { x: ball.vel.x, y: ball.vel.y },
        left: { angle: (flippers.left.angle * 180) / Math.PI, omega: flippers.left.angularVel },
        right: { angle: (flippers.right.angle * 180) / Math.PI, omega: flippers.right.angularVel },
        contacts: flipperEvents.length,
      });
    }
    if (flipperEvents.length > 0) {
      contacts += 1;
      if (firstContact === null) {
        const hit = flipperEvents[0];
        const flipper = hit.primitive.flipper;
        const side = flipper === flippers.left ? 'left' : 'right';
        const hs = Math.min(1, Math.max(0, Math.hypot(hit.point.x - flipper.pivot.x, hit.point.y - flipper.pivot.y) / flipper.length));
        const fAt = firedAtS[side];
        firstContact = {
          vi: Math.hypot(preVel.x, preVel.y),
          ai: angleDeg(preVel),
          hs,
          hp: classifyPhase(flipper),
          ha: (flipper.angle * 180) / Math.PI,
          hw: flipper.angularVel,
          dt: fAt !== null ? (elapsedS - fAt) * 1000 : null,
          vo: Math.hypot(ball.vel.x, ball.vel.y),
          ao: angleDeg(ball.vel),
        };
      }
    }

    if (
      ball.pos.x < bounds.xMin || ball.pos.x > bounds.xMax ||
      ball.pos.y < bounds.yMin || ball.pos.y > bounds.yMax
    ) {
      flags |= FLAGS.ESCAPED;
      term = 'escaped';
      break;
    }

    if (prevY < shotLineY && ball.pos.y >= shotLineY && ball.vel.y > 0) {
      crossing = { xx: ball.pos.x, xs: Math.hypot(ball.vel.x, ball.vel.y), xa: angleDeg(ball.vel) };
      term = 'shotline';
      break;
    }

    if (ball.pos.y <= 0.001) {
      term = 'drain';
      break;
    }

    const speed = Math.hypot(ball.vel.x, ball.vel.y);
    if (speed < STALL_SPEED) {
      if (stallSinceS === null) stallSinceS = elapsedS;
      if (elapsedS - stallSinceS > STALL_DURATION_S) {
        flags |= FLAGS.STALLED;
        term = 'stall';
        break;
      }
    } else {
      stallSinceS = null;
    }

    if (elapsedS >= E1_TIMEOUT_S) {
      flags |= FLAGS.TIMEOUT;
      term = 'timeout';
      break;
    }

    prevY = ball.pos.y;
  }

  const record = {
    c: cfg.cfgId,
    s: seed,
    pol: cfg.pol,
    R: cfg.R ?? null,
    L: cfg.L ?? null,
    vi: firstContact?.vi ?? null,
    ai: firstContact?.ai ?? null,
    hs: firstContact?.hs ?? null,
    hp: firstContact?.hp ?? null,
    ha: firstContact?.ha ?? null,
    hw: firstContact?.hw ?? null,
    dt: firstContact?.dt ?? null,
    vo: firstContact?.vo ?? null,
    ao: firstContact?.ao ?? null,
    n: contacts,
    xx: crossing?.xx ?? null,
    xs: crossing?.xs ?? null,
    xa: crossing?.xa ?? null,
    term,
    f: flags,
  };
  return { record, steps };
}
