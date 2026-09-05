// RAMP DIVERTER (2026-09-05) — routes a ball onto one of two existing ramp tracks depending on
// game state, switchable at runtime. table/ramps.js's buildDiverter doc comment records why
// this needs no new physics primitive and no new ramp/exit geometry: it's an ordinary Gate
// (physics/shapes.js) whose `toLayer` field the game layer mutates directly, the same
// "game layer mutates a field on the shared physics-owned object" pattern the drop-target
// `.active` flag already uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerZones, addRamp, addBall, advance } from '../src/physics/world.js';
import { BALL_RADIUS, STEP_DT } from '../src/physics/constants.js';
import * as ramps from '../src/table/ramps.js';
import * as game from '../src/game/mechanisms.js';

function makeWorldWithDiverter() {
  const world = createWorld();
  world.layers.set('playfield', []); // world.js requires a 'playfield' entry even if empty
  const slide = ramps.buildSlideRamp();
  const tunnel = ramps.buildTunnelRamp();
  const diverter = ramps.buildDiverter(slide.ramp.id, tunnel.ramp.id);
  addRamp(world, slide.ramp);
  addRamp(world, tunnel.ramp);
  setLayerZones(world, 'playfield', [diverter.gate]);
  const ball = addBall(world, { id: 'b0', pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS });
  return { world, ball, slide, tunnel, diverter };
}

// Shoots the ball straight through the diverter's own mouth, along its own allowDir — the
// exact geometry the gate is built from (table/ramps.js's buildDiverter), not a hand-picked
// approach angle.
function shootThroughDiverter(world, ball, diverter, speed = 3.0) {
  const a = diverter.gate.a, b = diverter.gate.b;
  const mouth = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const dir = diverter.gate.gate.allowDir;
  ball.layer = 'playfield';
  ball.pos = { x: mouth.x - dir.x * 0.03, y: mouth.y - dir.y * 0.03 };
  ball.vel = { x: dir.x * speed, y: dir.y * speed };
  for (let i = 0; i < 30 && ball.layer === 'playfield'; i++) advance(world, STEP_DT);
}

test('diverter defaults to route A (routeARampId) at construction', () => {
  const { slide, diverter } = makeWorldWithDiverter();
  assert.equal(diverter.gate.gate.toLayer, slide.ramp.id, 'buildDiverter should start on route A');
  assert.equal(game.currentDiverterRoute(diverter), 'A');
});

test('a ball crossing the diverter with route A active is routed onto ramp A', () => {
  const { world, ball, slide, diverter } = makeWorldWithDiverter();
  shootThroughDiverter(world, ball, diverter);
  assert.equal(ball.layer, slide.ramp.id, 'route A must send the ball onto the A ramp track');
});

test('a ball crossing the diverter with route B active is routed onto ramp B — same gate, different destination', () => {
  const { world, ball, tunnel, diverter } = makeWorldWithDiverter();
  game.setDiverterRoute(diverter, 'B');
  assert.equal(game.currentDiverterRoute(diverter), 'B', 'sanity: the route actually changed');
  shootThroughDiverter(world, ball, diverter);
  assert.equal(ball.layer, tunnel.ramp.id, 'route B must send the ball onto the B ramp track, through the SAME gate object');
});

test('the route is switchable at runtime, not fixed at construction — the same diverter object routes both ways in sequence', () => {
  const { world, ball, slide, tunnel, diverter } = makeWorldWithDiverter();

  // Starts on A (construction default).
  shootThroughDiverter(world, ball, diverter);
  assert.equal(ball.layer, slide.ramp.id, 'first shot, still on route A');

  // Switch to B and shoot a second, independent ball through the SAME diverter — proving the
  // switch is a live mutation of the one gate object main.js/the sandbox actually wired in,
  // not a value baked in when buildDiverter() was called.
  game.setDiverterRoute(diverter, 'B');
  const world2 = createWorld();
  world2.layers.set('playfield', []);
  addRamp(world2, slide.ramp);
  addRamp(world2, tunnel.ramp);
  setLayerZones(world2, 'playfield', [diverter.gate]);
  const ball2 = addBall(world2, { id: 'b1', pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS });
  shootThroughDiverter(world2, ball2, diverter);
  assert.equal(ball2.layer, tunnel.ramp.id, 'second shot, after switching, takes route B — same diverter, different outcome');

  // Switch back to A — the flag isn't a one-way "used up" latch (unlike the kickback's
  // own once-per-ball lit flag); a diverter is a standing routing decision, freely reversible.
  game.setDiverterRoute(diverter, 'A');
  assert.equal(game.currentDiverterRoute(diverter), 'A');
});

test('setDiverterRoute rejects anything other than \'A\' or \'B\'', () => {
  const { diverter } = makeWorldWithDiverter();
  assert.throws(() => game.setDiverterRoute(diverter, 'C'), RangeError);
  assert.throws(() => game.setDiverterRoute(diverter, undefined), RangeError);
});

test('a slow approach to the diverter does not transition — same RAMP_ENTRY_MIN_SPEED gate behaviour as every other ramp entry', () => {
  const { world, ball, diverter } = makeWorldWithDiverter();
  shootThroughDiverter(world, ball, diverter, 0.05);
  assert.equal(ball.layer, 'playfield', 'a near-stationary ball should not be swept through the diverter');
});
