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
