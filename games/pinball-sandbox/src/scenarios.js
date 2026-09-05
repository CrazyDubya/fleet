// SCENARIO HARNESS — named, data-driven physics trials against the REAL sandbox physics/table
// (never a copy: same relative imports as src/main.js), so a question like "what happens to two
// balls in the scoop at once" or "does this speed escape the captive channel" is a reusable,
// deterministic run instead of a scratch script written once and thrown away.
//
// Every scenario runs headless (no THREE, no DOM, no requestAnimationFrame) at the physics
// engine's own fixed STEP_DT, so the same call from `node --test` and from the sandbox's UI
// gives byte-identical results — determinism matters more than real-time playback here.
//
// Two scenario kinds exist because two different physics setups are being tested, not because
// scenarios themselves are code: adding the next scenario of an existing kind is a data entry
// in SCENARIOS below, nothing more.
//
//   'sandbox-table' — stages balls on the REAL table (buildTable()/wireTable(), the same
//   assembly src/main.js and games/pinball/src/main.js both use) and drives the SANDBOX scoop's
//   real capture-zone + createScoop/armScoop/tickScoop exactly as src/main.js's own frame loop
//   does (the eject-repositioning snippet below is copied from src/main.js's frame(), not
//   reimplemented differently — same clearance math, same eject vector). NOTE: this scenario
//   was written to demonstrate the ball-orphaning bug from
//   ledger/handoffs/haiku-fs2/20260905-sandbox-machine-delta.txt, but sonnet2 fixed it
//   (game/mechanisms.js's armScoop/tickScoop, 2026-09-05, "scoop-orphan.test.mjs") while this
//   dispatch was in progress: the scoop now holds an array (`scoop.balls`) and ejects every
//   ball armScoop captured since the last eject together, not one at a time. This scenario is
//   kept as a standing regression check on that fix — two balls captured within one hold
//   window now BOTH eject together, which is exactly what it reports below.
//
//   'channel' — reproduces sonnet2's captive-ball scratch proof (handoff
//   ledger/handoffs/sonnet2/20260905T090000Z-captive-ball-finding.md: two parallel Segment side
//   walls + an Arc backstop, using only existing physics primitives) as a standing scenario
//   instead of a one-off script, so the phase-vs-speed containment question it raised (confined
//   at some speeds, tunnels through the thin Arc backstop at others — non-monotonic, not a
//   simple "harder hits escape more" threshold) can be re-run at any speed/offset and reported,
//   not re-derived by hand each time.
//   'ramp-reachability' — ports the 81-sample ramp-exit-to-flipper sweep methodology (its exact
//   posOffsets/angleOffsetsDeg/speedOffsets/three-flipper-states/alongBat measurement) into the
//   scenario harness, generalized over which ramp and which flipper. Three instances are ported
//   below, each reproducing a figure already published in a comment or a test, never a fresh
//   guess at what these should measure:
//     - 'orbit-reachability-right' reproduces test/orbit-reachability.test.mjs's own pinned
//       81/81 contact assertion (buildOrbitRamp -> right flipper).
//     - 'slide-reachability-left' reproduces table/ramps.js's buildSlideRamp doc comment
//       ("contact in 81/81 samples ... mid-bat in 66 of the same 81") — that figure was a
//       one-off scratch measurement backing the 2026-09-04 re-aim, never committed as a
//       standing check until now.
//     - 'monkeybars-reachability-upperLeft' reproduces buildMonkeyBarsRamp's doc comment
//       ("contact in 81/81 samples ... mid-bat in all 81"), same situation.
//   The flipper's rest/active angle is read off the SAME createFlipper() object the trial fires
//   the ball at (target.restAngle/activeAngle, already in radians) rather than re-deriving
//   `180 - lowerAngle` locally — one source of truth, not a second copy of recess.js's own
//   mirroring formula.
import { createWorld, setLayerPrimitives, setLayerZones, addBall, addFlipper, advance } from '../../pinball/src/physics/world.js';
import { buildTable, wireTable } from '../../pinball/src/table/assemble.js';
import { createFlipper } from '../../pinball/src/physics/flipper.js';
import * as game from '../../pinball/src/game/mechanisms.js';
import * as recess from '../../pinball/src/table/recess.js';
import * as ramps from '../../pinball/src/table/ramps.js';
import { Segment, Arc } from '../../pinball/src/physics/shapes.js';
import { scale, rotate, perp } from '../../pinball/src/physics/vec2.js';
import { BALL_RADIUS, STEP_DT, E_WALL } from '../../pinball/src/physics/constants.js';

const DEG = Math.PI / 180;

export const SCENARIOS = {
  'scoop-two-balls': {
    label: 'SANDBOX scoop: two balls within one hold window',
    kind: 'sandbox-table',
    durationS: 2.0,
    // Both balls spawn already inside the real capture-zone radius (captured on their very
    // first physics step — checkCaptures in physics/world.js is a static distance check, not a
    // crossing event, so this is a deterministic way to "drive a ball in" without needing an
    // approach trajectory). `spawnAtS` staggers the second entry to 0.5s into the first ball's
    // 1.0s SCOOP_HOLD_S hold — inside the window the dispatch asked about.
    balls: [
      { id: 'a', spawnAtS: 0.0 },
      { id: 'b', spawnAtS: 0.5 },
    ],
  },
  'arc-containment': {
    label: 'Captive channel: contained vs. escaped through the backstop',
    kind: 'channel',
    durationS: 1.5,
    // 1.6 ball diameters wide — sonnet2's own figure, "the same order as every other lane on
    // this table". backstopPadding starts at 0 (the thin-Arc case sonnet2 actually measured
    // tunneling through); a build that ships this for real would need to widen it per that
    // handoff's own fix note, but that's not this scenario's job to decide.
    channel: { length: 0.12, halfWidth: 1.6 * BALL_RADIUS, backstopPadding: 0 },
    ball: { speed: 6.0, offset: 0 },
  },
  'orbit-reachability-right': {
    label: "THE ORBIT's exit reachability toward the right flipper (81-sample sweep)",
    kind: 'ramp-reachability',
    rampBuilder: 'buildOrbitRamp',
    flipperName: 'right',
    // Same 3x3x3x3 sweep as the ported test: ±3mm position (perpendicular to the exit
    // direction), ±4° direction, ±0.15 m/s speed, x 3 flipper states (rest/active/flip-at-arrival).
    posOffsets: [-0.003, 0, 0.003],
    angleOffsetsDeg: [-4, 0, 4],
    speedOffsets: [-0.15, 0, 0.15],
    durationS: 1.5,
  },
  'slide-reachability-left': {
    label: 'THE SLIDE\'s exit reachability toward the left flipper (81-sample sweep)',
    kind: 'ramp-reachability',
    rampBuilder: 'buildSlideRamp',
    flipperName: 'left',
    posOffsets: [-0.003, 0, 0.003],
    angleOffsetsDeg: [-4, 0, 4],
    speedOffsets: [-0.15, 0, 0.15],
    durationS: 1.5,
  },
  'monkeybars-reachability-upperLeft': {
    label: "MONKEY BARS' exit reachability toward the upper-left flipper (81-sample sweep)",
    kind: 'ramp-reachability',
    rampBuilder: 'buildMonkeyBarsRamp',
    flipperName: 'upperLeft',
    posOffsets: [-0.003, 0, 0.003],
    angleOffsetsDeg: [-4, 0, 4],
    speedOffsets: [-0.15, 0, 0.15],
    durationS: 1.5,
  },
};

function runSandboxTableScenario(def, overrides) {
  const world = createWorld();
  const table = buildTable();
  wireTable(world, table);
  const zone = table.sandbox.captureZone;
  const scoop = game.createScoop();

  const balls = (overrides.balls ?? def.balls).map((b) => ({
    id: b.id, spawnAtS: b.spawnAtS, spawned: false, phys: null,
  }));
  const durationS = overrides.durationS ?? def.durationS;
  const events = [];
  let elapsedS = 0;
  let stepsRun = 0;
  const steps = Math.round(durationS / STEP_DT);

  for (let i = 0; i < steps; i++) {
    stepsRun += 1;
    for (const b of balls) {
      if (!b.spawned && elapsedS >= b.spawnAtS) {
        b.phys = addBall(world, {
          id: b.id, pos: { x: zone.centre.x, y: zone.centre.y }, vel: { x: 0, y: 0 },
          radius: BALL_RADIUS, active: true, layer: 'playfield', captured: false, z: 0,
        });
        b.spawned = true;
      }
    }

    const stepEvents = advance(world, STEP_DT);
    for (const event of stepEvents) {
      if (event.tag === zone.tag) {
        game.armScoop(scoop, elapsedS, event.ball);
        events.push({ atS: elapsedS, type: 'captured', ball: balls.find((b) => b.phys === event.ball)?.id });
      }
    }

    // Eject-on-hold-expiry: the exact snippet src/main.js's frame() runs, not a reimplementation
    // (same sandbox.eject.vel, same 1.3x capture-radius clearance, same "every ball armScoop
    // captured since the last eject leaves together" fix).
    const ejectedBalls = game.tickScoop(scoop, elapsedS);
    if (ejectedBalls) {
      const evel = table.sandbox.eject.vel;
      const evLen = Math.hypot(evel.x, evel.y) || 1;
      const clear = zone.radius * 1.3;
      for (const ejected of ejectedBalls) {
        ejected.pos = {
          x: zone.centre.x + (evel.x / evLen) * clear,
          y: zone.centre.y + (evel.y / evLen) * clear,
        };
        ejected.vel = { x: evel.x, y: evel.y };
        ejected.captured = false;
        events.push({ atS: elapsedS, type: 'ejected', ball: balls.find((b) => b.phys === ejected)?.id });
      }
    }

    elapsedS += STEP_DT;
  }

  assertRan(stepsRun, 'scoop-two-balls');
  return {
    name: 'scoop-two-balls',
    durationS,
    stepsRun,
    events,
    balls: balls.map((b) => ({ id: b.id, captured: !!b.phys?.captured, finalPos: { ...b.phys.pos } })),
  };
}

function runChannelScenario(def, overrides) {
  const channel = { ...def.channel, ...(overrides.channel ?? {}) };
  const ballParams = { ...def.ball, ...(overrides.ball ?? {}) };
  const { length, halfWidth, backstopPadding } = channel;

  // Side walls run from the open near end (y=0) to the closed far end (y=length). The Arc
  // backstop is centred on the far end at y=length with radius=halfWidth so it meets both
  // walls flush; a0=PI..a1=2*PI selects the half of the circle facing back down the channel
  // (into it), which is the surface a ball travelling in +y actually strikes — see
  // physics/solver.js's angleInRange/sweepCircleArc for the convention this depends on.
  const leftWall = Segment({ x: -halfWidth, y: 0 }, { x: -halfWidth, y: length }, E_WALL, 'channel_wall');
  const rightWall = Segment({ x: halfWidth, y: 0 }, { x: halfWidth, y: length }, E_WALL, 'channel_wall');
  const backstop = Arc({ x: 0, y: length }, halfWidth, Math.PI, 2 * Math.PI, E_WALL, 'channel_backstop', backstopPadding);

  const world = createWorld();
  setLayerPrimitives(world, 'playfield', [{ shape: leftWall }, { shape: rightWall }, { shape: backstop }]);

  const ball = addBall(world, {
    id: 'probe', pos: { x: ballParams.offset, y: 0 }, vel: { x: 0, y: ballParams.speed },
    radius: BALL_RADIUS, active: true, layer: 'playfield', captured: false, z: 0,
  });

  const durationS = overrides.durationS ?? def.durationS;
  // Clear of the backstop's own far (outer) surface — a ball that reaches here didn't bounce
  // off the arc, it tunnelled through it.
  const escapeThreshold = length + halfWidth + 0.01;
  let escapedAtS = null;
  let maxY = ball.pos.y;
  let elapsedS = 0;
  let stepsRun = 0;
  const steps = Math.round(durationS / STEP_DT);

  for (let i = 0; i < steps; i++) {
    stepsRun += 1;
    advance(world, STEP_DT);
    elapsedS += STEP_DT;
    maxY = Math.max(maxY, ball.pos.y);
    if (escapedAtS === null && ball.pos.y > escapeThreshold) escapedAtS = elapsedS;
  }

  assertRan(stepsRun, 'arc-containment');
  return {
    name: 'arc-containment',
    durationS,
    stepsRun,
    channel,
    ball: ballParams,
    contained: escapedAtS === null,
    escapedAtS,
    maxY,
    finalPos: { ...ball.pos },
  };
}

function buildRampReachabilityWorld() {
  const world = createWorld();
  const table = buildTable();
  setLayerPrimitives(world, 'playfield', table.primitives);
  setLayerZones(world, 'playfield', table.zones);
  const flippers = {};
  for (const cfg of recess.buildFlipperConfigs()) {
    const f = createFlipper(cfg);
    addFlipper(world, f);
    flippers[cfg.name] = f;
  }
  return { world, flippers };
}

/** One trial, identical in method to orbit-reachability.test.mjs's own `trial()`: fires a ball
 * at `pos`/`vel` toward `flipperName`'s own capsule, held at `angleRad` (or naturally flipping
 * mid-flight if `angleRad === 'flip-at-arrival'`), and reports whether it made contact within
 * `durationS` plus the along-bat fraction (0=pivot, 1=tip; outside [0,1] = a graze on the round
 * hub, not the bat body) of the first contact. */
function rampReachabilityTrial({ pos, vel, flipperName, angleRad, durationS }) {
  const { world, flippers } = buildRampReachabilityWorld();
  const target = flippers[flipperName];
  if (angleRad === 'flip-at-arrival') { target.angle = target.restAngle; target.angularVel = 0; target.active = true; }
  else { target.angle = angleRad; target.angularVel = 0; target.active = false; }
  const ball = addBall(world, { id: 't', pos: { x: pos.x, y: pos.y }, vel: { x: vel.x, y: vel.y }, radius: BALL_RADIUS });
  const steps = Math.round(durationS / STEP_DT);
  for (let i = 0; i < steps; i++) {
    const prev = { x: ball.pos.x, y: ball.pos.y };
    const angleNow = target.angle;
    const events = advance(world, STEP_DT);
    for (const e of events) {
      if (e.primitive?.flipper?.tag !== target.tag) continue;
      const alongBat = ((prev.x - target.pivot.x) * Math.cos(angleNow) + (prev.y - target.pivot.y) * Math.sin(angleNow)) / target.length;
      return { hit: true, alongBat };
    }
    if (recess.isDrained(ball)) break;
  }
  return { hit: false, alongBat: null };
}

function runRampReachabilityScenario(def, overrides, name) {
  const flipperName = overrides.flipperName ?? def.flipperName;
  const rampBuilder = overrides.rampBuilder ?? def.rampBuilder;
  const posOffsets = overrides.posOffsets ?? def.posOffsets;
  const angleOffsetsDeg = overrides.angleOffsetsDeg ?? def.angleOffsetsDeg;
  const speedOffsets = overrides.speedOffsets ?? def.speedOffsets;
  const durationS = overrides.durationS ?? def.durationS;

  // The ramp's own exit point/direction/speed, read live from ramps.js — never a copied
  // constant, so a deliberate re-aim of the ramp shows up here automatically.
  const built = ramps[rampBuilder]();
  const pos = built.ramp.exit.pos;
  const dir = built.ramp.exit.dir;
  const speed = built.ramp.exit.speed;
  const side = perp(dir);

  // The target flipper's own rest/active angles (radians), read off a real createFlipper()
  // object built from recess.js's own config — not re-derived from a mirrored-angle formula.
  const probe = buildRampReachabilityWorld();
  const target = probe.flippers[flipperName];
  // Labeled so a single trial (below) can be selected by the SAME label the null test groups
  // by, without re-deriving which angle a label means in two places.
  const flipperStateByLabel = { rest: target.restAngle, active: target.activeAngle, 'flip-at-arrival': 'flip-at-arrival' };
  const flipperStates = [flipperStateByLabel.rest, flipperStateByLabel.active, flipperStateByLabel['flip-at-arrival']];

  // Single-trial mode: runs exactly ONE of the 81 trials below, identified by its flipper-state
  // label and its (pos, angle, speed) combo index (0..80/3-1, decoded against the SAME
  // posOffsets/angleOffsetsDeg/speedOffsets arrays and the SAME pos/dir/speed/side the full
  // sweep uses below — never a re-derivation, so this can never silently diverge from the
  // trial the aggregate sweep already ran). Exists so runScenarioNullTest (which drives a grid
  // of independent runScenario() calls) can address individual trials from this scenario's own
  // 81-sample sweep, grouped by flipper state, without inventing a new sweep or new geometry.
  if (overrides.singleTrial) {
    const { flipperStateLabel, comboIndex } = overrides.singleTrial;
    const angleRad = flipperStateByLabel[flipperStateLabel];
    if (angleRad === undefined) {
      throw new Error(`runScenario: "${name}" singleTrial.flipperStateLabel must be one of rest/active/flip-at-arrival, got ${JSON.stringify(flipperStateLabel)}`);
    }
    const nAngle = angleOffsetsDeg.length;
    const nSpeed = speedOffsets.length;
    const total81 = posOffsets.length * nAngle * nSpeed;
    if (!Number.isInteger(comboIndex) || comboIndex < 0 || comboIndex >= total81) {
      throw new Error(`runScenario: "${name}" singleTrial.comboIndex must be an integer in [0, ${total81}), got ${JSON.stringify(comboIndex)}`);
    }
    const dpIdx = Math.floor(comboIndex / (nAngle * nSpeed));
    const rem = comboIndex % (nAngle * nSpeed);
    const daIdx = Math.floor(rem / nSpeed);
    const dsIdx = rem % nSpeed;
    const dp = posOffsets[dpIdx];
    const da = angleOffsetsDeg[daIdx];
    const ds = speedOffsets[dsIdx];
    const p = { x: pos.x + side.x * dp, y: pos.y + side.y * dp };
    const d = rotate(dir, da * DEG);
    const v = scale(d, speed + ds);
    const r = rampReachabilityTrial({ pos: p, vel: v, flipperName, angleRad, durationS });
    const midBatHit = r.hit && r.alongBat >= 0 && r.alongBat <= 1;
    return {
      name, flipperName, rampBuilder, durationS,
      singleTrial: { flipperStateLabel, comboIndex, posOffset: dp, angleOffsetDeg: da, speedOffset: ds },
      hit: r.hit, alongBat: r.alongBat, midBat: midBatHit,
    };
  }

  let total = 0, contact = 0, midBat = 0;
  for (const dp of posOffsets) {
    const p = { x: pos.x + side.x * dp, y: pos.y + side.y * dp };
    for (const da of angleOffsetsDeg) {
      const d = rotate(dir, da * DEG);
      for (const ds of speedOffsets) {
        const v = scale(d, speed + ds);
        for (const angleRad of flipperStates) {
          total += 1;
          const r = rampReachabilityTrial({ pos: p, vel: v, flipperName, angleRad, durationS });
          if (r.hit) {
            contact += 1;
            if (r.alongBat >= 0 && r.alongBat <= 1) midBat += 1;
          }
        }
      }
    }
  }

  if (total === 0) {
    throw new Error(
      `runScenario: "${name}" ran 0 trials — check posOffsets/angleOffsetsDeg/speedOffsets are non-empty arrays.`
    );
  }
  return { name, flipperName, rampBuilder, durationS, total, contact, midBat };
}

// A report field is only trustworthy if something actually computed it. `contained`,
// `captured`, etc. all start from values chosen so a run that never executes a single step
// (a non-positive/NaN duration, a world that fails to build before the loop, balls that never
// get placed) can't silently read as a passing result just because nothing overwrote a
// pre-set default — the failure mode a review caught here (a zero-duration channel scenario
// reporting `contained: true` because `escapedAtS` never left its `null` initial value).
// Rather than special-casing "reject non-positive duration" (which only closes this one input
// and leaves the same shape open for every other reason a run could execute zero steps), both
// runners count the steps they actually ran and this throws if that count is ever zero — an
// explicit failure instead of a report indistinguishable from success.
function assertRan(stepsRun, scenarioName) {
  if (stepsRun === 0) {
    throw new Error(
      `runScenario: "${scenarioName}" executed 0 physics steps — nothing was simulated, so its ` +
      'result cannot be trusted. Check durationS (must be a positive number).'
    );
  }
}

const RUNNERS = {
  'sandbox-table': runSandboxTableScenario,
  channel: runChannelScenario,
  'ramp-reachability': runRampReachabilityScenario,
};

/** Runs a named scenario from SCENARIOS, with optional per-field overrides (e.g.
 * `runScenario('arc-containment', { ball: { speed: 4.9 } })`), and returns a plain,
 * JSON-serializable report — the same object a test asserts on and the sandbox UI prints. */
export function runScenario(name, overrides = {}) {
  const def = SCENARIOS[name];
  if (!def) throw new Error(`runScenario: unknown scenario "${name}"`);
  const runner = RUNNERS[def.kind];
  if (!runner) throw new Error(`runScenario: unknown scenario kind "${def.kind}"`);
  return runner(def, overrides, name);
}

/** Formats a report from runScenario() as short, human-readable lines for an on-screen readout. */
export function formatReport(report) {
  if (report.name === 'scoop-two-balls') {
    const lines = [`scenario: scoop-two-balls (${report.durationS.toFixed(1)}s)`];
    for (const b of report.balls) lines.push(`  ball ${b.id}: captured=${b.captured}`);
    for (const e of report.events) lines.push(`  t=${e.atS.toFixed(2)}s ${e.type} (${e.ball})`);
    return lines.join('\n');
  }
  if (report.name === 'arc-containment') {
    return [
      `scenario: arc-containment (speed=${report.ball.speed} m/s, offset=${report.ball.offset}m)`,
      `  contained: ${report.contained}`,
      report.contained ? `  max y reached: ${report.maxY.toFixed(4)}m` : `  escaped at t=${report.escapedAtS.toFixed(3)}s`,
    ].join('\n');
  }
  if (report.rampBuilder) {
    return [
      `scenario: ${report.name} (${report.durationS.toFixed(1)}s, ${report.total} samples)`,
      `  contact: ${report.contact}/${report.total}  mid-bat: ${report.midBat}/${report.total}`,
    ].join('\n');
  }
  return JSON.stringify(report);
}

// --- GRID SWEEPS ---------------------------------------------------------------------------
// This week's actual throwaway scripts all did the same thing: vary one or two parameters and
// report a table (six speeds against containment, eighty-one start positions against contact,
// four feeds against contact point) — one configuration in, one result out, every time re-run
// by hand. runScenarioGrid sweeps two parameters over a named scenario and reports the matrix,
// so that becomes a standing call instead of a new script.
//
// Determinism across the grid: each cell is an entirely independent runScenario() call against
// a freshly `structuredClone`d overrides object — nothing here mutates state that a later cell
// could see. This isn't new plumbing to get right; it falls out of runSandboxTableScenario/
// runChannelScenario already building a fresh world from scratch on every single call. What
// this function has to get right is not accidentally sharing anything ACROSS cells itself
// (e.g. reusing one overrides object and mutating it per-cell, which would make cell 5 see
// leftover fields cell 4 set) — hence the clone per cell, not a shared mutable draft.

/** Sets a dot-path (e.g. 'ball.speed') on `obj`, creating intermediate objects as needed, and
 * returns `obj`. Pure string-key traversal — no array-index or bracket syntax needed for any
 * scenario field that exists today. */
function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * Runs `name` once per (x, y) pair in `xValues` x `yValues`, applying each value as an override
 * at `xPath`/`yPath` (dot-separated into the scenario's own overrides shape — e.g. 'ball.speed',
 * 'ball.offset') on top of `overrides`. `extract(report)` pulls the one value worth putting in
 * the matrix out of each cell's full report (e.g. `(r) => r.contained`); omit it to keep full
 * reports per cell (readable for a small grid, unwieldy for a large one — see formatGrid).
 *
 * A cell whose run throws (see assertRan in runSandboxTableScenario/runChannelScenario — a
 * scenario that executed 0 physics steps refuses to return a result at all) is recorded as
 * `{ ok: false, error }`, a hole in the matrix, never coerced into a value that reads as a
 * result. This is the same principle SBX-FIX-1 fixed for a single run, multiplied by a grid:
 * a hole must show as a hole, not silently disappear into whatever a summary's default would be.
 *
 * Returns `{ name, xPath, xValues, yPath, yValues, cells, summary }` — `cells[i][j]` is the
 * result for `(xValues[i], yValues[j])`; `summary` is `summarizeBooleanGrid`'s shape-level read
 * of the matrix when every cell's extracted value is a boolean (the common case — contained/
 * escaped, hit/miss), since a wall of 81 raw values helps nobody but the question a sweep is
 * usually asked ("where's the boundary, is it monotonic, are there islands") is a shape
 * question, answerable from booleans alone.
 */
export function runScenarioGrid(name, { xPath, xValues, yPath, yValues, overrides = {}, extract } = {}) {
  const cells = [];
  for (const xv of xValues) {
    const row = [];
    for (const yv of yValues) {
      const cellOverrides = setPath(setPath(structuredClone(overrides), xPath, xv), yPath, yv);
      try {
        const report = runScenario(name, cellOverrides);
        row.push({ ok: true, value: extract ? extract(report) : report });
      } catch (err) {
        row.push({ ok: false, error: err.message });
      }
    }
    cells.push(row);
  }
  const summary = extract ? summarizeBooleanGrid(cells) : { note: 'no extract() given — cells hold full reports, no shape summary' };
  return { name, xPath, xValues, yPath, yValues, cells, summary };
}

/**
 * A shape-level read of a grid whose cells hold booleans (or holes): an ASCII render ('#'=true,
 * '.'=false, '?'=hole — one line per xValues row, left-to-right along yValues) plus whether
 * each row (fixed x, varying y) and each column (fixed y, varying x) changes value at most once
 * (monotonic) or more than once (an ISLAND — the exact shape the arc-containment escape-speed
 * question turned on: containment at two speeds either side of an escape is not guaranteed
 * monotonic, and that was only visible because someone laid the numbers in a row). Holes are
 * skipped when counting transitions (a missing cell is neither true nor false), so a hole
 * doesn't get misread as a spurious transition — but every hole is still counted and reported,
 * since a matrix with a hole in it must show the hole, not paper over it.
 */
function summarizeBooleanGrid(cells) {
  const holeCoords = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells[i].length; j++) {
      if (!cells[i][j].ok) holeCoords.push([i, j]);
      else if (typeof cells[i][j].value !== 'boolean') {
        return { note: 'summary only implemented for boolean-valued grids — read cells directly', holeCoords };
      }
    }
  }

  function transitions(values) {
    let count = 0;
    let last = null;
    for (const v of values) {
      if (v === null) continue; // hole
      if (last !== null && v !== last) count += 1;
      last = v;
    }
    return count;
  }

  const rows = cells.map((row) => row.map((c) => (c.ok ? c.value : null)));
  const rowTransitions = rows.map(transitions);
  const colCount = rows[0]?.length ?? 0;
  const colTransitions = [];
  for (let j = 0; j < colCount; j++) {
    colTransitions.push(transitions(rows.map((row) => row[j])));
  }

  return {
    ascii: rows.map((row) => row.map((v) => (v === null ? '?' : v ? '#' : '.')).join('')),
    holeCount: holeCoords.length,
    holeCoords,
    rowsWithMultipleTransitions: rowTransitions.filter((t) => t > 1).length,
    colsWithMultipleTransitions: colTransitions.filter((t) => t > 1).length,
    monotonic: rowTransitions.every((t) => t <= 1) && colTransitions.every((t) => t <= 1),
  };
}

/** Formats a grid report (from runScenarioGrid) as short, human-readable lines: the ASCII
 * shape plus its own summary — never the raw per-cell values (that's the "wall of numbers"
 * this exists to avoid; read `report.cells` directly for that). */
export function formatGrid(report) {
  const lines = [
    `grid: ${report.name} (${report.xPath} x ${report.yPath}, ${report.xValues.length}x${report.yValues.length})`,
  ];
  if (report.summary.ascii) {
    lines.push(...report.summary.ascii.map((row) => `  ${row}`));
    lines.push(`  holes: ${report.summary.holeCount}  monotonic: ${report.summary.monotonic}`);
    if (!report.summary.monotonic) {
      lines.push(`  islands — rows: ${report.summary.rowsWithMultipleTransitions}, cols: ${report.summary.colsWithMultipleTransitions}`);
    }
  } else {
    lines.push(`  ${report.summary.note}`);
  }
  return lines.join('\n');
}

// --- LABEL-PERMUTATION NULL TESTS ----------------------------------------------------------
// A capability, not an audit: this is not being run against any scenario's own validity here.
// It exists because of what a permutation test found elsewhere today (opus2, LAB SENS-1,
// ledger/handoffs/opus2/20260905T180216Z-sensitivity-axis-measured.md): a published sensitivity
// estimator's 24 values were indistinguishable from a null built by pooling each geometry's
// trials, dealing them back into the same 21 delay-bins at the same cell sizes AT RANDOM, and
// recomputing the estimator 400 times — 0 of 24 geometries cleared the 95th percentile of their
// own null. That technique answers a question sample size alone cannot: is this statistic
// responding to the thing it claims to measure, or would it look the same on scrambled input.
//
// runScenarioNullTest ports the TECHNIQUE, not a conclusion:
//   1. Run the real grid once (runScenarioGrid) — same trials, same cell sizes as any other
//      grid call, nothing invented.
//   2. Pool every real cell's own extracted value into one flat list, then deal it back into
//      the SAME nx x ny shape, at random. This is the entire operation: it destroys which
//      (xValue, yValue) label a result belongs to, without touching a single value the real
//      physics produced. Regenerating trials with new random parameters would test a
//      different question (whether the effect replicates), not this one (whether the labels
//      matter at all) — so this never re-runs a scenario, it only re-deals already-measured
//      numbers.
//   3. Recompute the caller's own `statistic(matrix)` on both the real matrix and on
//      `iterations` shuffled-label matrices, building a null distribution.
//   4. Report where the observed statistic sits WITHIN that null as a percentile — never a
//      pass/fail verdict, since the percentile is the number a person actually reasons about
//      and a verdict line would throw it away.
// The shuffle is seeded (mulberry32, a small deterministic PRNG — no crypto or platform RNG
// needed for a reproducibility guarantee, not a security one) so the same scenario + seed
// reports the same null twice.

/** Deterministic PRNG (mulberry32) — same seed, same sequence, forever, on any JS engine. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, in place, driven by `rng` (a `() => [0,1)` generator) — the only shuffle used
 * anywhere in this module, so every null draw goes through one, tested, code path. */
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

/**
 * Runs `name`'s real xValues x yValues grid once, then reports where `statistic(matrix)`
 * (applied to the real, labeled matrix) sits inside the null distribution built by shuffling
 * WHICH CELL each real value landed in — never regenerating a single trial.
 *
 * `extract(report) => number` is required (unlike runScenarioGrid, which tolerates booleans
 * and full reports) — a null test needs a numeric matrix to pool and reshuffle.
 * `statistic(matrix) => number` receives an nx-by-ny array of arrays (real on the first call,
 * a label-shuffled deal of the SAME values on every null draw) and must reduce it to one
 * number — e.g. the spread across row means, an OLS slope, a group-mean difference; the
 * caller's choice, exactly as ramps.js's own estimator choice was the caller's choice in the
 * LAB finding this ports.
 *
 * A cell that failed to run, or an extract()/statistic() that didn't return a finite number,
 * throws rather than silently dropping a cell or coercing a bad value into the pool — the same
 * "a hole must show as a hole" principle as runScenarioGrid, applied to data a null test is
 * about to treat as real.
 *
 * Returns `{ name, xPath, xValues, yPath, yValues, seed, iterations, observed, percentile,
 * nullMin, nullMax, nullMean }`. `percentile` is where `observed` sits within its own null
 * (0-100, fraction of null draws at or below it) — the number to reason about; this function
 * makes no pass/fail claim of its own.
 */
export function runScenarioNullTest(name, { xPath, xValues, yPath, yValues, overrides = {}, extract, statistic, iterations = 1000, seed = 1 } = {}) {
  if (typeof extract !== 'function') throw new Error('runScenarioNullTest: extract(report) => number is required');
  if (typeof statistic !== 'function') throw new Error('runScenarioNullTest: statistic(matrix) => number is required');
  if (!Number.isInteger(iterations) || iterations <= 0) throw new Error('runScenarioNullTest: iterations must be a positive integer');

  const real = runScenarioGrid(name, { xPath, xValues, yPath, yValues, overrides, extract });
  const nx = xValues.length;
  const ny = yValues.length;
  const matrix = [];
  const pooled = [];
  for (let i = 0; i < nx; i++) {
    const row = [];
    for (let j = 0; j < ny; j++) {
      const cell = real.cells[i][j];
      if (!cell.ok) {
        throw new Error(`runScenarioNullTest: cell [${i}][${j}] (${xPath}=${xValues[i]}, ${yPath}=${yValues[j]}) failed to run (${cell.error}) — a null test needs every real cell to have run, no holes.`);
      }
      if (typeof cell.value !== 'number' || !Number.isFinite(cell.value)) {
        throw new Error(`runScenarioNullTest: extract() must return a finite number per cell — got ${JSON.stringify(cell.value)} at [${i}][${j}]`);
      }
      row.push(cell.value);
      pooled.push(cell.value);
    }
    matrix.push(row);
  }

  const observed = statistic(matrix);
  if (typeof observed !== 'number' || !Number.isFinite(observed)) {
    throw new Error(`runScenarioNullTest: statistic() must return a finite number — got ${JSON.stringify(observed)} on the real matrix`);
  }

  const rng = mulberry32(seed);
  const nullDistribution = new Array(iterations);
  for (let k = 0; k < iterations; k++) {
    // Pool -> shuffle -> deal back at the SAME nx x ny cell sizes. This line is the entire
    // technique: every value in `shuffled` is a real, already-measured number; only which
    // (i, j) cell it lands in this draw is randomised.
    const shuffled = pooled.slice();
    shuffleInPlace(shuffled, rng);
    const shuffledMatrix = [];
    let idx = 0;
    for (let i = 0; i < nx; i++) {
      const row = [];
      for (let j = 0; j < ny; j++) row.push(shuffled[idx++]);
      shuffledMatrix.push(row);
    }
    const v = statistic(shuffledMatrix);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`runScenarioNullTest: statistic() must return a finite number on every null draw — got ${JSON.stringify(v)} on draw ${k}`);
    }
    nullDistribution[k] = v;
  }

  let countAtOrBelow = 0;
  for (const v of nullDistribution) if (v <= observed) countAtOrBelow += 1;
  const percentile = (countAtOrBelow / iterations) * 100;

  return {
    name, xPath, xValues, yPath, yValues, seed, iterations,
    observed,
    percentile,
    nullMin: Math.min(...nullDistribution),
    nullMax: Math.max(...nullDistribution),
    nullMean: nullDistribution.reduce((s, v) => s + v, 0) / iterations,
  };
}

/** Formats a runScenarioNullTest report as short, human-readable lines — the percentile front
 * and centre, never a pass/fail line (see the module doc comment on why). */
export function formatNullTest(report) {
  return [
    `null test: ${report.name} (${report.xPath} x ${report.yPath}, seed=${report.seed}, ${report.iterations} shuffles)`,
    `  observed statistic: ${report.observed}`,
    `  sits at percentile ${report.percentile.toFixed(1)} of its own null (range ${report.nullMin.toFixed(4)}..${report.nullMax.toFixed(4)}, mean ${report.nullMean.toFixed(4)})`,
  ].join('\n');
}
