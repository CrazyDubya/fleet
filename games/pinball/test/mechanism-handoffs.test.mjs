// Systematic version of the upperLeft finding (upper-left-reachability.test.mjs): the monkey
// bars ramp declares in its own doc comment that it drops to the upper-left flipper, its exit
// constant is literally named for that flipper, and the ball it hands off travels down the
// opposite side and never touches it. Nobody noticed because nothing tested it and the flipper
// is reachable by other means. This file audits EVERY hand-off in the table the same way: from
// its own real, deterministic hand-off state (never a swept neighbourhood — that was last
// round's mistake), does the ball actually arrive at what its comment or name says it targets.
//
// Geometry is NOT changed anywhere in this dispatch. A miss is reported, not fixed — which
// pivot to move, which ramp to re-aim, or whether to leave it, is the user's call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, setLayerZones, addBall, addFlipper, advance } from '../src/physics/world.js';
import { createFlipper } from '../src/physics/flipper.js';
import { BALL_RADIUS, STEP_DT, PLUNGER_MAX_SPEED } from '../src/physics/constants.js';
import * as recess from '../src/table/recess.js';
import * as assemble from '../src/table/assemble.js';
import * as ramps from '../src/table/ramps.js';
import * as mech from '../src/table/mechanisms.js';

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

/** Simulates one deterministic hand-off toward a target FLIPPER, across the flipper states a
 * real player's timing could produce (the flipper's own state is a real independent variable
 * in play; the ball's hand-off itself is still the single real deterministic point/velocity —
 * this is not a swept neighbourhood of the hand-off, only of the receiving flipper's timing).
 *
 * A note on the third state's own name, corrected twice now (2026-09-05): an outside review
 * first suspected 'flip-at-arrival' — `active = true` set the instant the ball spawns — was
 * indistinguishable from a flipper already sitting statically active, since a scratch trace
 * showed `target.angularVel` was already 0 at the moment of first contact for SLIDE and MONKEY
 * BARS (12.5ms, comfortably past the 14ms `upMs` stroke). That measurement was real but the
 * conclusion drawn from it was wrong, caught by a second measurement: `physics/world.js`
 * subdivides into `FLIPPER_SUBSTEPS` (24) finer sub-steps internally, within ONE call to
 * `advance(world, STEP_DT)`, for every tick any flipper is moving — so the ball and the
 * SWEEPING capsule are resolved together at fine resolution during the brief stroke, and the
 * bat genuinely intercepts the ball's path at a different point than a bat that sat still at
 * either rest or active the whole time, even though the swing has JUST finished by the exact
 * instant that first contact is reported. Measured directly, comparing the actual `alongBat`
 * fraction (not just `angularVel`) between 'active' and 'flip-at-arrival' for the same feed:
 * SLIDE 0.464 vs 0.590, MONKEY BARS 0.547 vs 0.694, THE ORBIT -0.107 vs 0.457 — a real,
 * physically meaningful difference every time, not noise. This state genuinely IS a mid-swing
 * catch, exactly as its name says; the first correction was itself the bug. */
function towardFlipper(pos, vel, flipperName) {
  const restDeg = flipperName === 'left' || flipperName === 'right'
    ? (flipperName === 'left' ? -50 : 180 - -50)
    : -25;
  const activeDeg = flipperName === 'left' || flipperName === 'right'
    ? (flipperName === 'left' ? 32 : 180 - 32)
    : 35;
  const states = [{ label: 'rest', angleDeg: restDeg }, { label: 'active', angleDeg: activeDeg }, { label: 'flip-at-arrival', angleDeg: null }];
  let contacted = false, minDist = Infinity, closest = null;
  let pivot = null;
  // Per-state results. The original version stopped at the first state that made contact,
  // which hid the case a re-aim has to care about: a feed that reaches the flipper only when
  // the player already happens to be holding it up. Every state is now run and reported.
  const perState = [];
  for (const st of states) {
    const { world, flippers } = buildFullWorld();
    const target = flippers[flipperName];
    pivot = target.pivot;
    if (st.angleDeg === null) { target.angle = target.restAngle; target.angularVel = 0; target.active = true; }
    else { target.angle = st.angleDeg * DEG; target.angularVel = 0; target.active = false; }
    const ball = addBall(world, { id: 't', pos: { x: pos.x, y: pos.y }, vel: { x: vel.x, y: vel.y }, radius: BALL_RADIUS });
    let hit = false, alongBat = null;
    for (let i = 0; i < Math.round(DURATION_S / STEP_DT) && !hit; i++) {
      const prev = { x: ball.pos.x, y: ball.pos.y };
      const angleNow = target.angle;
      const events = advance(world, STEP_DT);
      for (const e of events) {
        if (e.primitive?.flipper?.tag !== target.tag) continue;
        hit = true;
        // Where the contact lands along the bat: 0 = pivot, 1 = tip. The collider is a
        // capsule of radius `flipper.radius` from pivot to tip, so a ball touching the round
        // hub at the pivot end registers a contact at a NEGATIVE fraction. That is a graze on
        // the hub, where the bat's surface speed is ~0 — it is not a hit worth having, and
        // asserting only `contacted` would not tell the two apart.
        alongBat = ((prev.x - target.pivot.x) * Math.cos(angleNow) + (prev.y - target.pivot.y) * Math.sin(angleNow)) / target.length;
      }
      const d = Math.hypot(ball.pos.x - target.pivot.x, ball.pos.y - target.pivot.y);
      if (d < minDist) { minDist = d; closest = { x: ball.pos.x, y: ball.pos.y }; }
      if (recess.isDrained(ball)) break;
    }
    perState.push({ state: st.label, hit, alongBat });
    if (hit) contacted = true;
  }
  return { contacted, minDist, closest, pivot, perState, statesHit: perState.filter((s) => s.hit).length };
}

/** Simulates one deterministic hand-off toward a CLUSTER of point targets (the spring riders —
 * three separate pop bumpers, no single point), reporting real collision events against any of
 * their tags, and the minimum edge-distance to the nearest one over the run. */
function towardPointCluster(pos, vel, targets) {
  const { world } = buildFullWorld();
  const targetTags = new Set(targets.map((t) => t.tag));
  const ball = addBall(world, { id: 't', pos: { x: pos.x, y: pos.y }, vel: { x: vel.x, y: vel.y }, radius: BALL_RADIUS });
  let contacted = false, contactedTag = null, minDist = Infinity, closest = null, nearestTag = null;
  for (let i = 0; i < Math.round(DURATION_S / STEP_DT) && !contacted; i++) {
    const events = advance(world, STEP_DT);
    for (const e of events) {
      const tag = e.primitive?.shape?.tag;
      if (tag && targetTags.has(tag)) { contacted = true; contactedTag = tag; }
    }
    for (const t of targets) {
      const d = Math.hypot(ball.pos.x - t.centre.x, ball.pos.y - t.centre.y) - t.radius;
      if (d < minDist) { minDist = d; closest = { x: ball.pos.x, y: ball.pos.y }; nearestTag = t.name; }
    }
    if (recess.isDrained(ball)) break;
  }
  return { contacted, contactedTag, minDist, closest, nearestTag };
}

function sideNote(closest, pivot, armTipX) {
  if (!closest || !pivot) return '';
  const armSide = armTipX >= pivot.x ? 'right' : 'left';
  const ballSide = closest.x >= pivot.x ? 'right' : 'left';
  const dx = Math.abs(closest.x - pivot.x);
  return ballSide === armSide
    ? `passes on the SAME side as the arm (${armSide}, ${(dx * 100).toFixed(2)}cm off pivot x) but still misses on y/timing`
    : `passes on the OPPOSITE side from the arm (arm extends ${armSide}, ball closest-approach was ${(dx * 100).toFixed(2)}cm to the ${ballSide})`;
}

test('mechanism hand-off audit, pasted for the record', () => {
  const rows = [];

  // 1. SLIDE ramp -> "the LEFT INLANE" (table/ramps.js buildSlideRamp doc comment)
  const slide = ramps.buildSlideRamp();
  {
    const r = towardFlipper(slide.ramp.exit.pos, { x: slide.ramp.exit.dir.x * slide.ramp.exit.speed, y: slide.ramp.exit.dir.y * slide.ramp.exit.speed }, 'left');
    const armTipX = recess.LEFT_FLIPPER_PIVOT.x + Math.cos(-50 * DEG) * 0.075;
    rows.push({ mechanism: 'SLIDE ramp', target: 'LEFT flipper / LEFT_INLANE_FEED', deterministic: true,
      arrives: r.contacted, closestApproachM: r.minDist, perState: r.perState, statesHit: r.statesHit,
      note: r.contacted ? '' : sideNote(r.closest, r.pivot, armTipX) });
  }

  // 2. MONKEY BARS ramp -> "the UPPER-LEFT FLIPPER" (table/ramps.js buildMonkeyBarsRamp doc comment)
  const monkeyBars = ramps.buildMonkeyBarsRamp();
  {
    const r = towardFlipper(monkeyBars.ramp.exit.pos, { x: monkeyBars.ramp.exit.dir.x * monkeyBars.ramp.exit.speed, y: monkeyBars.ramp.exit.dir.y * monkeyBars.ramp.exit.speed }, 'upperLeft');
    const armTipX = recess.UPPER_LEFT_FLIPPER_PIVOT.x + Math.cos(-25 * DEG) * 0.065;
    rows.push({ mechanism: 'MONKEY BARS ramp', target: 'upperLeft flipper / UPPER_LEFT_FLIPPER_FEED', deterministic: true,
      arrives: r.contacted, closestApproachM: r.minDist, perState: r.perState, statesHit: r.statesHit,
      note: r.contacted ? '' : sideNote(r.closest, r.pivot, armTipX) });
  }

  // 3. TUNNEL ramp -> "the spring riders" (table/mechanisms.js: "Spring riders — pop bumpers")
  const tunnel = ramps.buildTunnelRamp();
  const bumpers = mech.buildPopBumpers();
  {
    const targets = bumpers.map((b) => ({ name: b.name, tag: b.tag, centre: b.centre, radius: b.shape.radius }));
    const r = towardPointCluster(tunnel.ramp.exit.pos, { x: tunnel.ramp.exit.dir.x * tunnel.ramp.exit.speed, y: tunnel.ramp.exit.dir.y * tunnel.ramp.exit.speed }, targets);
    rows.push({ mechanism: 'TUNNEL ramp', target: `spring riders (duck/horse/rocket pop bumpers)`, deterministic: true,
      arrives: r.contacted, closestApproachM: r.minDist,
      note: r.contacted ? `contacts '${r.contactedTag}'` : `nearest was '${r.nearestTag}'` });
  }

  // 4. SANDBOX scoop eject -> "the left flipper" (table/ramps.js buildSandbox doc comment).
  // Exact hand-off state reproduced from main.js's own eject application (main.js:723-732):
  // pos = captureZone.centre + normalize(eject.vel) * (captureZone.radius * 1.3), vel = eject.vel.
  const sandbox = ramps.buildSandbox();
  {
    const evel = sandbox.eject.vel;
    const evLen = Math.hypot(evel.x, evel.y) || 1;
    const clear = sandbox.captureZone.radius * 1.3;
    const ejectPos = {
      x: sandbox.captureZone.centre.x + (evel.x / evLen) * clear,
      y: sandbox.captureZone.centre.y + (evel.y / evLen) * clear,
    };
    const r = towardFlipper(ejectPos, evel, 'left');
    rows.push({ mechanism: 'SANDBOX scoop eject', target: 'LEFT flipper', deterministic: true,
      arrives: r.contacted, closestApproachM: r.minDist, perState: r.perState, statesHit: r.statesHit,
      note: r.contacted ? '' : `closest approach occurs well above the flipper's height (y=${r.closest.y.toFixed(3)} vs pivot y=${r.pivot.y}) — the trajectory diverges toward the right side of the table before it ever descends that far, not a narrow same-height miss` });
  }

  // 5. MERRY-GO-ROUND release -> no single point target ("down/in toward the main field", per
  // table/mechanisms.js's MGR_RELEASE_PREFERRED_HEADING comment) — computeEjectPlacement's job
  // is "clear every obstacle safely", not "reach mechanism X". That property (clears every
  // obstacle + its own zone by SAFETY_M) is already a committed regression test
  // (test/mechanisms.test.mjs: "every ejection site ... clears its own zone and every other
  // mechanism skirt"). Not re-simulated here — no arrival distance to report against a
  // nonexistent point target.
  rows.push({ mechanism: 'MERRY-GO-ROUND release', target: 'no single point — "toward the main field", clear of every obstacle', deterministic: true,
    arrives: 'n/a', closestApproachM: null, note: 'correctness (clears every obstacle by SAFETY_M) already covered by test/mechanisms.test.mjs' });

  // 6. SANDBOX add-a-ball placement -> same treatment as #5, same underlying mechanism
  // (computeEjectPlacement), same existing regression test.
  rows.push({ mechanism: 'SANDBOX add-a-ball placement', target: 'no single point — clear of every obstacle', deterministic: true,
    arrives: 'n/a', closestApproachM: null, note: 'correctness already covered by test/mechanisms.test.mjs' });

  // 7. PLUNGER -> no single named mechanism target anywhere in the table geometry (grepped
  // table/*.js and main.js — none). The nearest documented statement is recess.js's own: "above
  // LANE_TOP_Y up to HEIGHT the lane and main field share one open upper chamber" — i.e. the
  // plunger's job is to clear the lane into the open field, not reach a specific mechanism.
  // NOT deterministic: main.js:668 computes launch speed as
  // `Math.max(0.6, plungerPower) * PLUNGER_MAX_SPEED`, where plungerPower is player input in
  // [0,1] — every release is floored at 0.6x max (3.0 m/s) up to 1.0x max (5.0 m/s), always
  // straight up (vel.x=0) from LAUNCH_POSITION. Sampled the real achievable range (the floor,
  // the auto-launch value main.js:798 uses for multiball at 0.7x, and full power) rather than
  // inventing one representative value.
  {
    const samples = [0.6, 0.7, 1.0];
    const results = samples.map((power) => {
      const { world } = buildFullWorld();
      const speed = power * PLUNGER_MAX_SPEED;
      const ball = addBall(world, { id: 't', pos: { x: recess.LAUNCH_POSITION.x, y: recess.LAUNCH_POSITION.y }, vel: { x: 0, y: speed }, radius: BALL_RADIUS });
      let clearedLane = false;
      for (let i = 0; i < Math.round(2.0 / STEP_DT); i++) {
        advance(world, STEP_DT);
        if (ball.pos.y >= recess.LANE_TOP_Y) { clearedLane = true; break; }
        if (recess.isDrained(ball)) break;
      }
      return { power, speed, clearedLane };
    });
    const allClear = results.every((r) => r.clearedLane);
    rows.push({ mechanism: 'PLUNGER', target: 'no single mechanism — clears the lane into the open upper playfield (LANE_TOP_Y)', deterministic: false,
      arrives: allClear, closestApproachM: null,
      note: `sampled power range (game floors every release at 0.6x, ships a 0.7x auto-launch, up to 1.0x): ${JSON.stringify(results)}` });
  }

  // 8/9. SLINGSHOT and POP-BUMPER kicks -> NO documented destination anywhere (grepped
  // table/mechanisms.js and physics/constants.js for both; POP_BUMPER_KICK/SLINGSHOT_KICK are
  // just boost magnitudes applied at the moment of a reflection off the surface the ball
  // happened to hit — the outgoing direction is a function of the ball's own incoming angle,
  // not a fixed hand-off state). Excluded from arrival/distance measurement for lack of a
  // target to measure against, stated plainly rather than silently skipped or invented.
  rows.push({ mechanism: 'SLINGSHOT kicks (left/right)', target: 'none documented — reflection-dependent on incoming angle, not a fixed hand-off', deterministic: 'n/a', arrives: 'n/a', closestApproachM: null, note: 'excluded — no target to measure' });
  rows.push({ mechanism: 'POP BUMPER kicks (duck/horse/rocket)', target: 'none documented — same reason', deterministic: 'n/a', arrives: 'n/a', closestApproachM: null, note: 'excluded — no target to measure' });

  // 10. Ramp entry GATES (slide/monkeyBars/tunnel) -> their own job is "admit the ball into the
  // ramp layer", already exercised by rows 1-3 (the ramp exits ARE the hand-off being audited);
  // they have no separate destination of their own.
  rows.push({ mechanism: 'Ramp entry gates (x3)', target: 'admit into their own ramp — already covered by rows 1-3', deterministic: 'n/a', arrives: 'n/a', closestApproachM: null, note: 'no separate hand-off to audit' });

  console.log('\n=== mechanism hand-off audit ===');
  for (const r of rows) {
    console.log(`${r.mechanism} -> ${r.target}`);
    console.log(`  deterministic=${r.deterministic}  arrives=${r.arrives}  closestApproach=${r.closestApproachM !== null ? (r.closestApproachM * 100).toFixed(2) + 'cm' : 'n/a'}`);
    if (r.perState) {
      console.log(`  ${r.perState.map((s) => `${s.state}=${s.hit ? `hit@${s.alongBat.toFixed(2)}` : 'miss'}`).join('  ')}   (alongBat: 0=pivot hub, 1=tip)`);
    }
    if (r.note) console.log(`  ${r.note}`);
  }

  const missCount = rows.filter((r) => r.arrives === false).length;
  console.log(`\n${missCount} confirmed miss(es) among the mechanisms with a real point target: ` +
    rows.filter((r) => r.arrives === false).map((r) => r.mechanism).join(', '));

  const tunnelRow = rows.find((r) => r.mechanism === 'TUNNEL ramp');
  assert.equal(tunnelRow.arrives, true, 'TUNNEL ramp -> spring riders regressed (was connecting)');

  const plungerRow = rows.find((r) => r.mechanism === 'PLUNGER');
  assert.equal(plungerRow.arrives, true, 'PLUNGER regressed — no longer clears the lane at every sampled power');

  // The three feeds this file was written to expose as silent misses are now re-aimed
  // (table/ramps.js, 2026-09-04 — exit vectors only, no pivot/length/angle touched) and are
  // asserted rather than merely reported.
  //
  // The bar is deliberately stricter than `arrives`. Before the re-aim, SLIDE went from
  // arrives=false to arrives=true purely from sonnet2's flipper sub-stepping (abd4e88) while
  // its geometry was untouched — but the contact it gained was at alongBat -0.31, the round
  // hub at the pivot end, and only when the flipper was already raised. A boolean cannot tell
  // that from a real hit, so the two ramp feeds assert the contact lands on the BAT, in every
  // flipper state a player's timing can produce.
  const onBat = (f) => f > 0.25 && f < 0.95;

  for (const name of ['SLIDE ramp', 'MONKEY BARS ramp']) {
    const row = rows.find((r) => r.mechanism === name);
    assert.equal(row.arrives, true, `${name} no longer reaches the flipper its exit constant is named for`);
    assert.equal(row.statesHit, 3, `${name} reaches the flipper in only ${row.statesHit}/3 flipper states`);
    for (const s of row.perState) {
      assert.ok(onBat(s.alongBat),
        `${name} (${s.state}): contact at alongBat=${s.alongBat.toFixed(3)} is on the hub/past the tip, not the bat`);
    }
  }

  // The SANDBOX scoop asserts ARRIVAL only, and that limit is measured, not conceded for
  // convenience. Its eject origin is not free (main.js derives it from the aim), and the ball
  // then flies ~45cm unguided past the slingshot before it reaches flipper height. Sweeping
  // every heading at SCOOP_EJECT: 26 arrive in all three states, and the best of them held a
  // mid-bat landing in only 5 of 25 perturbations of ±3°/±0.2 m/s. Arrival itself is solid at
  // 35/35. Asserting a bat fraction here would be pinning a coincidence, so it is not pinned.
  const scoopRow = rows.find((r) => r.mechanism === 'SANDBOX scoop eject');
  assert.equal(scoopRow.arrives, true, 'SANDBOX scoop eject no longer reaches the left flipper');
  assert.equal(scoopRow.statesHit, 3, `SANDBOX scoop eject reaches the left flipper in only ${scoopRow.statesHit}/3 flipper states`);

  assert.equal(rows.filter((r) => r.arrives === false).length, 0,
    'a mechanism with a real point target is missing it again');
});
