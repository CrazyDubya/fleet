// Integration risk that exists only as of the 2026-09-04 outlane/inlane dispatch: a ball can
// now go down a MODELLED left outlane while both the kickback (lit, once-per-ball) and the
// DO-OVER ball save (armed, once-per-ball) are available. Before today the two never coexisted
// — there was no outlane for a kickback to sit in reachably alongside a live save window. This
// test drives the same sequence main.js's frame() does — advance() -> apply the kickback's
// decision to any SW_KICKBACK contact -> THEN the geometric drain check -> rules.processEvents
// — using the same building blocks (physics/world.js, table/recess.js, table/mechanisms.js,
// game/mechanisms.js, rules/game.js) main.js wires together, since main.js itself isn't
// importable under node --test (see glue-scope.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, addBall, addFlipper, advance } from '../src/physics/world.js';
import { createFlipper } from '../src/physics/flipper.js';
import { BALL_RADIUS, STEP_DT } from '../src/physics/constants.js';
import * as recess from '../src/table/recess.js';
import * as mech from '../src/table/mechanisms.js';
import * as game from '../src/game/mechanisms.js';
import { createGame, launchBall, processEvents, activePlayer } from '../src/rules/game.js';
import { SW_KICKBACK, drainTagFor } from '../src/table/switches.js';

const RUN_S = 15;
// How long to keep watching for a drain AFTER a successful kickback catch, before concluding
// "this contact did not also drain" — long enough to rule out an immediate double-count (the
// ball needs several tenths of a second to fall back to y<0 even from right at the kickback),
// short enough not to run into a LATER, unrelated, legitimate drain: a kickback save launches
// the ball back into an empty field with no flippers in this test to keep it alive, so if run
// long enough it eventually falls back down and drains again for real, several seconds later —
// that second drain is ordinary gameplay (a real ball-save window would rightly engage on it
// too) and is deliberately NOT what this grace period is checking.
const POST_KICKBACK_GRACE_S = 1.5;

// Mirrors main.js's own frame() ordering: advance() first (physics, including any kickback
// CONTACT event), then the kickback's lit/once-per-ball DECISION applied to that tick's
// velocity (main.js:263-269), then the geometric drain check (main.js's own comment: "not a
// physics collision event"), each drain synthesised into a SW_DRAIN/SW_BALL_LOST tag for
// rules/game.js's processEvents — never called directly from inside the physics loop.
function runToDrainOrTimeout({ startPos, walls, extraPrimitives, kickbackState, kickbackShapeAndKick, rulesState, atS0 }) {
  const world = createWorld();
  const primitives = [
    ...walls.map((shape) => ({ shape })),
    ...extraPrimitives,
  ];
  setLayerPrimitives(world, 'playfield', primitives);
  for (const cfg of recess.buildFlipperConfigs()) addFlipper(world, createFlipper(cfg));
  const ball = addBall(world, { id: 'b0', pos: startPos, vel: { x: 0, y: 0 }, radius: BALL_RADIUS });

  let kickbackFired = false;
  let kickbackFiredAtS = null;
  let drainTag = null;
  let atS = atS0;
  for (let t = 0; t < Math.round(240 * RUN_S); t++) {
    const events = advance(world, STEP_DT);
    atS += STEP_DT;
    if (kickbackShapeAndKick) {
      for (const ev of events) {
        // Same extraction main.js's own tagOf() uses: a wall/circle collision event carries
        // its tag on `primitive.shape.tag`, not `event.tag` directly (that's reserved for
        // zone/capture/ramp events — see physics/world.js's advance()).
        const tag = ev.tag ?? ev.primitive?.shape?.tag;
        if (tag !== SW_KICKBACK) continue;
        if (game.tryKickback(kickbackState)) {
          kickbackFired = true;
          kickbackFiredAtS = atS;
          ev.ball.vel = { x: kickbackShapeAndKick.kick.vel.x, y: kickbackShapeAndKick.kick.vel.y };
        }
      }
    }
    if (recess.isDrained(ball)) {
      drainTag = drainTagFor({ liveBallsRemaining: 0 });
      break;
    }
    // Stop once the grace period after a catch has elapsed without a drain — see
    // POST_KICKBACK_GRACE_S's own comment for why this isn't just "run the full RUN_S".
    if (kickbackFiredAtS !== null && atS - kickbackFiredAtS >= POST_KICKBACK_GRACE_S) break;
  }
  const display = drainTag ? processEvents(rulesState, [drainTag], atS) : [];
  return { kickbackFired, drained: drainTag !== null, display, finalPos: { ...ball.pos } };
}

test('LEFT outlane, kickback LIT + ball save armed: the kickback saves the ball, the DO-OVER save is never touched', () => {
  const rulesState = createGame({ numPlayers: 1 });
  launchBall(rulesState, 0); // arms the DO-OVER window
  const p = activePlayer(rulesState);
  assert.equal(p.doOverUsed, false, 'sanity: save not yet used');

  const kickback = mech.buildKickback();
  const kickbackState = game.createKickback(); // starts lit (KICKBACK_STARTS_LIT)
  assert.equal(kickbackState.lit, true, 'sanity: kickback starts lit');

  const walls = recess.buildWalls();
  const swingSetPosts = mech.buildSwingSetPosts();
  const extraPrimitives = [
    ...swingSetPosts.map((post) => ({ shape: post.shape })),
    { shape: kickback.shape },
  ];

  // Drop the ball straight down the left outlane, above the kickback, between the apron and
  // the divider (real geometry, not a hand-picked trap point) — x=-0.19 sits inside the
  // outlane channel at this height (apron ~-0.185..-0.257, divider ~-0.14 at this y).
  const result = runToDrainOrTimeout({
    startPos: { x: -0.19, y: 0.25 },
    walls, extraPrimitives, kickbackState, kickbackShapeAndKick: kickback, rulesState, atS0: 0,
  });

  assert.equal(result.kickbackFired, true, 'expected the lit kickback to fire on this drop');
  assert.equal(result.drained, false, `the SAME contact that fired the kickback must not also register as a drain within ${POST_KICKBACK_GRACE_S}s of the catch — kickback and drain are mutually exclusive for one contact (a ball the kickback launches back into the field may of course drain again later, for real, unrelated reasons; that is ordinary gameplay and not what this checks)`);
  assert.deepEqual(result.display, [], 'no drain tag was synthesised for this contact, so rules/game.js never even saw it — nothing to process');

  // The real assertion: the DO-OVER save state is BYTE-FOR-BYTE untouched, because handleDrain
  // (rules/game.js) — the only place doOverUsed is set — was never called.
  assert.equal(p.doOverUsed, false, 'DO-OVER save must remain unused: the kickback saved the ball before it was ever lost, matching a real machine (a kickback prevents the drain the ball save exists to forgive, it does not consume it)');
  assert.equal(p.ballActive, true, 'the ball is still the active ball — no end-of-ball, no re-serve, nothing happened at the rules layer at all');
});

test('LEFT outlane, kickback UNLIT (already used) + ball save armed: the ball drains normally and the save IS consumed — kickback missing changes nothing about ball-save', () => {
  const rulesState = createGame({ numPlayers: 1 });
  launchBall(rulesState, 0);
  const p = activePlayer(rulesState);

  const kickback = mech.buildKickback();
  const kickbackState = game.createKickback();
  kickbackState.usedThisBall = true; // already fired earlier this ball — matches tryKickback's own "once per ball" gate
  assert.equal(game.tryKickback(kickbackState), false, 'sanity: a used kickback does not fire again');
  kickbackState.usedThisBall = true; // tryKickback's sanity call above didn't change this, but restate for clarity

  const walls = recess.buildWalls();
  const swingSetPosts = mech.buildSwingSetPosts();
  const extraPrimitives = [
    ...swingSetPosts.map((post) => ({ shape: post.shape })),
    { shape: kickback.shape },
  ];

  const result = runToDrainOrTimeout({
    startPos: { x: -0.19, y: 0.25 },
    walls, extraPrimitives, kickbackState, kickbackShapeAndKick: kickback, rulesState, atS0: 0,
  });

  assert.equal(result.kickbackFired, false, 'an already-used kickback must not fire a second time this ball');
  assert.equal(result.drained, true, 'with the kickback unable to save it, the ball must eventually reach the geometric drain — an ordinary passive-collider bounce, not a launch');
  assert.equal(result.display.some((d) => d.kind === 'ballSaved'), true, 'the DO-OVER save should engage exactly as it always has, unaffected by the kickback existing nearby');
  assert.equal(p.doOverUsed, true, 'the save was consumed by this drain, same as before the outlane/inlane split existed');
  assert.equal(p.ballActive, true, 'ballSaved means the same ball continues');
});

test('RIGHT outlane (no kickback at all): ball save behaves exactly as it did before the outlane/inlane split', () => {
  const rulesState = createGame({ numPlayers: 1 });
  launchBall(rulesState, 0);
  const p = activePlayer(rulesState);

  const walls = recess.buildWalls();
  const swingSetPosts = mech.buildSwingSetPosts();
  const extraPrimitives = swingSetPosts.map((post) => ({ shape: post.shape })); // no kickback on this side

  const result = runToDrainOrTimeout({
    startPos: { x: 0.19, y: 0.25 },
    walls, extraPrimitives, kickbackState: null, kickbackShapeAndKick: null, rulesState, atS0: 0,
  });

  assert.equal(result.drained, true, 'the right outlane has no save mechanism of its own — the ball must reach the drain');
  assert.equal(result.display.some((d) => d.kind === 'ballSaved'), true, 'DO-OVER still engages on the right side, same as always — this dispatch changed nothing about the right outlane');
  assert.equal(p.doOverUsed, true);
});
