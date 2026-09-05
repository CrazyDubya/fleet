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
import { createWorld, setLayerPrimitives, addBall, advance } from '../../pinball/src/physics/world.js';
import { buildTable, wireTable } from '../../pinball/src/table/assemble.js';
import * as game from '../../pinball/src/game/mechanisms.js';
import { Segment, Arc } from '../../pinball/src/physics/shapes.js';
import { BALL_RADIUS, STEP_DT, E_WALL } from '../../pinball/src/physics/constants.js';

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
};

/** Runs a named scenario from SCENARIOS, with optional per-field overrides (e.g.
 * `runScenario('arc-containment', { ball: { speed: 4.9 } })`), and returns a plain,
 * JSON-serializable report — the same object a test asserts on and the sandbox UI prints. */
export function runScenario(name, overrides = {}) {
  const def = SCENARIOS[name];
  if (!def) throw new Error(`runScenario: unknown scenario "${name}"`);
  const runner = RUNNERS[def.kind];
  if (!runner) throw new Error(`runScenario: unknown scenario kind "${def.kind}"`);
  return runner(def, overrides);
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
  return JSON.stringify(report);
}
