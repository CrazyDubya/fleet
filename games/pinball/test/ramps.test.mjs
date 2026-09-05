import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerZones, setCaptureZones, addRamp, addBall, advance } from '../src/physics/world.js';
import { createRampTrack, sampleRamp, entryTangent } from '../src/physics/ramp.js';
import { BALL_RADIUS, STEP_DT } from '../src/physics/constants.js';
import { length, distance } from '../src/physics/vec2.js';
import * as ramps from '../src/table/ramps.js';

function makeWorldWithRamps() {
  const world = createWorld();
  setLayerPrimitivesNoop(world);
  const slide = ramps.buildSlideRamp();
  const monkeyBars = ramps.buildMonkeyBarsRamp();
  const tunnel = ramps.buildTunnelRamp();
  const orbit = ramps.buildOrbitRamp();
  addRamp(world, slide.ramp);
  addRamp(world, monkeyBars.ramp);
  addRamp(world, tunnel.ramp);
  addRamp(world, orbit.ramp);
  setLayerZones(world, 'playfield', [slide.gate, monkeyBars.gate, tunnel.gate, orbit.gate]);
  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS });
  return { world, ball, slide, monkeyBars, tunnel, orbit };
}

// world.js requires a 'playfield' entry in `layers` even if empty, so plain collision
// checks against it don't throw.
function setLayerPrimitivesNoop(world) {
  world.layers.set('playfield', []);
}

function shootThroughGate(world, ball, gate, ramp, speed = 3.0) {
  const tangent = entryTangent(ramp);
  const start = ramp.points[0];
  ball.layer = 'playfield';
  ball.pos = { x: start.x - tangent.x * 0.03, y: start.y - tangent.y * 0.03 };
  ball.vel = { x: tangent.x * speed, y: tangent.y * speed };
  let events = [];
  for (let i = 0; i < 30 && ball.layer === 'playfield'; i++) {
    events = events.concat(advance(world, STEP_DT));
  }
  return events;
}

test('sampleRamp interpolates position and height linearly along arclength, and clamps at the ends', () => {
  const ramp = createRampTrack({
    id: 'test', pitchDeg: 20,
    points: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0.1 }],
    exit: { pos: { x: 0, y: 0 }, dir: { x: 0, y: -1 }, speed: 1 },
  });
  assert.equal(ramp.totalLength, 1);
  const mid = sampleRamp(ramp, 0.5);
  assert.ok(Math.abs(mid.pos.y - 0.5) < 1e-9);
  assert.ok(Math.abs(mid.z - 0.05) < 1e-9);
  const past = sampleRamp(ramp, 5);
  assert.ok(Math.abs(past.pos.y - 1) < 1e-9, 'sampling past the end clamps to the last point');
  const before = sampleRamp(ramp, -5);
  assert.ok(Math.abs(before.pos.y - 0) < 1e-9, 'sampling before the start clamps to the first point');
});

test('a slow shot at a ramp gate does not transition (below RAMP_ENTRY_MIN_SPEED)', () => {
  const { world, ball, slide } = makeWorldWithRamps();
  shootThroughGate(world, ball, slide.gate, slide.ramp, 0.05);
  assert.equal(ball.layer, 'playfield', 'a near-stationary ball should not be swept onto the ramp');
});

test('THE SLIDE: a real shot enters the ramp, climbs (z > 0), and returns to the left inlane feed', () => {
  const { world, ball, slide } = makeWorldWithRamps();
  shootThroughGate(world, ball, slide.gate, slide.ramp, 3.0);
  assert.equal(ball.layer, 'slide', 'expected the ball to have entered the slide layer');

  let sawHeight = false;
  let exited = false;
  for (let i = 0; i < 600 && !exited; i++) {
    advance(world, STEP_DT);
    if ((ball.z || 0) > 0.01) sawHeight = true;
    if (ball.layer === 'playfield') exited = true;
  }
  assert.ok(exited, 'the ball never returned to the playfield');
  assert.ok(sawHeight, 'the ball never rendered above the playfield while on the ramp');
  assert.ok(distance(ball.pos, ramps.LEFT_INLANE_FEED) < 1e-6, 'expected an exact hand-off to the left inlane feed point');
});

test('MONKEY BARS: a real shot enters, crosses overhead, and drops onto the upper-left flipper feed', () => {
  const { world, ball, monkeyBars } = makeWorldWithRamps();
  shootThroughGate(world, ball, monkeyBars.gate, monkeyBars.ramp, 3.0);
  assert.equal(ball.layer, 'monkeybars');

  let exited = false;
  for (let i = 0; i < 600 && !exited; i++) {
    advance(world, STEP_DT);
    if (ball.layer === 'playfield') exited = true;
  }
  assert.ok(exited);
  assert.ok(distance(ball.pos, ramps.UPPER_LEFT_FLIPPER_FEED) < 1e-6);
});

test('THE TUNNEL: a real shot enters the orbit cleanly and exits toward the spring riders', () => {
  const { world, ball, tunnel } = makeWorldWithRamps();
  shootThroughGate(world, ball, tunnel.gate, tunnel.ramp, 4.6);
  assert.equal(ball.layer, 'tunnel');

  let exited = false;
  for (let i = 0; i < 600 && !exited; i++) {
    advance(world, STEP_DT);
    if (ball.layer === 'playfield') exited = true;
  }
  assert.ok(exited);
  assert.ok(distance(ball.pos, ramps.SPRING_RIDER_FEED) < 1e-6);
});

test('THE ORBIT: a real shot completes the full loop and exits toward the right flipper, at the exact authored hand-off', () => {
  const { world, ball, orbit } = makeWorldWithRamps();
  shootThroughGate(world, ball, orbit.gate, orbit.ramp, 4.6);
  assert.equal(ball.layer, 'orbit', 'a real shot must transition onto the orbit layer');

  let exited = false;
  for (let i = 0; i < 600 && !exited; i++) {
    advance(world, STEP_DT);
    if (ball.layer === 'playfield') exited = true;
  }
  assert.ok(exited, 'a strong enough shot must complete the loop and come back to playfield');
  assert.ok(distance(ball.pos, ramps.ORBIT_EXIT_FEED) < 1e-6, 'must exit at exactly the authored hand-off point, not somewhere approximate');
  assert.ok(Math.abs(length(ball.vel) - orbit.ramp.exit.speed) < 1e-6, 'must exit at exactly the authored speed');
});

// This is the one that matters (RAMP_ENTRY_MIN_SPEED exists, and a full loop is where a
// marginal shot behaves worst): a ball that enters but can't carry all the way around must
// roll back down and return to the playfield near the ENTRY, moving backward — never teleport
// to the exit, and never get stuck stranded mid-track forever.
test('a shot too weak to complete THE ORBIT rolls back near the entry, moving backward — never teleports, never sticks', () => {
  const { world, ball, orbit } = makeWorldWithRamps();
  // Clears RAMP_ENTRY_MIN_SPEED (transitions onto the ramp) but far short of what a ~10°
  // incline over this track's real length needs to reach the crest.
  shootThroughGate(world, ball, orbit.gate, orbit.ramp, 0.6);
  assert.equal(ball.layer, 'orbit', 'sanity: the shot did transition onto the ramp');

  let rolledBack = false;
  for (let i = 0; i < 600 && !rolledBack; i++) {
    advance(world, STEP_DT);
    if (ball.layer === 'playfield') rolledBack = true;
  }
  assert.ok(rolledBack, 'a too-weak shot must roll back out rather than getting stuck stranded on the track');
  assert.ok(distance(ball.pos, orbit.ramp.points[0]) < 0.02, 'must roll back out near the ENTRY, not teleport to the exit on the far side of the table');
  const tangent = entryTangent(orbit.ramp);
  assert.ok(ball.vel.x * tangent.x + ball.vel.y * tangent.y < 0, 'must be moving backward (away from the ramp, back toward the entry) on roll-back, not still heading forward');
});

test('a ramp shot that runs out of speed before the crest rolls back to the playfield near the entry, moving backward', () => {
  const { world, ball, slide } = makeWorldWithRamps();
  // Just barely clears the entry threshold, nowhere near enough to reach the crest against
  // a 24° incline.
  shootThroughGate(world, ball, slide.gate, slide.ramp, 0.6);
  assert.equal(ball.layer, 'slide');

  let rolledBack = false;
  for (let i = 0; i < 600 && !rolledBack; i++) {
    advance(world, STEP_DT);
    if (ball.layer === 'playfield') rolledBack = true;
  }
  assert.ok(rolledBack, 'a too-slow shot should roll back out rather than getting stuck');
  assert.ok(distance(ball.pos, slide.ramp.points[0]) < 0.02, 'should roll back out near the ramp entry, not the exit');
  const tangent = entryTangent(slide.ramp);
  assert.ok(ball.vel.x * tangent.x + ball.vel.y * tangent.y < 0, 'should be moving backward (away from the ramp) on roll-back');
});

test('THE SANDBOX: captures a ball on entry, pins it, and ejects it at SCOOP_EJECT after the hold delay', () => {
  const world = createWorld();
  setLayerPrimitivesNoop(world);
  const sandbox = ramps.buildSandbox();
  setCaptureZones(world, 'playfield', [sandbox.captureZone]);
  const ball = addBall(world, { id: 'b0', pos: { x: sandbox.captureZone.centre.x - 0.05, y: sandbox.captureZone.centre.y }, vel: { x: 1, y: 0 }, radius: BALL_RADIUS });

  let captureEvent = null;
  for (let i = 0; i < 60 && !captureEvent; i++) {
    const events = advance(world, STEP_DT);
    captureEvent = events.find((e) => e.captured);
  }
  assert.ok(captureEvent, 'expected a capture event');
  assert.equal(ball.captured, true);
  assert.equal(length(ball.vel), 0);

  // Pinned: doesn't move even as time passes, until something outside physics ejects it
  // (the scoop's timed eject is game.js/main.js territory — physics only pins).
  const posBefore = { ...ball.pos };
  for (let i = 0; i < 60; i++) advance(world, STEP_DT);
  assert.deepEqual(ball.pos, posBefore);

  // Simulate the eject (as main.js does): clear the flag, set the eject velocity, and
  // nudge just clear of the capture radius so it isn't immediately re-captured.
  ball.captured = false;
  ball.pos = { x: sandbox.captureZone.centre.x + sandbox.captureZone.radius * 1.3, y: sandbox.captureZone.centre.y };
  ball.vel = { ...sandbox.eject.vel };
  assert.ok(Math.abs(length(sandbox.eject.vel) - 2.2) < 1e-9, 'SANDBOX eject speed should be SCOOP_EJECT (2.2 m/s)');

  advance(world, STEP_DT);
  assert.equal(ball.captured, false, 'must not be immediately re-captured after ejecting');
});
