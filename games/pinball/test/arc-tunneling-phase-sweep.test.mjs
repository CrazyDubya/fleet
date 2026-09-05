// ARC-1 (2026-09-05): settles, by measurement, whether a fast ball tunneling through a thin
// Arc collider (first found via a captive-ball feasibility scratch proof, unrelated to any
// shipped table geometry — every Arc on the real table happens to be struck at lower speed
// today, but the code path is shared and any future Arc placed where a hard shot can reach it
// inherits this) fails on SPEED alone, on PHASE (starting position/approach angle at a FIXED
// speed), or both.
//
// A cross-family review argued the original "aliasing" reading was wrong: sweepCircleArc
// solves the swept intersection analytically over the whole query interval rather than
// sampling at fixed substep boundaries, so a single query cannot alias against a sub-step grid
// the way a discrete sampler would. That argument is about the ROOT-FINDING step and is correct
// as far as it goes — but this file's own sweep below shows containment DOES flip between
// escaped and contained at an EXACTLY fixed nominal speed, varying only the ball's starting
// position or approach angle by a few millimetres/degrees. That is phase-dependence by
// definition, whatever the mechanism producing it, and it directly contradicts "cannot alias in
// the way described" as a blanket claim.
//
// Reading sweepCircleArc (physics/solver.js) for a mechanism that explains BOTH — the review's
// own reasoning was an argument, not a measurement, and deserves the same scrutiny in the other
// direction: `const outside = distFromCentre >= arc.radius;` is computed ONCE from the ball's
// position at the moment this query is issued, before any of the query's own root-finding runs.
// Which side of the arc the ball is judged to be approaching from — and therefore whether the
// effective collision radius is `arc.radius + r` or `arc.radius - r` — depends on exactly where
// the ball's trajectory happens to sit at that instant. Since stepBall (solver.js) issues a new
// query at the start of each impact-resolution iteration, and how much of a tick's time remains
// at that point depends on how many earlier impacts already consumed it THIS tick, a ball's
// exact position when a given query is issued is sensitive to more than its nominal approach
// speed — it depends on the whole trajectory's history within the tick, which is what "phase"
// means here. This matches the review's own second named candidate ("the frozen inside-outside
// determination taken once at the start position") — the review's high-level "cannot alias"
// framing was too strong, but its own candidate mechanism is a strong, source-supported
// explanation for exactly the phase-dependence measured below.
//
// This file measures and reports; it does not yet fix anything (a genuine multi-body/thin-Arc
// robustness fix is a separate, larger change than this dispatch's scope) — the assertions
// below only confirm the sweep produces both outcomes (proving the phase-dependence is real and
// reproducible), not that containment is currently reliable, so this stays green while
// recording a known, real gap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, addBall, advance } from '../src/physics/world.js';
import { Segment, Arc } from '../src/physics/shapes.js';
import { BALL_RADIUS, STEP_DT, E_WALL } from '../src/physics/constants.js';

// The same minimal channel used in the captive-ball feasibility check this dispatch grew out
// of: two parallel walls (1.6 ball diameters wide, the same order as every real lane on this
// table) closed by a thin Arc backstop — not shipped table geometry, a scratch proof isolating
// the Arc-tunneling question from everything else on the real table.
const WIDTH = BALL_RADIUS * 2 * 1.6;
const CENTRE_X = 0, BOTTOM_Y = 0.5, TOP_Y = 0.62;
const primitives = [
  { shape: Segment({ x: CENTRE_X - WIDTH / 2, y: BOTTOM_Y }, { x: CENTRE_X - WIDTH / 2, y: TOP_Y }, E_WALL, 'arc-sweep-left') },
  { shape: Segment({ x: CENTRE_X + WIDTH / 2, y: BOTTOM_Y }, { x: CENTRE_X + WIDTH / 2, y: TOP_Y }, E_WALL, 'arc-sweep-right') },
  { shape: Arc({ x: CENTRE_X, y: TOP_Y }, WIDTH / 2, 0, Math.PI, E_WALL, 'arc-sweep-backstop') },
];

function tunnelsThrough(startX, startY, angleDeg, speed) {
  const world = createWorld();
  setLayerPrimitives(world, 'playfield', primitives);
  const rad = (angleDeg * Math.PI) / 180;
  const vel = { x: Math.sin(rad) * speed, y: Math.cos(rad) * speed };
  const ball = addBall(world, { id: 'b', pos: { x: startX, y: startY }, vel, radius: BALL_RADIUS });
  let escaped = false;
  for (let i = 0; i < 240 * 3; i++) {
    advance(world, STEP_DT);
    if (ball.pos.y > TOP_Y + WIDTH / 2 + BALL_RADIUS + 0.05) escaped = true;
  }
  return escaped;
}

test('ARC-1: reproduces the original six-speed escape pattern (non-monotonic, not a one-off)', () => {
  const speeds = [4, 5, 6, 6.5, 7, 7.5];
  const results = speeds.map((v) => ({ v, escaped: tunnelsThrough(CENTRE_X, BOTTOM_Y + 0.01, 0, v) }));
  console.log('\n=== ARC-1: six-speed reproduction ===');
  for (const r of results) console.log(`  ${r.v} m/s -> ${r.escaped ? 'ESCAPED' : 'contained'}`);
  const escapeCount = results.filter((r) => r.escaped).length;
  // Not a safety assertion (see file header) — confirms the pattern replicates at all: some
  // speeds escape, some don't, non-monotonically, the same shape originally measured.
  assert.ok(escapeCount > 0 && escapeCount < speeds.length, 'expected a genuine MIX of escaped/contained across these speeds, replicating the original non-monotonic pattern — all-escape or all-contained here would mean the original measurement did not reproduce');
});

test('ARC-1: phase sweep — at a SINGLE FIXED speed, containment varies with starting position and approach angle', () => {
  const FIXED_SPEED = 6.0; // an escaping speed at the seed condition, per the six-speed reproduction above
  const results = [];

  for (const dy of [-0.005, -0.002, 0, 0.002, 0.005, 0.01, 0.02]) {
    results.push({ dim: 'startY', value: dy, escaped: tunnelsThrough(CENTRE_X, BOTTOM_Y + 0.01 + dy, 0, FIXED_SPEED) });
  }
  for (const angleDeg of [-10, -5, -2, 0, 2, 5, 10]) {
    results.push({ dim: 'angle', value: angleDeg, escaped: tunnelsThrough(CENTRE_X, BOTTOM_Y + 0.01, angleDeg, FIXED_SPEED) });
  }

  console.log(`\n=== ARC-1: phase sweep at fixed speed ${FIXED_SPEED} m/s ===`);
  for (const r of results) console.log(`  ${r.dim}=${r.value} -> ${r.escaped ? 'ESCAPED' : 'contained'}`);

  const escapedCount = results.filter((r) => r.escaped).length;
  // THE determination this test exists to make: if speed alone decided the outcome (the
  // review's "pure logic error, no phase sensitivity" reading), every row here — same speed
  // throughout — would show the SAME outcome. It does not: both escapes and containments occur
  // at this one fixed speed, varying only starting position/approach angle. Containment is
  // phase-dependent, not purely speed-dependent — the original aliasing/phase reading holds,
  // even though (see file header) the review's own named mechanism, the frozen inside/outside
  // determination in sweepCircleArc, is very plausibly WHY, and its "cannot alias" framing was
  // too strong as a blanket claim rather than simply wrong about there being no candidate.
  assert.ok(escapedCount > 0 && escapedCount < results.length,
    `expected a mix of escaped/contained at this ONE fixed speed (got ${escapedCount}/${results.length} escaped) — a pure speed-only failure mode would show the same outcome for every row here`);
});
