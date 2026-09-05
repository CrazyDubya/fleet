// Settles, by measurement, whether the upperLeft flipper is REACHABLE — wired correctly
// (builder-overrides.test.mjs covers config values) is not the same claim as "a ball can
// actually get there." Per the user's suspicion (a "legacy flipper," thematically present but
// functionally useless) and the operator's instruction: work out what feeds that region from
// the table geometry rather than assuming — do NOT adjust geometry to rescue a bad number.
//
// REVISED after a correction the operator worked out from the geometry directly (not by
// re-running this file): the first version of this test gated on a jittered corridor swept
// AROUND the monkey bars ramp's documented exit and read 384/720 as "reachable." That number
// is real, but it isn't the right headline. `physics/ramp.js` documents the ramp exit as "a
// single deterministic hand-off" — there is NO variance in the running game; every ball that
// completes the monkey bars ramp re-enters at EXACTLY `UPPER_LEFT_FLIPPER_FEED`, direction
// `normalize({x:-0.3,y:-1})`, speed 1.4 — one point, not a distribution. And that one point,
// checked directly (traced below and confirmed algebraically by the operator): the ball travels
// LEFT and DOWN from a feed point already left of the pivot, so it recedes from the flipper's
// arm (which extends RIGHT from the pivot) instead of approaching it, and only crosses back
// near the pivot's x-coordinate after falling well below the flipper's y-range. It misses at
// every flipper state (rest/mid-swing/active/flip-at-arrival) — permanently, not as an artifact
// of testing one exact point (the RIGHT control's dead-centre miss doesn't rescue this reading
// either — that corridor was invented, not a real documented feed, so its own dead-centre miss
// carries no information about a real hand-off).
//
// So the honest split is two different questions, kept separate below:
// 1. Is upperLeft reachable via the ONE trajectory the monkey bars ramp can actually produce?
//    NO — confirmed, reported as `exactRampExit` below, NOT the pass/fail gate (asserting on a
//    single already-known-permanent miss would just commit a red test; the operator's ruling
//    was "report it, don't fix it").
// 2. Is upperLeft reachable AT ALL, from a ball loose in its region via general play (a
//    rebound, a bumper kick, a failed ramp entry) — independent of this one ramp's aim? THIS is
//    what `generalPlayResult` below measures, and it is the number this test's assertion gates
//    on: something the real game can actually produce, so a future geometry change that
//    silently strands the flipper from ALL of general play (not just this one ramp) fails here.
//
// What feeds the region, read from src/table/ramps.js rather than guessed: buildMonkeyBarsRamp's
// own doc comment says it "drops to the UPPER-LEFT FLIPPER at (-0.130, 0.560)" and its `exit` is
// exactly `UPPER_LEFT_FLIPPER_FEED`, 4.3cm from the pivot — the only mechanism exit anywhere
// near it (buildSlideRamp exits near LEFT, buildTunnelRamp near the spring riders, buildSandbox
// ejects toward the LOWER-left flipper, 46cm away). The `sweepCorridor` jittered-grid function
// below is KEPT as a diagnostic (it is informative about how close a differently-aimed exit
// would come — see the handoff for the angle-offset breakdown) but is explicitly NOT what the
// test gates on, for the reason above.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, setLayerZones, addBall, addFlipper, advance } from '../src/physics/world.js';
import { createFlipper } from '../src/physics/flipper.js';
import { BALL_RADIUS, STEP_DT } from '../src/physics/constants.js';
import { rotate, scale, normalize } from '../src/physics/vec2.js';
import * as recess from '../src/table/recess.js';
import * as assemble from '../src/table/assemble.js';
import * as ramps from '../src/table/ramps.js';

const DEG = Math.PI / 180;

/** Builds the real, fully-assembled table (every wall/mechanism collider, all three flippers)
 * exactly as main.js does, via the shared assemble.js module — not a hand-picked subset. */
function buildFullWorld() {
  const world = createWorld();
  const table = assemble.buildTable();
  setLayerPrimitives(world, 'playfield', table.primitives);
  setLayerZones(world, 'playfield', table.zones);
  const flippers = {};
  for (const cfg of recess.buildFlipperConfigs()) {
    const f = createFlipper(cfg);
    addFlipper(world, f);
    flippers[cfg.name] = f;
  }
  return { world, flippers, walls: table.wallSegments };
}

/** One grid trial: places a ball at `pos` with velocity `vel`, puts `targetFlipperName`'s
 * flipper into `flipperState` (a held static angle, or a flip triggered at the instant the
 * ball spawns — covering "the flipper was already down," "already up," "mid-swing," and "the
 * player flips right as the ball arrives," since a static-angle sweep plus a triggered-flip
 * case dominates the space a real player's timing could land in), then simulates for
 * `durationS` and reports whether any collision event's primitive belongs to that flipper.
 *
 * Correction (2026-09-05, an outside review's suspicion, confirmed by direct measurement — see
 * mechanism-handoffs.test.mjs's towardFlipper, which shares this exact setup): "the player
 * flips right as the ball arrives" is the INTENT this state was named for, but it is not what
 * it measures. `active = true` at spawn means the flip (upMs=14ms, ~3.4 physics steps) is
 * essentially always complete — `target.angularVel` already 0 — before the ball's own travel
 * time to the flipper on this table's real distances. What this state actually exercises is "the
 * flipper was already fully active for the whole trial," the same claim the separate `active`
 * static-angle case already covers, not a genuine mid-swing catch. Left in place (removing it
 * would lose real trial coverage, and it is not WRONG, just not distinct from `active` here) —
 * documented accurately rather than left implying it tests something it doesn't. */
function trialContactsFlipper({ world, flippers, targetFlipperName, pos, vel, flipperState, durationS = 0.7 }) {
  const target = flippers[targetFlipperName];
  if (flipperState === 'flip-at-arrival') {
    target.angle = target.restAngle;
    target.angularVel = 0;
    target.active = true; // in practice always resolves before contact — see this function's own doc comment
  } else {
    target.angle = flipperState; // a held static angle (radians)
    target.angularVel = 0;
    target.active = false;
  }
  const ball = addBall(world, { id: 't', pos: { x: pos.x, y: pos.y }, vel: { x: vel.x, y: vel.y }, radius: BALL_RADIUS });

  let contacted = false;
  const steps = Math.round(durationS / STEP_DT);
  for (let i = 0; i < steps && !contacted; i++) {
    const events = advance(world, STEP_DT);
    for (const e of events) {
      if (e.primitive?.flipper?.tag === target.tag) { contacted = true; break; }
    }
    if (recess.isDrained(ball)) break;
  }
  world.balls = world.balls.filter((b) => b.id !== 't');
  return contacted;
}

/** Builds the position x direction x speed x flipper-state grid around one seed entry
 * condition and returns { fraction, total, contacted, byState, byAngleOffset, bySpeedFraction,
 * exactSeed } — byState/byAngleOffset/bySpeedFraction say WHICH entry conditions do it;
 * exactSeed is the single dead-centre point (0 position offset, 0 angle offset, 1.0x speed) at
 * each flipper state — the ONE condition the real deterministic ramp/injection model in this
 * codebase can ever actually produce (physics/ramp.js: "the deterministic exit hand-off" — no
 * natural variance exists in this model), reported separately because it is not the same claim
 * as the grid fraction (see the test body for why both numbers are needed). */
function sweepCorridor({ targetFlipperName, seedPos, seedDir, seedSpeed, restAngleDeg, activeAngleDeg }) {
  const positionOffsets = [-0.01, 0, 0.01];
  const angleOffsetsDeg = [-15, -7.5, 0, 7.5, 15];
  const speedFractions = [0.6, 0.8, 1.0, 1.2];
  const restRad = restAngleDeg * DEG, activeRad = activeAngleDeg * DEG;
  const flipperStates = [restRad, restRad + (activeRad - restRad) * 0.5, activeRad, 'flip-at-arrival'];
  const stateLabels = ['rest', 'mid-swing', 'active', 'flip-at-arrival'];

  let total = 0, contactedCount = 0;
  const byState = Object.fromEntries(stateLabels.map((l) => [l, { total: 0, contacted: 0 }]));
  const byAngleOffset = Object.fromEntries(angleOffsetsDeg.map((a) => [a, { total: 0, contacted: 0 }]));
  const bySpeedFraction = Object.fromEntries(speedFractions.map((s) => [s, { total: 0, contacted: 0 }]));
  const exactSeed = Object.fromEntries(stateLabels.map((l) => [l, null]));

  for (const dx of positionOffsets) {
    for (const dy of positionOffsets) {
      const pos = { x: seedPos.x + dx, y: seedPos.y + dy };
      for (const dAngDeg of angleOffsetsDeg) {
        const dir = rotate(seedDir, dAngDeg * DEG);
        for (const speedFrac of speedFractions) {
          const vel = scale(dir, seedSpeed * speedFrac);
          for (let si = 0; si < flipperStates.length; si++) {
            const { world, flippers } = buildFullWorld();
            const contacted = trialContactsFlipper({
              world, flippers, targetFlipperName, pos, vel, flipperState: flipperStates[si],
            });
            total += 1;
            byState[stateLabels[si]].total += 1;
            byAngleOffset[dAngDeg].total += 1;
            bySpeedFraction[speedFrac].total += 1;
            if (contacted) {
              contactedCount += 1;
              byState[stateLabels[si]].contacted += 1;
              byAngleOffset[dAngDeg].contacted += 1;
              bySpeedFraction[speedFrac].contacted += 1;
            }
            if (dx === 0 && dy === 0 && dAngDeg === 0 && speedFrac === 1.0) {
              exactSeed[stateLabels[si]] = contacted;
            }
          }
        }
      }
    }
  }
  return { total, contacted: contactedCount, fraction: contactedCount / total, byState, byAngleOffset, bySpeedFraction, exactSeed };
}

/** Is `targetFlipperName` reachable AT ALL from a ball loose somewhere in its region — a
 * rebound, a bumper kick, a failed ramp entry — independent of any one specific feed's exact
 * aim? Sweeps a broad grid of STARTING positions across the region (not anchored to any single
 * documented vector) x compass directions x modest "just came loose" speeds x flipper states,
 * for a longer window so gravity has time to carry the ball through the region. This is a fair
 * proxy for "does the mechanism's own geometry ever catch a stray ball here," which is what
 * "reachable via general play" actually means — real loose-ball momentum has no preferred
 * direction, unlike a specific ramp's aimed exit. */
function generalPlaySweep({ targetFlipperName, xs, ys, durationS = 2.5 }) {
  const compassDeg = [0, 45, 90, 135, 180, 225, 270, 315];
  const speeds = [0.3, 0.8]; // m/s — a just-loose ball, not a targeted shot
  const restRad = -25 * DEG, activeRad = 35 * DEG;
  const states = [restRad, activeRad, 'flip-at-arrival'];
  const stateLabels = ['rest', 'active', 'flip-at-arrival'];
  const margin = BALL_RADIUS + 0.008;

  const { walls } = buildFullWorld();
  function tooClose(x, y) {
    for (const seg of walls) {
      const abx = seg.b.x - seg.a.x, aby = seg.b.y - seg.a.y;
      const len2 = abx * abx + aby * aby || 1;
      let t = ((x - seg.a.x) * abx + (y - seg.a.y) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = seg.a.x + t * abx, py = seg.a.y + t * aby;
      if (Math.hypot(x - px, y - py) < margin) return true;
    }
    return false;
  }

  let total = 0, contactedCount = 0;
  const byPosition = [];
  for (const x of xs) {
    for (const y of ys) {
      if (tooClose(x, y)) continue;
      let posTotal = 0, posContacted = 0;
      for (const deg of compassDeg) {
        const rad = deg * DEG;
        for (const speed of speeds) {
          const vel = { x: Math.cos(rad) * speed, y: Math.sin(rad) * speed };
          for (let si = 0; si < states.length; si++) {
            const { world, flippers } = buildFullWorld();
            const contacted = trialContactsFlipper({
              world, flippers, targetFlipperName, pos: { x, y }, vel, flipperState: states[si], durationS,
            });
            total += 1; posTotal += 1;
            if (contacted) { contactedCount += 1; posContacted += 1; }
          }
        }
      }
      byPosition.push({ x, y, total: posTotal, contacted: posContacted });
    }
  }
  return { total, contacted: contactedCount, fraction: contactedCount / total, byPosition };
}

// --- upperLeft: corridor anchored on the monkey bars ramp's own documented exit ---
const monkeyBars = ramps.buildMonkeyBarsRamp();
const upperLeftResult = sweepCorridor({
  targetFlipperName: 'upperLeft',
  seedPos: monkeyBars.ramp.exit.pos,
  seedDir: monkeyBars.ramp.exit.dir,
  seedSpeed: monkeyBars.ramp.exit.speed,
  restAngleDeg: -25, activeAngleDeg: 35, // FLIPPER.upper, read from src/physics/constants.js
});

// --- LEFT control: corridor anchored on the slide ramp's own documented exit ---
const slide = ramps.buildSlideRamp();
const leftResult = sweepCorridor({
  targetFlipperName: 'left',
  seedPos: slide.ramp.exit.pos,
  seedDir: slide.ramp.exit.dir,
  seedSpeed: slide.ramp.exit.speed,
  restAngleDeg: -50, activeAngleDeg: 32, // FLIPPER.lower
});

// --- RIGHT control: no documented ramp/mechanism feed exists anywhere in the table geometry
// (grepped table/ramps.js and table/mechanisms.js for "right flipper"/"RIGHT_INLANE" — nothing).
// Corridor built generically instead: a plausible gravity-driven arrival band directly above
// the pivot, mirroring what a ball falling back down the right side of the playfield (a failed
// tunnel-orbit attempt, a pop-bumper/slingshot deflection) would look like — reported as
// generic, not invented as a fake documented feed.
const rightResult = sweepCorridor({
  targetFlipperName: 'right',
  seedPos: { x: recess.RIGHT_FLIPPER_PIVOT.x + 0.03, y: recess.RIGHT_FLIPPER_PIVOT.y + 0.12 },
  seedDir: normalize({ x: -0.3, y: -1 }),
  seedSpeed: 1.4,
  restAngleDeg: 180 - -50, activeAngleDeg: 180 - 32, // FLIPPER.lower, mirrored (recess.js's own convention)
});

// --- general play: is upperLeft reachable at all, independent of the (confirmed-missing)
// monkey bars aim? Broad region covering plausible loose-ball territory around the flipper. ---
const generalPlayResult = generalPlaySweep({
  targetFlipperName: 'upperLeft',
  xs: [-0.22, -0.17, -0.12, -0.07, -0.02],
  ys: [0.35, 0.45, 0.55, 0.65, 0.75],
});

test('reachability, pasted for the record — the documented ramp exit corridor (diagnostic only) and general-play reachability (the gate)', () => {
  console.log('\n=== upperLeft: DIAGNOSTIC — jittered corridor around the monkey bars ramp exit (not the gate; see file header) ===');
  console.log(`contact fraction: ${upperLeftResult.contacted}/${upperLeftResult.total} = ${(upperLeftResult.fraction * 100).toFixed(2)}%`);
  console.log('by angle offset from documented exit dir (deg):', JSON.stringify(upperLeftResult.byAngleOffset));
  console.log('EXACT documented exit (the ONLY point the real game can produce via this ramp), per state:', JSON.stringify(upperLeftResult.exactSeed));

  console.log('\n=== upperLeft: GENERAL PLAY reachability (this IS the gate) ===');
  console.log(`contact fraction: ${generalPlayResult.contacted}/${generalPlayResult.total} = ${(generalPlayResult.fraction * 100).toFixed(2)}%`);
  console.log('by starting position (every position tested, contacted/total):');
  for (const p of generalPlayResult.byPosition) console.log(`  (${p.x}, ${p.y}): ${p.contacted}/${p.total}`);

  console.log('\n=== LEFT / RIGHT controls (documented-exit-corridor diagnostic only, unchanged from the first pass) ===');
  console.log(`LEFT:  ${leftResult.contacted}/${leftResult.total} = ${(leftResult.fraction * 100).toFixed(2)}%, EXACT exit per state: ${JSON.stringify(leftResult.exactSeed)}`);
  console.log(`RIGHT: ${rightResult.contacted}/${rightResult.total} = ${(rightResult.fraction * 100).toFixed(2)}%, EXACT seed per state: ${JSON.stringify(rightResult.exactSeed)}`);

  // The gate: general-play reachability, NOT the ramp-corridor sweep above. The ramp corridor
  // can (and does) stay green even though the real deterministic ramp exit never connects —
  // that was this test's original mistake. General play is something the real game actually
  // produces (a rebound, a bumper kick, a failed ramp entry landing loose nearby), so a future
  // geometry change that strands the flipper from ALL of general play — not just this one
  // ramp's current aim — fails here.
  assert.ok(generalPlayResult.contacted > 0,
    `upperLeft is UNREACHABLE from general play — ${generalPlayResult.contacted}/${generalPlayResult.total} ` +
    `contacts across a broad loose-ball sweep of its region. Do not adjust geometry to pass this test; a ` +
    `future change that strands it should fail here and be reported, not routed around.`);
});
