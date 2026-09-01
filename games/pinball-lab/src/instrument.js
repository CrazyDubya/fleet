// buildWorld(cfg) / runTrial(cfg, seed) -> record. The ONLY file that touches
// `games/pinball/src/physics/*` directly for stepping a trial (arenas/ also imports the
// physics package to construct geometry, but the step loop — where determinism and the
// validity flags live — is here). Everything else (runner, worker, aggregate, replay) calls
// into this module rather than re-deriving any of it.
//
// Purity (test/purity.test.mjs enforces this): no wall-clock read and no unseeded source of
// randomness of any kind. All randomness comes from `seed.js`'s seededRng, itself seeded by
// `(cfgId, seed)` per §2.4/§2.4a — the same trial is bit-for-bit reproducible, and the
// ensemble of trials in a cfg is actually diverse (see seed.js for why that second part
// isn't automatic).
import { advance } from '../../pinball/src/physics/world.js';
import { STEP_DT, MAX_IMPACTS } from '../../pinball/src/physics/constants.js';
import { range } from '../../pinball/src/physics/rng.js';
import { seededRng } from './seed.js';
import { buildE1World, SHOT_LINE_Y, INJECTION, CRADLE_INJECTION } from './arenas/e1_flippers.js';
import { createPolicy } from './policy.js';
import { buildE2World, INJECTION_SPEED as E2_SPEED, INJECTION_ANGLE_DEG as E2_ANGLE } from './arenas/e2_bumpers.js';

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
const E2_TIMEOUT_S = 12.0; // §4.3
const E2_INJECTION_X_MARGIN = 0.02; // keep the sampled x strictly inside the side walls
const E2_EG_CAP = 12; // §4.3's eg[] array: "capped at 12 entries"

/** `(cfgId, seed) -> seeded rng`, per §2.4/§2.4a: the hash of cfgId XORed with the seed, fed
 * through `seed.js`'s splitmix32-seeded, warmed-up xorshift128 — NOT the game's makeRng
 * directly, whose fixed y/z/w constants made every trial in LAB-1's pilot sample the same
 * ball (see seed.js's header comment). cfgId is already an 8-hex-char stable hash
 * (sweep.js); folding it to a uint32 is a reinterpretation, not a second hash. */
export function rngForTrial(cfg, seed) {
  // §4.4's divergence sub-run (`cfg.baseCfgId` set, sweep.js's buildE2DivergenceCfgs) is
  // deliberately seeded from its BASE cfg's id, not its own — its own cfgId differs (it has
  // to: `perturbAngleRad` is real cfg content) but the whole point of the paired re-run is
  // that the same seed draws the identical x0/speed0/angle0Deg triple as the unperturbed
  // trial, diverging only in the angle actually used to launch the ball (applied post-sampling
  // in runE2Trial). Seeding from its own cfgId here would silently break that pairing — every
  // "divergence" delta would really be comparing two unrelated trials.
  const hashSource = cfg.baseCfgId ?? cfg.cfgId;
  const cfgHash = parseInt(hashSource.slice(0, 8), 16) >>> 0;
  return seededRng((cfgHash ^ (seed >>> 0)) >>> 0);
}

function angleDeg(vec) {
  let a = (Math.atan2(vec.y, vec.x) * 180) / Math.PI;
  if (a < 0) a += 360;
  return a;
}

/** Signed angular difference `a - b`, wrapped to (-180, 180] — used for E2's `h1.dev` (how
 * much the first bumper hit turns the ball, sign preserved so a left/right exit-map asymmetry
 * doesn't get erased by taking an absolute value here). */
function angleDiffDeg(a, b) {
  let d = a - b;
  d = ((d + 180) % 360 + 360) % 360 - 180;
  return d === -180 ? 180 : d;
}

function classifyPhase(flipper) {
  if (flipper.active) return flipper.angle === flipper.activeAngle ? 'full' : 'rising';
  return flipper.angle === flipper.restAngle ? 'rest' : 'returning';
}

/** Build the world for one trial. 'e1' (LAB-1/2) and 'e2' (LAB-3); e3 dispatches here once
 * its arena lands (LAB-4). */
export function buildWorld(cfg) {
  if (cfg.exp === 'e1') return buildE1World(cfg);
  if (cfg.exp === 'e2') return buildE2World(cfg);
  throw new Error(`buildWorld: unknown exp '${cfg.exp}'`);
}

/** Run one trial to a terminal state and return its record (plus c/s/f/term). */
export function runTrial(cfg, seed) {
  return runTrialFor(cfg.exp)(cfg, seed).record;
}

/** Same as runTrial, plus the physics-step count — profile.js's µs/step needs a real step
 * count, not a wall-clock guess, and the record formats (§3.4/§4.3) have no room for one.
 * `opts.onStep(snapshot)`, if given, is called once per substep — replay.js's `--trace`. */
export function runTrialWithMeta(cfg, seed, opts) {
  return runTrialFor(cfg.exp)(cfg, seed, opts);
}

function runTrialFor(exp) {
  if (exp === 'e1') return runE1Trial;
  if (exp === 'e2') return runE2Trial;
  throw new Error(`runTrial: unknown exp '${exp}'`);
}

function runE1Trial(cfg, seed, opts) {
  const { world, flippers, ball, shotLineY, bounds } = buildWorld(cfg);
  const rng = rngForTrial(cfg, seed);

  // §3.3 inbound sampling: same distribution, same rng draw order, for every cfg — the same
  // seed gives the same inbound state under every cfg (a paired comparison across cfgs).
  // Ranges live in arenas/e1_flippers.js's INJECTION (§2.4a: "use the shot line and the
  // flipper geometry to choose the band"), not hardcoded here, so they're tuned alongside
  // the geometry they have to land on.
  // §3.5 cradle family (cfg.cradle === true) samples from CRADLE_INJECTION (delivered down
  // the inlane at 0.6-1.8 m/s) instead of the main shot-line band; everything else about the
  // trial loop below is unchanged, so a cradled ball's settle is observed by the same
  // STALLED-flag machinery every other trial already uses.
  const band = cfg.cradle ? CRADLE_INJECTION : INJECTION;
  const x0 = range(rng, band.xMin, band.xMax);
  const speed0 = range(rng, band.speedMin, band.speedMax);
  const angle0Deg = range(rng, band.angleMinDeg, band.angleMaxDeg);
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
    // §3.5 cradle family only (null on every ordinary trial, kept out of NUMERIC_COLUMNS'
    // pilot summary so it doesn't skew non-cradle aggregates): cr = settled while touching a
    // flipper (the STALLED flag can only fire in an arena with no bottom wall by resting on
    // something, and `contacts>0` narrows that to "on a flipper capsule"); st = settle time
    // (s); bn = flipper-contact substeps before settling, a bounce-count proxy.
    cr: cfg.cradle ? ((flags & FLAGS.STALLED) !== 0 && contacts > 0 ? 1 : 0) : null,
    st: cfg.cradle && (flags & FLAGS.STALLED) !== 0 ? stallSinceS : null,
    bn: cfg.cradle ? contacts : null,
  };
  // `inbound` and `steps` are meta, not part of the §3.4 record — runTrial() strips them.
  // §2.4a needs the raw injected state (not vi/ai, which are null on a no-contact trial) to
  // check the ensemble is actually varying, without bloating every stored record.
  return { record, steps, inbound: { x0, speed0, angle0Deg }, contacted: contacts > 0 };
}

/** EXPERIMENT 2 trial loop (§4.3): inject across the bottom edge, run until the ball exits
 * that same edge moving downward, or stalls, or times out (12s), tracking the bumper-specific
 * columns §4.3's record shape asks for. Structurally the same shape as runE1Trial (advance()
 * each substep, check bounds/NaN, check the exit crossing, check stall/timeout) — no
 * actuation policy here, since a bumper field has nothing to fire.
 */
function runE2Trial(cfg, seed, opts) {
  const { world, ball, exitY, bounds } = buildWorld(cfg);
  const rng = rngForTrial(cfg, seed);

  // §4.1 inbound sampling: x across the field width (minus a small margin so the ball spawns
  // strictly inside the side walls), speed 1.5-4.5 m/s, angle over the full up-table half
  // (arenas/e2_bumpers.js's INJECTION_ANGLE_DEG — see its comment for why this isn't narrowed
  // the way E1's band was).
  const xMargin = E2_INJECTION_X_MARGIN;
  const x0 = range(rng, -cfg.fieldWidth / 2 + xMargin, cfg.fieldWidth / 2 - xMargin);
  const speed0 = range(rng, E2_SPEED.min, E2_SPEED.max);
  const angle0Deg = range(rng, E2_ANGLE.min, E2_ANGLE.max);
  let angle0 = (angle0Deg * Math.PI) / 180;
  // §4.4's divergence chaos measure: a paired re-run of the same (cfgId-minus-perturbation,
  // seed) with the inbound angle perturbed by a fixed 1e-6 rad — applied here, after sampling,
  // so the rng draw sequence (and therefore x0/speed0/angle0Deg) is bit-identical to the
  // unperturbed cfg under the same seed; only the *used* angle differs.
  if (cfg.perturbAngleRad) angle0 += cfg.perturbAngleRad;
  ball.pos = { x: x0, y: exitY };
  ball.vel = { x: speed0 * Math.cos(angle0), y: speed0 * Math.sin(angle0) };

  let elapsedS = 0;
  let flags = 0;
  let chain = 0; // §4.4 "chain length": count of bumper-contact events this trial (this
                 // arena's analogue of E1's flipper `contacts` counter).
  let firstHit = null; // §4.3 h1: {dev, vo} from the FIRST bumper contact only.
  const energyRatios = []; // §4.3 eg[]: v_out/v_in per hit, capped at E2_EG_CAP entries.
  let stallSinceS = null;
  let term = null;
  let crossing = null;

  while (term === null) {
    const preVel = { x: ball.vel.x, y: ball.vel.y };

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

    const bumperEvents = events.filter((e) => e.primitive?.bumper);

    if (opts?.onStep) {
      opts.onStep({
        t: elapsedS,
        pos: { x: ball.pos.x, y: ball.pos.y },
        vel: { x: ball.vel.x, y: ball.vel.y },
        contacts: bumperEvents.length,
      });
    }
    if (bumperEvents.length > 0) {
      const preSpeed = Math.hypot(preVel.x, preVel.y);
      const postSpeed = Math.hypot(ball.vel.x, ball.vel.y);
      chain += 1;
      if (energyRatios.length < E2_EG_CAP && preSpeed > 0) energyRatios.push(postSpeed / preSpeed);
      if (firstHit === null) {
        firstHit = {
          dev: angleDiffDeg(angleDeg(ball.vel), angleDeg(preVel)),
          vo: postSpeed,
        };
      }
    }

    // Exit: the ball is at or below the bottom (open) edge, moving downward. Checked BEFORE
    // the bounds/ESCAPED check below and WITHOUT requiring the ball to have first risen above
    // `exitY` (unlike E1's shot-line crossing, which can rely on that because every E1 ball is
    // launched down-table, away from its line, before a flipper can send it back through it).
    // E2 injects across the whole up-table half (0-180°, arenas/e2_bumpers.js), so a
    // near-horizontal shot (ai near 0° or 180°) has vel.y ≈ 0 at injection; gravity alone can
    // pull such a ball's y back to/below `exitY` within the very first substep, before it ever
    // meaningfully entered the field. A `prevY > exitY` gate (E1's pattern, tried first here)
    // misses that case entirely — the ball just free-falls through the open bottom with
    // nothing to catch it, past `bounds.yMin`, and gets misreported as ESCAPED (a solver-
    // tunneling flag) for what is actually an unremarkable, if trivial, real exit. This check
    // only ever runs after `advance()` has been called at least once (the loop's structure),
    // so it can't fire on the ball's literal spawn position before any physics has happened.
    if (ball.pos.y <= exitY && ball.vel.y < 0) {
      crossing = { xx: ball.pos.x, xs: Math.hypot(ball.vel.x, ball.vel.y), xa: angleDeg(ball.vel) };
      term = 'exit';
      break;
    }

    if (
      ball.pos.x < bounds.xMin || ball.pos.x > bounds.xMax ||
      ball.pos.y < bounds.yMin || ball.pos.y > bounds.yMax
    ) {
      flags |= FLAGS.ESCAPED;
      term = 'escaped';
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

    if (elapsedS >= E2_TIMEOUT_S) {
      flags |= FLAGS.TIMEOUT;
      term = 'timeout';
      break;
    }
  }

  const record = {
    c: cfg.cfgId,
    s: seed,
    N: cfg.N,
    af: cfg.areaFraction,
    lay: cfg.layoutVariant,
    vi: speed0,
    ai: angle0Deg,
    h1: firstHit ? { dev: firstHit.dev, vo: firstHit.vo } : null,
    ch: chain,
    dw: elapsedS,
    eg: energyRatios,
    // §4.3: "exit KE / entry KE" — same-mass ratio of squared speeds; null when the trial
    // never reached the exit boundary (a stalled/timed-out ball has no exit KE to report).
    ecum: crossing ? (crossing.xs * crossing.xs) / (speed0 * speed0) : null,
    xx: crossing?.xx ?? null,
    xs: crossing?.xs ?? null,
    xa: crossing?.xa ?? null,
    term,
    f: flags,
  };
  return { record, steps: Math.round(elapsedS / STEP_DT), inbound: { x0, speed0, angle0Deg }, contacted: chain > 0 };
}
