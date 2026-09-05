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

// Found by an outside review (2026-09-05), confirmed real: currentDiverterRoute used to be a
// plain `=== routeARampId ? 'A' : 'B'` ternary — any OTHER value (undefined, null, a corrupted
// or typo'd ramp id) silently read as a perfectly normal route B instead of being recognisable
// as corrupt.
//
// First fix made it throw. A SECOND outside review caught that this was worse, not better: the
// only production caller (main.js's processMechanismEvents) runs it inside a per-frame event
// loop with no try/catch, so a thrown error aborted the whole frame mid-iteration, silently
// dropping every OTHER event that frame — drains, scoring, everything. The precedent it was
// borrowed from (recess.js's degenerate-joint guard) runs at table CONSTRUCTION, before
// anything has started, where throwing is correct; this runs mid-frame, where it isn't. Now
// returns `null` (and console.error's, so it's still loud) instead — see the next test for the
// actual failure this exists to prevent: a corrupt value must not take the rest of the frame
// down with it.
test('currentDiverterRoute returns null, rather than throwing or silently reporting B, when toLayer is neither known route', () => {
  const { diverter } = makeWorldWithDiverter();
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    diverter.gate.gate.toLayer = 'some_unrelated_ramp_id';
    assert.equal(game.currentDiverterRoute(diverter), null);

    diverter.gate.gate.toLayer = undefined;
    assert.equal(game.currentDiverterRoute(diverter), null);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 2, 'still loud — one console.error per corrupt read');
  for (const e of errors) assert.match(e, /corrupt/i);
});

// Found by an outside review (2026-09-05), confirmed real: setDiverterRoute/
// currentDiverterRoute existed only in their own definitions and this test file — nothing in
// main.js or rules/ ever called setDiverterRoute, so the diverter was hardwired to route A in
// an actual game regardless of the runtime-switchable API existing. main.js now alternates the
// route on every successful diverter entry (see its own SW_DIVERTER_ENTER branch in
// processMechanismEvents); main.js itself isn't importable under node --test (bare 'three'
// specifier — see glue-scope.test.mjs), so this reproduces that exact branch's logic against
// the real physics/game pieces it's built from, the same discipline
// kickback-ball-save-interaction.test.mjs used for the kickback's own main.js wiring.
test('production wiring: a real diverter entry alternates the route for the NEXT ball, reproducing main.js\'s own SW_DIVERTER_ENTER handling', () => {
  const { world, ball, slide, tunnel, diverter } = makeWorldWithDiverter();

  function crossAndApplyProductionLogic() {
    const a = diverter.gate.a, b = diverter.gate.b;
    const mouth = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dir = diverter.gate.gate.allowDir;
    ball.layer = 'playfield';
    ball.pos = { x: mouth.x - dir.x * 0.03, y: mouth.y - dir.y * 0.03 };
    ball.vel = { x: dir.x * 3.0, y: dir.y * 3.0 };
    let events = [];
    for (let i = 0; i < 30 && ball.layer === 'playfield'; i++) events = events.concat(advance(world, STEP_DT));
    // main.js's own branch: only a genuine transition (event.gateEntered) alternates the
    // route, and only if currentDiverterRoute didn't report corruption (null).
    for (const ev of events) {
      const tag = ev.tag ?? ev.primitive?.shape?.tag;
      if (tag === diverter.gate.tag && ev.gateEntered) {
        const currentRoute = game.currentDiverterRoute(diverter);
        if (currentRoute !== null) game.setDiverterRoute(diverter, currentRoute === 'A' ? 'B' : 'A');
      }
    }
  }

  crossAndApplyProductionLogic();
  assert.equal(ball.layer, slide.ramp.id, 'first ball: route was A at the moment it crossed');
  assert.equal(game.currentDiverterRoute(diverter), 'B', 'production logic alternates the route after a real entry — this is what makes setDiverterRoute a live production caller, not dead code the tests are the only thing exercising');

  crossAndApplyProductionLogic();
  assert.equal(ball.layer, tunnel.ramp.id, 'second ball: route had already flipped to B by the time it crossed');
  assert.equal(game.currentDiverterRoute(diverter), 'A', 'flips back — an ordinary alternation, not a one-way latch');
});

// THE actual failure the corrupt-state fix exists to prevent (2026-09-05, second outside
// review): main.js's processMechanismEvents runs a single `for (const event of events)` loop
// over every physics event a frame produced, with no try/catch around any one branch. The
// first fix for the corrupt-toLayer bug threw an Error from inside the diverter's branch —
// which, in that loop, doesn't just fail the diverter's own event, it unwinds the whole
// function, abandoning every event still queued after it in the SAME frame (a drain, a score,
// anything). This reproduces that exact loop shape (the diverter branch's real logic, plus a
// trailing generic branch standing in for "everything else main.js's real loop also handles")
// and proves a corrupted diverter entry does NOT take the rest of the frame with it.
test('a corrupt toLayer during a diverter entry does not drop later events in the same frame — the actual failure this guards against', () => {
  const { diverter } = makeWorldWithDiverter();
  diverter.gate.gate.toLayer = 'some_unrelated_ramp_id'; // corrupt, before any crossing

  const originalError = console.error;
  console.error = () => {}; // expected and already covered by its own test above; silence it here
  let fired;
  try {
    // The exact shape of main.js's processMechanismEvents loop, reduced to the two branches
    // relevant here: the diverter's own handling, and a generic fallback for every other tag a
    // real frame's events array would also contain.
    const events = [
      { tag: diverter.gate.tag, gateEntered: true }, // the corrupt diverter entry
      { tag: 'some_other_switch_tag' },              // must still be reached and processed
      { tag: 'yet_another_tag_further_down_the_frame' },
    ];
    fired = [];
    for (const event of events) {
      const tag = event.tag;
      if (tag === diverter.gate.tag) {
        if (event.gateEntered) {
          const currentRoute = game.currentDiverterRoute(diverter);
          if (currentRoute !== null) game.setDiverterRoute(diverter, currentRoute === 'A' ? 'B' : 'A');
          fired.push(tag);
        }
      } else {
        fired.push(tag);
      }
    }
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(fired, [diverter.gate.tag, 'some_other_switch_tag', 'yet_another_tag_further_down_the_frame'],
    'every event after the corrupt diverter entry must still be processed — a corrupt route must not abort the frame loop');
  assert.equal(diverter.gate.gate.toLayer, 'some_unrelated_ramp_id', 'the corrupt value itself is left alone — this only skips the route-flip decision, it does not try to "fix" the corruption');
});
