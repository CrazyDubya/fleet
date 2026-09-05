// Settles, by measurement, whether THE ORBIT's exit (ORBIT_EXIT_FEED) actually reaches the
// right flipper — its own doc comment (table/ramps.js) already flagged this as unverified: "a
// verified-safe landing spot near the right flipper, not a measured guarantee of contact." This
// closes that gap the same way the slide/monkeyBars re-aim dispatch did: an 81-sample sweep
// around the real, deterministic exit point — position ±3mm (perpendicular to the exit
// direction), direction ±4°, speed ±0.15 m/s, crossed with the three flipper states a real
// player's timing can produce (rest/active/flip-at-arrival) — 3×3×3×3 = 81, matching the exact
// methodology ramps.js's own doc comments record for THE SLIDE ("mid-bat in 27 of 81 samples
// ... mid-bat in 66 of the same 81 samples, contact in 81/81") and MONKEY BARS ("contact in
// 81/81 samples ... mid-bat in all 81").
//
// Geometry is measured here, not assumed and not changed unless the sweep says it must be —
// same discipline as mechanism-handoffs.test.mjs: report first, re-aim only if it misses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, setLayerZones, addBall, addFlipper, advance } from '../src/physics/world.js';
import { createFlipper } from '../src/physics/flipper.js';
import { BALL_RADIUS, STEP_DT } from '../src/physics/constants.js';
import { normalize, scale, rotate, perp } from '../src/physics/vec2.js';
import * as recess from '../src/table/recess.js';
import * as assemble from '../src/table/assemble.js';
import * as ramps from '../src/table/ramps.js';

const DEG = Math.PI / 180;
const DURATION_S = 1.5;

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

/** One trial: does a ball at `pos`/`vel` contact `flipperName`'s own capsule within
 * DURATION_S, with that flipper held at `angleRad` (or naturally flipping mid-flight if
 * `angleRad === 'flip-at-arrival'`, matching mechanism-handoffs.test.mjs's own convention)?
 * Also reports the along-bat fraction (0=pivot, 1=tip; negative = a graze on the round hub,
 * not a real hit) of the FIRST contact, the same distinction ramps.js's own "mid-bat" figures
 * are built from. */
function trial({ pos, vel, flipperName, angleRad }) {
  const { world, flippers } = buildFullWorld();
  const target = flippers[flipperName];
  if (angleRad === 'flip-at-arrival') { target.angle = target.restAngle; target.angularVel = 0; target.active = true; }
  else { target.angle = angleRad; target.angularVel = 0; target.active = false; }
  const ball = addBall(world, { id: 't', pos: { x: pos.x, y: pos.y }, vel: { x: vel.x, y: vel.y }, radius: BALL_RADIUS });
  for (let i = 0; i < Math.round(DURATION_S / STEP_DT); i++) {
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

/** The 81-sample sweep: ±3mm position (perpendicular to the exit direction), ±4° direction,
 * ±0.15 m/s speed, × 3 flipper states. Returns { total, contact, midBat } — `contact` counts
 * any real hit; `midBat` counts hits landing on the bat body itself (alongBat in [0,1]), the
 * distinction ramps.js's own doc comments make ("contact in 81/81, mid-bat in 66"). */
function sweep81({ pos, dir, speed, flipperName, restDeg, activeDeg }) {
  const posOffsets = [-0.003, 0, 0.003];
  const angleOffsetsDeg = [-4, 0, 4];
  const speedOffsets = [-0.15, 0, 0.15];
  const flipperStates = [restDeg * DEG, activeDeg * DEG, 'flip-at-arrival'];
  const side = perp(dir);

  let total = 0, contact = 0, midBat = 0;
  for (const dp of posOffsets) {
    const p = { x: pos.x + side.x * dp, y: pos.y + side.y * dp };
    for (const da of angleOffsetsDeg) {
      const d = rotate(dir, da * DEG);
      for (const ds of speedOffsets) {
        const v = scale(d, speed + ds);
        for (const angleRad of flipperStates) {
          total += 1;
          const r = trial({ pos: p, vel: v, flipperName, angleRad });
          if (r.hit) {
            contact += 1;
            if (r.alongBat >= 0 && r.alongBat <= 1) midBat += 1;
          }
        }
      }
    }
  }
  return { total, contact, midBat };
}

test('THE ORBIT exit (ORBIT_EXIT_FEED) reachability sweep toward the right flipper, 81 samples, pasted for the record', () => {
  const orbit = ramps.buildOrbitRamp();
  const result = sweep81({
    pos: orbit.ramp.exit.pos,
    dir: orbit.ramp.exit.dir,
    speed: orbit.ramp.exit.speed,
    flipperName: 'right',
    // Mirrors main.js's own right-flipper rest/active angles (180 - the left flipper's own
    // -50/32, since the right flipper is the left flipper's mirror image).
    restDeg: 180 - -50,
    activeDeg: 180 - 32,
  });
  console.log(`\n=== THE ORBIT -> right flipper: ${result.contact}/${result.total} contact, ${result.midBat}/${result.total} mid-bat ===`);
  console.log(`ORBIT_EXIT_FEED = (${orbit.ramp.exit.pos.x}, ${orbit.ramp.exit.pos.y}), dir = (${orbit.ramp.exit.dir.x.toFixed(4)}, ${orbit.ramp.exit.dir.y.toFixed(4)}), speed = ${orbit.ramp.exit.speed}`);

  // The actual gate: at minimum, SOME real contact across the swept conditions — this is what
  // "a real exit that connects back to the playfield where a player would expect" requires, per
  // the dispatch that flagged this as unverified. A pure miss here (0/81) means the exit needs
  // re-aiming, the same as slide/monkeyBars did.
  assert.ok(result.contact > 0, `THE ORBIT's exit missed the right flipper in all ${result.total} sampled conditions — needs re-aiming, same as slide/monkeyBars did`);
});
