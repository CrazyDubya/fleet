// Visual-accuracy audit (ledger/handoffs/haiku-fs2/20260904-drawn-vs-physical.md): seven places
// a ball's physics position teleports with nothing drawn carrying it. This closes the four the
// operator ranked worst — the two ramp habitrail returns (exit-top, rollback) and the SANDBOX
// scoop capture/eject — plus the merry-go-round release/eject pair, added in the follow-up
// dispatch (1a06e7c7c49773b4) — with a presentation-only tween (src/render/presentationTween.js)
// driven by the SAME endpoints physics used, never a duplicated coordinate. See that file's own
// header for why a straight-line, presentation-only tween is the right shape, and this
// dispatch's handoff for why the drain was left untouched (the mount was already fine — a
// reparent onto a visible rotating object, no teleport to bridge).
//
// main.js can't be imported under node --test (bare 'three' specifier, browser-only import
// map — see glue-scope.test.mjs), so this file source-text-extracts the four wiring points and
// asserts each one's `to` (and, where physics has one, `from`) expression is the literal real
// physics variable — never a re-typed literal — the same idiom render-art-follows-physics.test
// .mjs already established for mesh dimensions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MAIN_JS_SRC = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');

test('ramp exit/rollback presentation tween: from reads the ramp\'s own tracked endpoint, to reads the real post-teleport ball position', () => {
  const m = MAIN_JS_SRC.match(/const from = event\.rampExit === 'top' \? ramp\.points\[ramp\.points\.length - 1\] : ramp\.points\[0\];\s*\n\s*rampEntry\.presentationTween = startTween\(([^,]+),\s*([^,]+),\s*([^)]+)\);/);
  assert.ok(m, 'expected the ramp exit/rollback startTween(...) call in main.js, reading `from` from ramp.points');
  const [, fromExpr, toExpr, nowExpr] = m;
  assert.equal(fromExpr.trim(), 'from', `ramp tween "from" must be the ramp.points-derived value, got "${fromExpr.trim()}"`);
  assert.equal(
    toExpr.trim(), 'event.ball.pos',
    `ramp tween "to" must read event.ball.pos — the exact position physics/world.js's stepRampLayerBall already set (ramp.exit.pos on a made shot, the computed rollback landing point otherwise) — not a re-derived or duplicated coordinate, got "${toExpr.trim()}"`
  );
  assert.equal(nowExpr.trim(), 'elapsedS', `ramp tween must be timed off the real frame clock elapsedS, got "${nowExpr.trim()}"`);

  // The "from" endpoint itself must be one of the ramp's OWN points — the same array
  // main.js already renders the ramp mesh from (render-art-follows-physics.test.mjs's
  // sibling ramp-mesh checks) — not a separately authored coordinate.
  assert.ok(
    /ramp\.points\[ramp\.points\.length - 1\]/.test(MAIN_JS_SRC) && /: ramp\.points\[0\]/.test(MAIN_JS_SRC),
    'expected the exit-top / rollback branch to read ramp.points[length-1] / ramp.points[0], the ramp\'s own tracked endpoints'
  );
});

test('scoop capture presentation tween: to reads the real post-capture ball position (the zone centre physics itself snapped to)', () => {
  const m = MAIN_JS_SRC.match(/capturedEntry\.presentationTween = startTween\(([^,]+),\s*([^,]+),\s*([^)]+)\);/);
  assert.ok(m, 'expected the scoop-capture startTween(...) call in main.js');
  const [, fromExpr, toExpr, nowExpr] = m;
  assert.equal(
    toExpr.trim(), 'event.ball.pos',
    `capture tween "to" must read event.ball.pos — physics/world.js's checkCaptures has already snapped it to the zone centre by the time this event is seen — not a re-derived coordinate, got "${toExpr.trim()}"`
  );
  assert.equal(
    fromExpr.trim(), 'capturedEntry.prevPos ?? event.ball.pos',
    `capture tween "from" must read the ball's own real pre-capture position (captured each tick before advance() can teleport it), got "${fromExpr.trim()}"`
  );
  assert.equal(nowExpr.trim(), 'elapsedS');

  // The prevPos snapshot itself must come from the ball's own real physics fields, not a
  // constant or an unrelated value.
  assert.ok(
    /entry\.prevPos = \{ x: entry\.phys\.pos\.x, y: entry\.phys\.pos\.y, z: entry\.phys\.z \|\| 0 \};/.test(MAIN_JS_SRC),
    'expected a per-tick prevPos snapshot reading entry.phys.pos.x/y and entry.phys.z directly'
  );
});

test('scoop eject presentation tween: from reads the real capture-zone centre, to reads the exact position physics just computed for the eject', () => {
  // 2026-09-05: the scoop now holds `scoop.balls` (an array — an outside review found a second
  // ball entering the sandbox during multiball orphaned the first, which had overwritten a
  // single `scoop.ball` field) and ejects every held ball together in a `for (const ball of
  // ejectedBalls)` loop — see game/mechanisms.js's armScoop doc comment. `ball` here is that
  // loop's own per-iteration variable, not a duplicated literal; the assertions below are
  // updated to the new source shape, same underlying claim.
  const m = MAIN_JS_SRC.match(/ejectedEntry\.presentationTween = startTween\(([^,]+),\s*([^,]+),\s*([^)]+)\);/);
  assert.ok(m, 'expected the scoop-eject startTween(...) call in main.js');
  const [, fromExpr, toExpr, nowExpr] = m;
  assert.equal(
    fromExpr.trim(), 'sandbox.captureZone.centre',
    `eject tween "from" must read sandbox.captureZone.centre — the same object physics/world.js's checkCaptures used to freeze the ball there — got "${fromExpr.trim()}"`
  );
  assert.equal(
    toExpr.trim(), 'ball.pos',
    `eject tween "to" must read ball.pos AFTER it has been set to the eject clear point — the same assignment physics uses, read back rather than recomputed — got "${toExpr.trim()}"`
  );
  assert.equal(nowExpr.trim(), 'elapsedS');

  // The tween call must appear strictly after ball.pos is assigned the eject point (not
  // before, which would read the pre-eject position as "to" and defeat the whole point).
  const assignIdx = MAIN_JS_SRC.indexOf('ball.vel = { x: evel.x, y: evel.y };');
  const tweenIdx = MAIN_JS_SRC.indexOf('ejectedEntry.presentationTween');
  assert.ok(assignIdx >= 0 && tweenIdx > assignIdx, 'the eject tween must be started AFTER ball.pos is set to the eject point, so "to" is the real post-eject position');
});

test('merry-go-round release presentation tween: from reads the mesh\'s real world position via THREE\'s own transform, to reads the real release point', () => {
  const m = MAIN_JS_SRC.match(/entry\.presentationTween = startTween\(\s*\{ x: worldPos\.x, y: -worldPos\.z, z: worldPos\.y \},\s*\{ x: mgrRelease\.pos\.x, y: mgrRelease\.pos\.y, z: 0 \},\s*elapsedS,\s*\);/);
  assert.ok(m, 'expected the MGR-release startTween(...) call in main.js, reading `from` from a captured worldPos and `to` from mgrRelease.pos');

  // worldPos must come from entry.mesh.getWorldPosition, called BEFORE the reparent (mgrGroup
  // -> tiltGroup) that would otherwise change what "local" means for this mesh.
  const worldPosIdx = MAIN_JS_SRC.indexOf('entry.mesh.getWorldPosition(worldPos);');
  const reparentIdx = MAIN_JS_SRC.indexOf('mgrGroup.remove(entry.mesh);\n    tiltGroup.add(entry.mesh);\n    entry.mgrMounted = false;');
  assert.ok(worldPosIdx >= 0, 'expected entry.mesh.getWorldPosition(worldPos) in main.js');
  assert.ok(reparentIdx > worldPosIdx, 'getWorldPosition must be captured BEFORE the mgrGroup -> tiltGroup reparent, or it reads the wrong transform');
});

test('merry-go-round eject (unlit pass-through) presentation tween: from reads the real capture-zone centre, to reads the real release point', () => {
  const m = MAIN_JS_SRC.match(/entry\.presentationTween = startTween\(merryGoRound\.centre,\s*\{ x: mgrRelease\.pos\.x, y: mgrRelease\.pos\.y, z: 0 \},\s*elapsedS\);/);
  assert.ok(m, 'expected the MGR-eject (never-mounted) startTween(...) call in main.js, reading `from` from merryGoRound.centre and `to` from mgrRelease.pos — the same real objects checkCaptures/computeMergeGoRoundRelease already used');
});

test('render loop consumes the presentation tween by the SAME interpolation function the tween tests pin, not a separate re-implementation', () => {
  assert.ok(
    MAIN_JS_SRC.includes("import { startTween, tweenPosition } from './render/presentationTween.js';"),
    'main.js must import startTween/tweenPosition from render/presentationTween.js rather than reimplementing interpolation inline'
  );
  const m = MAIN_JS_SRC.match(/const tp = tweenPosition\(entry\.presentationTween, ([^)]+)\);/);
  assert.ok(m, 'expected the render loop to call tweenPosition(entry.presentationTween, elapsedS)');
  assert.equal(m[1].trim(), 'elapsedS', `tweenPosition must be evaluated at the real frame clock elapsedS, got "${m[1].trim()}"`);
  assert.ok(
    /const p = toSceneVec\(x, y, entry\.phys\.radius \+ z\);/.test(MAIN_JS_SRC),
    'expected the interpolated (x,y,z) to be fed through the SAME toSceneVec(...) scene-mapping every other ball position uses'
  );
});
