import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, setLayerZones, addBall, advance } from '../src/physics/world.js';
import { BALL_RADIUS, STEP_DT, POP_BUMPER_KICK, SLINGSHOT_KICK } from '../src/physics/constants.js';
import { length } from '../src/physics/vec2.js';
import * as mech from '../src/table/mechanisms.js';
import * as ramps from '../src/table/ramps.js';
import { SW_HOPSCOTCH, SW_SAND, SW_FUN, SW_TETHERBALL_SPIN, SW_KICKBACK } from '../src/table/switches.js';
import * as game from '../src/game/mechanisms.js';

function makeWorldWith(primitives = [], zones = []) {
  const world = createWorld();
  setLayerPrimitives(world, 'playfield', primitives);
  setLayerZones(world, 'playfield', zones);
  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS });
  return { world, ball };
}

test('a pop bumper kicks a slow ball up to its rated speed', () => {
  const bumpers = mech.buildPopBumpers();
  const target = bumpers[0]; // duck
  const { world, ball } = makeWorldWith(bumpers.map((b) => ({ shape: b.shape })));
  // Place the ball just outside the skirt, moving slowly inward.
  const dir = { x: 1, y: 0 };
  ball.pos = { x: target.centre.x - (0.03 + BALL_RADIUS + 0.02), y: target.centre.y };
  ball.vel = { x: 0.3, y: 0 };
  let hit = false;
  for (let i = 0; i < 60 && !hit; i++) {
    advance(world, STEP_DT);
    if (length(ball.vel) >= POP_BUMPER_KICK - 1e-6) hit = true;
  }
  assert.ok(hit, 'ball never reached the pop bumper kick speed');
});

test('a slingshot kicks the ball to its rated speed on contact', () => {
  const slingshots = mech.buildSlingshots();
  const seg = slingshots.left[0];
  const { world, ball } = makeWorldWith([...slingshots.left, ...slingshots.right].map((shape) => ({ shape })));
  const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
  // Approach from the outward-normal side at modest speed.
  ball.pos = { x: mid.x - 0.02, y: mid.y };
  ball.vel = { x: 0.5, y: 0 };
  let hit = false;
  for (let i = 0; i < 60 && !hit; i++) {
    advance(world, STEP_DT);
    if (length(ball.vel) >= SLINGSHOT_KICK - 1e-6) hit = true;
  }
  assert.ok(hit, 'ball never reached the slingshot kick speed');
});

test('hopscotch bank: each target drops on hit and completing the bank fires the completion switch, then respawns', () => {
  const hopscotch = mech.buildHopscotchBank();
  assert.equal(hopscotch.targets.length, SW_HOPSCOTCH.length);
  const bank = game.createHopscotchBank(hopscotch.targets);

  const firedTags = new Set();
  let elapsed = 0;
  for (const tag of SW_HOPSCOTCH) {
    const fired = game.applyDropHit(bank, tag, elapsed);
    for (const f of fired) firedTags.add(f);
  }
  assert.ok(firedTags.has('hopscotch_complete'), 'completing all four targets should fire hopscotch_complete');
  for (const t of hopscotch.targets) assert.equal(t.shape.active, false, `${t.tag} should be dropped (inactive)`);

  // A second hit on an already-dropped target does nothing.
  assert.deepEqual(game.applyDropHit(bank, SW_HOPSCOTCH[0], elapsed), []);

  // After the respawn delay, the bank resets.
  elapsed += 10;
  game.tickDropBank(bank, elapsed);
  for (const t of hopscotch.targets) assert.equal(t.shape.active, true, `${t.tag} should have respawned`);
  assert.equal(bank.dropped.size, 0);
});

test('sand bank is four targets (S-A-N-D)', () => {
  const sandBank = mech.buildSandBank();
  assert.equal(sandBank.targets.length, 4);
  assert.deepEqual(sandBank.targets.map((t) => t.tag), SW_SAND);
});

test('F-U-N lanes: only the lit lane advances the set; completing all three lights fires fun_complete and resets', () => {
  const lamps = game.createFunLamps();
  assert.equal(lamps.pointer, 0);

  // Crossing an unlit lane (index 1, F is lit at index 0) registers its own tag but not fun_complete.
  let fired = game.applyFunCross(lamps, SW_FUN[1]);
  assert.deepEqual(fired, [SW_FUN[1]]);
  assert.equal(lamps.lit.size, 0);

  // Crossing the lit lane lights it.
  fired = game.applyFunCross(lamps, SW_FUN[0]);
  assert.ok(lamps.lit.has(SW_FUN[0]));

  game.advanceFunPointer(lamps);
  game.applyFunCross(lamps, SW_FUN[1]);
  game.advanceFunPointer(lamps);
  const last = game.applyFunCross(lamps, SW_FUN[2]);
  assert.ok(last.includes('fun_complete'));
  assert.equal(lamps.lit.size, 0, 'lamps reset after completion');
});

test('a ball crossing the TETHERBALL spinner zone fires a switch event and drives the spinner', () => {
  const spinners = mech.buildSpinners();
  const { world, ball } = makeWorldWith([], [spinners.tetherball, spinners.pinwheel]);
  const zone = spinners.tetherball;
  ball.pos = { x: zone.a.x, y: zone.a.y - 0.01 };
  ball.vel = { x: 0, y: 1.0 }; // straight across the horizontal zone segment

  const events = advance(world, STEP_DT * 20);
  const spinEvents = events.filter((e) => e.tag === SW_TETHERBALL_SPIN);
  assert.ok(spinEvents.length >= 1, 'expected at least one tetherball_spin event');

  const spinner = game.createSpinner();
  game.registerSpinnerHit(spinner);
  assert.ok(spinner.angularVel > 0);
  const before = spinner.angularVel;
  game.tickSpinner(spinner, 1);
  assert.ok(spinner.angularVel < before, 'decay should reduce angularVel over time');
});

test('the TREEHOUSE standup registers a hit without dropping (fixed post)', () => {
  const treehouse = mech.buildTreehouseStandup();
  const { world, ball } = makeWorldWith([{ shape: treehouse.shape }]);
  ball.pos = { x: treehouse.shape.centre.x - 0.03, y: treehouse.shape.centre.y };
  ball.vel = { x: 1.0, y: 0 };
  const events = advance(world, STEP_DT * 10);
  const hit = events.some((e) => e.primitive?.shape?.tag === 'treehouse');
  assert.ok(hit, 'expected a collision event against the TREEHOUSE standup');
  assert.equal(treehouse.shape.active, undefined, 'standup never sets active=false');
});

test('every ejection site (merry-go-round release, SANDBOX add-a-ball) clears its own zone and every other mechanism skirt by at least SAFETY_M', () => {
  const sandbox = ramps.buildSandbox();
  const sites = mech.buildEjectionSites(sandbox);
  assert.ok(sites.length >= 2, 'expected at least the merry-go-round and sandbox sites — a registry regression would silently drop coverage');

  for (const site of sites) {
    const { zone, obstacles, placement } = site;

    // Never re-captured by the zone it just left.
    const ownDist = Math.hypot(placement.pos.x - zone.centre.x, placement.pos.y - zone.centre.y);
    assert.ok(
      ownDist > zone.radius + mech.SAFETY_M,
      `${site.name}: landing point is only ${ownDist.toFixed(5)}m from its own zone centre ` +
      `(radius ${zone.radius}, needs > ${(zone.radius + mech.SAFETY_M).toFixed(5)} with SAFETY_M)`
    );

    // Never spawned inside another mechanism's skirt.
    for (const o of obstacles) {
      const dist = Math.hypot(placement.pos.x - o.centre.x, placement.pos.y - o.centre.y);
      const needed = o.radius + BALL_RADIUS + mech.SAFETY_M;
      assert.ok(
        dist >= needed,
        `${site.name}: landing point (${placement.pos.x.toFixed(4)}, ${placement.pos.y.toFixed(4)}) ` +
        `is ${(needed - dist).toFixed(5)}m inside an obstacle's skirt+ball+safety margin`
      );
    }
  }
});

// --- Left outlane kickback (physics-level contact) ---
// Unlike the pop bumper/slingshot above, contact alone must NOT change the ball's velocity —
// the collider is deliberately passive (no .kick); table/mechanisms.js's buildKickback doc
// comment explains why (whether a contact fires is a lit/once-per-ball GAME decision, not a
// physics one). This test proves the tag fires on contact and that physics alone does nothing
// with it; game/mechanisms.js's tryKickback (below) and its main.js call site are what apply
// kickback.kick.vel when the decision says yes.
test('the kickback collider fires SW_KICKBACK on contact but applies no physics-level kick (passive collider)', () => {
  const kickback = mech.buildKickback();
  const { world, ball } = makeWorldWith([{ shape: kickback.shape }]);
  // Place the ball just outside the collider, moving slowly inward — same shape as the pop
  // bumper test above, but watching for the TAG, not a speed jump.
  const dir = { x: 1, y: 0 };
  ball.pos = { x: kickback.centre.x - (kickback.radius + BALL_RADIUS + 0.02), y: kickback.centre.y };
  ball.vel = { x: 0.3, y: 0 };
  let tagFired = false;
  let maxSpeedSeen = 0;
  for (let i = 0; i < 60; i++) {
    const events = advance(world, STEP_DT);
    for (const e of events) if (e.primitive?.shape?.tag === SW_KICKBACK) tagFired = true;
    maxSpeedSeen = Math.max(maxSpeedSeen, length(ball.vel));
  }
  assert.ok(tagFired, 'SW_KICKBACK never fired on contact');
  const launchSpeed = length(kickback.kick.vel);
  assert.ok(maxSpeedSeen < launchSpeed - 0.5,
    `contact alone reached ${maxSpeedSeen.toFixed(3)} m/s, too close to the ${launchSpeed.toFixed(3)} m/s ` +
    'kickback launch speed — a passive collider should not, on its own, approach that; only ' +
    'tryKickback saying yes and main.js applying kick.vel should ever produce it');
});

// --- Left outlane kickback (game-logic decision) ---
test('kickback: kicks when lit', () => {
  const kickback = game.createKickback();
  assert.equal(kickback.lit, true, 'starts lit — a design choice, see game/mechanisms.js\'s KICKBACK_STARTS_LIT');
  assert.equal(game.tryKickback(kickback), true);
  assert.equal(kickback.usedThisBall, true, 'a successful kick marks it used');
});

test('kickback: does not kick when unlit', () => {
  const kickback = game.createKickback();
  kickback.lit = false;
  assert.equal(game.tryKickback(kickback), false);
  assert.equal(kickback.usedThisBall, false, 'an unlit contact is not a use — it never fired');
});

// Found by an outside review (2026-09-05): main.js drives the kickback's mesh material from
// `lit` alone, and before this fix nothing cleared `lit` on a successful fire — the mesh kept
// showing "armed" for the rest of the ball even though a second contact correctly did nothing.
test('kickback: lit clears the moment it fires — the mesh must not keep claiming armed after a used kick', () => {
  const kickback = game.createKickback();
  assert.equal(game.tryKickback(kickback), true, 'the contact fires');
  assert.equal(kickback.lit, false, 'lit must clear on a successful fire — this is the flag main.js reads for the mesh material, and it must not lie about being armed');
  assert.equal(game.tryKickback(kickback), false, 'a second contact, same ball, still does not fire');
  assert.equal(kickback.lit, false, 'still unlit — a refused contact does not relight it');
});

test('kickback: a new ball re-lights it, not just re-arms usedThisBall', () => {
  const kickback = game.createKickback();
  game.tryKickback(kickback);
  assert.equal(kickback.lit, false, 'sanity: unlit after firing');
  game.resetKickbackForNewBall(kickback);
  assert.equal(kickback.lit, true, 'a genuinely new ball must re-light the kickback, not just clear usedThisBall — otherwise the mesh would show unlit forever after the first fire of the game');
});

test('kickback: does not kick twice in one ball', () => {
  const kickback = game.createKickback();
  assert.equal(game.tryKickback(kickback), true, 'the first contact this ball kicks');
  assert.equal(game.tryKickback(kickback), false, 'a second contact, same ball, does not');
  game.resetKickbackForNewBall(kickback);
  assert.equal(game.tryKickback(kickback), true, 'a genuinely new ball re-arms it');
});
