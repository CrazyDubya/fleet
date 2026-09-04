// Settles, by measurement, whether the upperLeft flipper is REACHABLE — wired correctly
// (builder-overrides.test.mjs covers config values) is not the same claim as "a ball can
// actually get there." Per the user's suspicion (a "legacy flipper," thematically present but
// functionally useless) and the operator's instruction: work out what feeds that region from
// the table geometry rather than assuming, sweep the plausible entry corridor, and report the
// contact fraction — do NOT adjust geometry to rescue a bad number.
//
// What feeds it, read from src/table/ramps.js rather than guessed: buildMonkeyBarsRamp()'s own
// doc comment says it "drops to the UPPER-LEFT FLIPPER at (-0.130, 0.560)" and its `exit` is
// exactly `UPPER_LEFT_FLIPPER_FEED` — the ONE mechanism in the whole table whose exit hand-off
// is that close to upperLeft's pivot (-0.115, 0.52): 4.3cm away, well inside the flipper's own
// 6.5cm reach. No other ramp/mechanism exit lands anywhere near it (buildSlideRamp exits at
// LEFT_INLANE_FEED, buildTunnelRamp at SPRING_RIDER_FEED, buildSandbox ejects from (-0.01,0.56)
// toward the LOWER-left flipper, 46cm away — too far to be a direct hand-off).
//
// Controls, same sweep, same code path, different anchor: LEFT is fed by buildSlideRamp's own
// documented exit (the "yellow slide", per main.js's frame material) into LEFT_INLANE_FEED,
// 13.6cm from LEFT_FLIPPER_PIVOT — a real, if looser, ramp-to-flipper hand-off. RIGHT has NO
// documented ramp/mechanism feed anywhere in table/ramps.js or table/mechanisms.js (grepped for
// "right flipper"/"RIGHT_INLANE" — nothing) — real pinball's right flipper typically catches
// generic gravity-driven traffic rather than one dedicated ramp, so its corridor is built
// generically (a plausible arrival band above the pivot) and reported as such, not invented as
// a fake documented feed.
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
  return { world, flippers };
}

/** One grid trial: places a ball at `pos` with velocity `vel`, puts `targetFlipperName`'s
 * flipper into `flipperState` (a held static angle, or a flip triggered at the instant the
 * ball spawns — covering "the flipper was already down," "already up," "mid-swing," and "the
 * player flips right as the ball arrives," since a static-angle sweep plus a triggered-flip
 * case dominates the space a real player's timing could land in), then simulates for
 * `durationS` and reports whether any collision event's primitive belongs to that flipper. */
function trialContactsFlipper({ world, flippers, targetFlipperName, pos, vel, flipperState, durationS = 0.7 }) {
  const target = flippers[targetFlipperName];
  if (flipperState === 'flip-at-arrival') {
    target.angle = target.restAngle;
    target.angularVel = 0;
    target.active = true; // updateFlipper drives it toward activeAngle from here
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

test('reachability sweep, pasted for the record', () => {
  console.log('\n=== upperLeft (monkey bars ramp exit corridor) ===');
  console.log(`contact fraction: ${upperLeftResult.contacted}/${upperLeftResult.total} = ${(upperLeftResult.fraction * 100).toFixed(2)}%`);
  console.log('by flipper state at arrival:', JSON.stringify(upperLeftResult.byState));
  console.log('by angle offset from documented exit dir (deg):', JSON.stringify(upperLeftResult.byAngleOffset));
  console.log('by speed fraction of documented exit speed:', JSON.stringify(upperLeftResult.bySpeedFraction));
  console.log('EXACT documented exit (0 offset, 0 angle, 1.0x speed), per state:', JSON.stringify(upperLeftResult.exactSeed));

  console.log('\n=== LEFT control (slide ramp exit corridor) ===');
  console.log(`contact fraction: ${leftResult.contacted}/${leftResult.total} = ${(leftResult.fraction * 100).toFixed(2)}%`);
  console.log('by flipper state at arrival:', JSON.stringify(leftResult.byState));
  console.log('EXACT documented exit, per state:', JSON.stringify(leftResult.exactSeed));

  console.log('\n=== RIGHT control (generic overhead corridor — no documented feed found) ===');
  console.log(`contact fraction: ${rightResult.contacted}/${rightResult.total} = ${(rightResult.fraction * 100).toFixed(2)}%`);
  console.log('by flipper state at arrival:', JSON.stringify(rightResult.byState));
  console.log('EXACT generic seed, per state:', JSON.stringify(rightResult.exactSeed));

  // This test's job: fail loudly if a future geometry change silently strands upperLeft again.
  // It is NOT a claim about what fraction is "enough" — see the handoff for that judgment, and
  // for why the grid fraction (not the single exact-seed point above) is the right number to
  // gate on: the exact single deterministic point misses for ALL THREE flippers here, upperLeft
  // included AND both controls — it is not a distinguishing signal on its own.
  assert.ok(upperLeftResult.contacted > 0,
    `upperLeft is UNREACHABLE under this sweep — ${upperLeftResult.contacted}/${upperLeftResult.total} ` +
    `contacts from its own documented feed corridor (monkey bars ramp exit). Do not adjust geometry to pass this ` +
    `test; a future change that strands it again should fail here and be reported, not routed ` +
    `around.`);
});
