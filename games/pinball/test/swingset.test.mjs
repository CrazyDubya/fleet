// Guard for opus2's whole-table audit finding, and its own follow-up: the swing-set posts
// (r 4mm, flanking each slingshot) were drawn solid but had no physics — a ball passed
// straight through. This game's physics is flat (x,y only; z is a render-only height offset,
// never a collision gate), so the two SIDE posts (which span table height 0 to 0.09, reaching
// ball height) get colliders here. The horizontal top CROSSBAR does not: it sits overhead at
// scene y=0.09 (90mm), well above BALL_RADIUS*2 (27mm) — same case as the treehouse roof,
// drawn where it physically is, a ball rolls under it (see the crossbar mesh in main.js for
// the height-clearance comment; that half has no test here since "draws no collider" isn't
// independently testable the way a collider's geometry is).
//
// A supplementary drain-sweep including these posts found a genuine dead pocket when the
// crossbar ALSO had a collider (a ball wedged between a crossbar collider and its neighbouring
// side post) — see test/drain-sweep-mechanisms.test.mjs, the permanent version of that check.
// Removing the crossbar's collider (this file) is what resolves it, not moving a post.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, setLayerPrimitives, addBall, advance } from '../src/physics/world.js';
import { BALL_RADIUS, STEP_DT, E_WALL } from '../src/physics/constants.js';
import * as mech from '../src/table/mechanisms.js';

test('buildSwingSetPosts returns exactly the four side-post E_WALL circle colliders, r 4mm', () => {
  const posts = mech.buildSwingSetPosts();
  assert.equal(posts.length, 4, 'expected four swing-set side-post colliders (2 apexes x 2 side posts) — the crossbar is overhead and has no collider');
  for (const p of posts) {
    assert.equal(p.shape.kind, 'circle');
    assert.equal(p.shape.radius, mech.SWING_SET_POST_RADIUS);
    assert.equal(mech.SWING_SET_POST_RADIUS, 0.004);
    assert.equal(p.shape.restitution, E_WALL, `post "${p.tag}" must use E_WALL restitution (a solid post, not rubber)`);
    assert.deepEqual(p.shape.centre, p.centre);
  }
  // No two posts share a tag — each is individually identifiable for future scoring.
  assert.equal(new Set(posts.map((p) => p.tag)).size, 4);
});

test('a ball fired at each swing-set side post centre deflects and never enters its radius', () => {
  const posts = mech.buildSwingSetPosts();
  for (const post of posts) {
    const world = createWorld();
    setLayerPrimitives(world, 'playfield', posts.map((p) => ({ shape: p.shape })));
    const ball = addBall(world, {
      id: 'b0',
      pos: { x: post.centre.x + 0.05, y: post.centre.y },
      vel: { x: -1.0, y: 0 },
      radius: BALL_RADIUS,
    });
    const initialVelAngle = Math.atan2(ball.vel.y, ball.vel.x);
    let minDist = Infinity;
    for (let i = 0; i < 300; i++) {
      advance(world, STEP_DT);
      minDist = Math.min(minDist, Math.hypot(ball.pos.x - post.centre.x, ball.pos.y - post.centre.y));
    }
    assert.ok(
      minDist >= mech.SWING_SET_POST_RADIUS - 1e-6,
      `ball entered post "${post.tag}"'s radius: min centre distance ${minDist} < r ${mech.SWING_SET_POST_RADIUS} — passed straight through`
    );
    const finalVelAngle = Math.atan2(ball.vel.y, ball.vel.x);
    assert.notEqual(
      finalVelAngle, initialVelAngle,
      `ball's velocity direction never changed for post "${post.tag}" — it passed straight through undeflected`
    );
  }
});
