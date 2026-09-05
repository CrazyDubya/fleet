// Guard for opus2's 2026-09-04 whole-table audit (four of its mismatches that need no design
// judgement, only a fix — the rest are the operator's own calls, untouched here): the operator's
// standard is "true to physics" — the drawn thing IS the physics size. Same defect class as
// PITCH_DEG (constants.js) and the drop-target rotation/width fix: a rendered value and a
// physics value that agree today only by coincidence, because nothing ties them together.
//
// The fix in every case here is to make the render read the SAME value the physics builder
// already produced (merryGoRound.radius, sandbox.captureZone.radius, a zone's own endpoints, a
// pop bumper's own shape.radius) rather than a second, independently-hardcoded literal — the
// strongest form of "shared constant" is not duplicating the number at all. Verified by source-
// text extraction (main.js can't be imported under node --test — bare 'three' specifier, browser-
// only import map — see glue-scope.test.mjs) of the exact expression used, cross-checked against
// the real physics builders (pure data, safely importable here) so a passing test means the
// physics value ITSELF, not a copy of today's number, is what ends up on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMerryGoRound, buildFunLanes, buildPopBumpers, buildTreehouseStandup, buildKickback,
  buildSlingshots, buildSwingSetPosts, buildHopscotchBank, buildSandBank, SWING_SET_APEXES,
} from '../src/table/mechanisms.js';
import { buildSandbox, buildSlideRamp, buildMonkeyBarsRamp, buildTunnelRamp, buildOrbitRamp } from '../src/table/ramps.js';
import * as recess from '../src/table/recess.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MAIN_JS = path.join(root, 'src/main.js');

test('merry-go-round base mesh radius reads the real physics capture radius, not a duplicated literal', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const m = src.match(/const base = new THREE\.Mesh\(new THREE\.CylinderGeometry\(([^,]+),\s*([^,]+),\s*0\.012,\s*20\)/);
  assert.ok(m, 'expected to find the merry-go-round base CylinderGeometry call in main.js');
  const [, topExpr, bottomExpr] = m;
  assert.equal(
    topExpr.trim(), 'merryGoRound.radius',
    `base top radius must read merryGoRound.radius (the physics capture radius), not a hardcoded literal — got "${topExpr.trim()}"`
  );
  assert.equal(
    bottomExpr.trim(), 'merryGoRound.radius',
    `base bottom radius must read merryGoRound.radius, not a hardcoded literal — got "${bottomExpr.trim()}"`
  );

  // Physics unchanged, per instructions — sanity check only.
  const mgr = buildMerryGoRound();
  assert.ok(Math.abs(mgr.radius - 0.075) < 1e-4, `expected merry-go-round physics radius 75mm, got ${mgr.radius * 1000}mm`);
});

test('sandbox pit mesh radius reads the real physics capture radius, not a multiple of it', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const m = src.match(/const pit = coloredMesh\(new THREE\.CircleGeometry\(([^,]+),\s*20\)/);
  assert.ok(m, 'expected to find the sandbox pit CircleGeometry call in main.js');
  assert.equal(
    m[1].trim(), 'sandbox.captureZone.radius',
    `pit radius must read sandbox.captureZone.radius directly (no multiplier) — a ball visibly ` +
    `on the drawn sand must be within the scoop's real capture radius — got "${m[1].trim()}"`
  );

  // Physics unchanged, per instructions — sanity check only.
  const sandbox = buildSandbox();
  assert.ok(
    Math.abs(sandbox.captureZone.radius - 0.022) < 1e-4,
    `expected sandbox_entry physics radius 22mm, got ${sandbox.captureZone.radius * 1000}mm`
  );
});

test('FUN lane lamp box width reads the zone\'s real span, not a duplicated literal', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const hasWidthCalc = /const width = Math\.hypot\(f\.zone\.b\.x - f\.zone\.a\.x, f\.zone\.b\.y - f\.zone\.a\.y\);/.test(src);
  const m = src.match(/const bar = new THREE\.Mesh\(new THREE\.BoxGeometry\(([^,]+),\s*0\.01,\s*0\.006\)/);
  assert.ok(m, 'expected to find the FUN lane bar BoxGeometry call in main.js');
  assert.ok(
    hasWidthCalc,
    'expected a "const width = Math.hypot(f.zone.b.x - f.zone.a.x, f.zone.b.y - f.zone.a.y);" ' +
    'computing the lamp box width from the zone\'s own real endpoints'
  );
  assert.equal(
    m[1].trim(), 'width',
    `lamp box width must come from the zone's own span, not a hardcoded literal — got "${m[1].trim()}"`
  );

  // Physics unchanged, per instructions — sanity check only (also confirms the "36mm, same
  // 30-vs-36 pairing as the drop targets" figure opus2 measured).
  const funLanes = buildFunLanes();
  const span = Math.hypot(funLanes[0].zone.b.x - funLanes[0].zone.a.x, funLanes[0].zone.b.y - funLanes[0].zone.a.y);
  assert.ok(Math.abs(span - 0.036) < 1e-4, `expected FUN lane physics span 36mm, got ${span * 1000}mm`);
});

test('pop bumper skirt mesh radius reads each bumper\'s real physics collision radius', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');

  const fnMatch = src.match(/function buildPopBumperMesh\(([^)]*)\)/);
  assert.ok(fnMatch, 'expected to find "function buildPopBumperMesh(...)" in main.js');
  assert.ok(
    /(^|,)\s*radius\s*($|,)/.test(fnMatch[1]),
    `buildPopBumperMesh must accept a radius parameter — got "(${fnMatch[1]})"`
  );

  const skirtMatch = src.match(/const skirt = coloredMesh\(new THREE\.CylinderGeometry\(([^,]+),\s*([^,]+),\s*0\.006,\s*16\)/);
  assert.ok(skirtMatch, 'expected to find the pop bumper skirt CylinderGeometry call in main.js');
  assert.equal(
    skirtMatch[1].trim(), 'radius',
    `skirt cylinder top radius must be the passed-in physics radius, not a hardcoded literal — got "${skirtMatch[1].trim()}"`
  );
  assert.equal(
    skirtMatch[2].trim(), 'radius',
    `skirt cylinder bottom radius must be the passed-in physics radius, not a hardcoded literal — got "${skirtMatch[2].trim()}"`
  );

  const callSiteMatch = src.match(/buildPopBumperMesh\(p\.name,\s*p\.centre,\s*([^)]+)\)/);
  assert.ok(callSiteMatch, 'expected the call site to pass a per-bumper radius argument to buildPopBumperMesh');
  assert.equal(
    callSiteMatch[1].trim(), 'p.shape.radius',
    `call site must pass the bumper's own p.shape.radius — got "${callSiteMatch[1].trim()}"`
  );

  // Physics unchanged, per instructions — sanity check only.
  const popBumpers = buildPopBumpers();
  for (const p of popBumpers) {
    assert.ok(
      Math.abs(p.shape.radius - 0.03) < 1e-4,
      `expected pop bumper "${p.name}" physics radius 30mm, got ${p.shape.radius * 1000}mm`
    );
  }
});

// opus2's final audit on 8473654: the table is exact everywhere except one ±2.1mm shape-
// representation mismatch — the treehouse trunk was a 20x20mm BoxGeometry drawn over a real
// r=12mm Circle collider (square corners extend past the circle, a ball passes through them;
// flats sit inside it, a ball bounces off air the collider isn't actually there for). The roof
// cone is unaffected — it's overhead (see its own height-clearance comment at the mesh) and
// stays a cone; only the trunk (the actual collider) needs to read the physics radius.
test('treehouse trunk mesh is a cylinder at the real physics collision radius, not a box', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const m = src.match(/const trunk = coloredMesh\(new THREE\.CylinderGeometry\(([^,]+),\s*([^,]+),\s*0\.03,\s*\d+\)/);
  assert.ok(m, 'expected to find "const trunk = coloredMesh(new THREE.CylinderGeometry(radius, radius, 0.03, segments)..." in main.js');
  assert.equal(
    m[1].trim(), 'treehouse.shape.radius',
    `trunk cylinder top radius must read treehouse.shape.radius, not a hardcoded literal — got "${m[1].trim()}"`
  );
  assert.equal(
    m[2].trim(), 'treehouse.shape.radius',
    `trunk cylinder bottom radius must read treehouse.shape.radius, not a hardcoded literal — got "${m[2].trim()}"`
  );

  // Physics unchanged, per instructions — sanity check only.
  const treehouse = buildTreehouseStandup();
  assert.ok(
    Math.abs(treehouse.shape.radius - 0.012) < 1e-4,
    `expected treehouse physics radius 12mm, got ${treehouse.shape.radius * 1000}mm`
  );
});

test('kickback mesh reads the real physics collision geometry, not a duplicated literal', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const m = src.match(/function buildKickbackMesh\(centre, radius\) \{\s*\n\s*const mesh = new THREE\.Mesh\(new THREE\.CylinderGeometry\(([^,]+),\s*([^,]+),/);
  assert.ok(m, 'expected "function buildKickbackMesh(centre, radius) { const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, ...) in main.js');
  assert.equal(m[1].trim(), 'radius', `kickback cylinder top radius must be the passed-in physics radius, not a hardcoded literal — got "${m[1].trim()}"`);
  assert.equal(m[2].trim(), 'radius', `kickback cylinder bottom radius must be the passed-in physics radius, not a hardcoded literal — got "${m[2].trim()}"`);

  const callSiteMatch = src.match(/(?:const \w+ = )?buildKickbackMesh\((kickback\.[^,]+),\s*([^)]+)\)/);
  assert.ok(callSiteMatch, 'expected the call site to pass centre and radius arguments to buildKickbackMesh');
  assert.equal(callSiteMatch[1].trim(), 'kickback.centre', `call site must pass kickback.centre — got "${callSiteMatch[1].trim()}"`);
  assert.equal(callSiteMatch[2].trim(), 'kickback.shape.radius', `call site must pass kickback.shape.radius, the real physics collision radius — got "${callSiteMatch[2].trim()}"`);

  // Physics unchanged, per instructions — sanity check only.
  const kickback = buildKickback();
  assert.ok(Math.abs(kickback.shape.radius - 0.012) < 1e-4, `expected kickback physics radius 12mm, got ${kickback.shape.radius * 1000}mm`);
});

// 2026-09-05 — extended from a handful of special cases to every mesh builder on the table
// (fs2's coverage audit, haiku-fs2/20260905-catchable-vs-needs-harness.md: "the single largest
// win... one pass through every mesh builder"). Same method as every test above: source-text
// extraction of the exact expression a builder or call site uses, checked against the real
// physics data — never a runtime render. Closes 12 of fs2's 59 blanks; see the two comment
// blocks at the end of this file for the ones a source audit legitimately cannot reach and why.

test('every wall (including the outlane/inlane dividers) renders its length, position and angle from its own real segment endpoints', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  // One generic loop draws every tag in wallSegments — apron, lane guides, and the
  // outlane-divider-left/-right walls added 2026-09-04 all go through this SAME code path, so
  // one check here covers both "walls" and "outlane dividers" from fs2's list; there is no
  // separate divider-specific rendering code to audit.
  const loopMatch = src.match(/for \(const seg of wallSegments\) \{([\s\S]*?)\n\}/);
  assert.ok(loopMatch, 'expected "for (const seg of wallSegments) { ... }" in main.js');
  const body = loopMatch[1];
  assert.match(body, /const dx = seg\.b\.x - seg\.a\.x;/, 'wall length must be derived from the segment\'s own endpoints, not a literal');
  assert.match(body, /const dy = seg\.b\.y - seg\.a\.y;/);
  assert.match(body, /const len = Math\.hypot\(dx, dy\);/);
  assert.match(body, /new THREE\.BoxGeometry\(len,/, 'the box mesh\'s length must be the computed real length, not a duplicated literal');
  assert.match(body, /mesh\.rotation\.y = Math\.atan2\(dy, dx\);/, 'wall angle must read the segment\'s own real direction, not a hardcoded rotation');

  // Physics unchanged, per instructions — sanity check only, and confirms the dividers really
  // are in this same list (not a separate, unaudited array).
  const walls = recess.buildWalls();
  assert.ok(walls.some((w) => w.tag === 'outlane-divider-left'), 'expected outlane-divider-left among recess.buildWalls()\'s own segments — the wall loop above renders exactly this list');
  assert.ok(walls.some((w) => w.tag === 'outlane-divider-right'));
});

test('slingshot mesh bars read length, position and angle from their own real collision segments', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const fnMatch = src.match(/function buildSlingshotMesh\(segments\) \{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'expected "function buildSlingshotMesh(segments) { ... }" in main.js');
  const body = fnMatch[1];
  assert.match(body, /const dx = seg\.b\.x - seg\.a\.x, dy = seg\.b\.y - seg\.a\.y;/);
  assert.match(body, /const len = Math\.hypot\(dx, dy\);/);
  assert.match(body, /new THREE\.BoxGeometry\(len,/, 'slingshot bar length must be the real computed length, not a literal');
  assert.match(body, /bar\.rotation\.y = Math\.atan2\(dy, dx\);/);

  const callSiteMatches = [...src.matchAll(/buildSlingshotMesh\((slingshots\.\w+)\)/g)];
  assert.ok(callSiteMatches.some((m) => m[1] === 'slingshots.left'), 'expected a call site passing slingshots.left');
  assert.ok(callSiteMatches.some((m) => m[1] === 'slingshots.right'), 'expected a call site passing slingshots.right');

  // Physics unchanged, per instructions — sanity check only. Pinned to 2 segments per side
  // (2026-09-05, a file-thread sweep found `> 0` here — a side reduced to a single segment,
  // half the real collision shape, would still pass), the real count each side actually has.
  const slingshots = buildSlingshots();
  assert.equal(slingshots.left.length, 2);
  assert.equal(slingshots.right.length, 2);
});

test('hopscotch and sand drop-target plates render position and angle from each target\'s own real shape, not a shared literal', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const fnMatch = src.match(/function buildDropBankMeshes\(bank, color\) \{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'expected "function buildDropBankMeshes(bank, color) { ... }" in main.js');
  const body = fnMatch[1];
  assert.match(body, /toSceneVec\(t\.centre\.x, t\.centre\.y,/, 'plate position must read the target\'s own real centre, not a duplicated literal');
  assert.match(body, /const dx = t\.shape\.b\.x - t\.shape\.a\.x;/);
  assert.match(body, /const dy = t\.shape\.b\.y - t\.shape\.a\.y;/);
  assert.match(body, /plate\.rotation\.y = Math\.atan2\(dy, dx\);/, 'plate angle must read the target\'s own real collision segment, not a hardcoded rotation');

  assert.match(src, /buildDropBankMeshes\(hopscotch,/, 'expected a call site building the hopscotch bank\'s meshes from the real hopscotch object');
  assert.match(src, /buildDropBankMeshes\(sandBank,/, 'expected a call site building the sand bank\'s meshes from the real sandBank object');

  // Physics unchanged, per instructions — sanity check only.
  const hopscotch = buildHopscotchBank();
  const sandBank = buildSandBank();
  assert.ok(hopscotch.targets.length > 0 && sandBank.targets.length > 0);
});

test('swing-set side posts and top crossbars render position from the real physics apex data, not a duplicated literal', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const postLoop = src.match(/for \(const p of swingSetPosts\) \{([\s\S]*?)\n\}/);
  assert.ok(postLoop, 'expected "for (const p of swingSetPosts) { ... }" in main.js');
  assert.match(postLoop[1], /toSceneVec\(p\.centre\.x, p\.centre\.y,/, 'side-post mesh position must read the post\'s own real centre — swingSetPosts is the exact array physics collides against');

  const barLoop = src.match(/for \(const apex of mech\.SWING_SET_APEXES\) \{([\s\S]*?)\n\}/);
  assert.ok(barLoop, 'expected "for (const apex of mech.SWING_SET_APEXES) { ... }" in main.js');
  assert.match(barLoop[1], /toSceneVec\(apex\.x, apex\.y \+ 0\.02,/, 'crossbar position must read the shared SWING_SET_APEXES data, not a second, independently-authored position list');

  // Physics unchanged, per instructions — sanity check only.
  const posts = buildSwingSetPosts();
  assert.equal(posts.length, 4);
  assert.equal(SWING_SET_APEXES.length, 2);
});

test('THE SLIDE, MONKEY BARS, THE TUNNEL and THE ORBIT ramp meshes are all built from their own real ramp.points, via the one shared segmentSteps walker', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  // All four ramp meshes route through this one helper, which derives mid/dir/len purely from
  // the `points` array it's handed — no per-ramp mesh function has its own hardcoded geometry
  // to duplicate a literal in. The real audit is therefore at the CALL SITE: is each builder
  // actually handed that ramp's own real .ramp.points, not a copy or a stand-in array?
  assert.match(src, /function segmentSteps\(points, fn\) \{/, 'expected the shared segmentSteps(points, fn) walker in main.js');

  const calls = {
    buildSlideMesh: 'slide.ramp.points',
    buildMonkeyBarsMesh: 'monkeyBars.ramp.points',
    buildTunnelMesh: 'tunnel.ramp.points',
    buildOrbitMesh: 'orbit.ramp.points',
  };
  for (const [fn, expectedArg] of Object.entries(calls)) {
    const callSite = src.match(new RegExp(`tiltGroup\\.add\\(${fn}\\(([^)]+)\\)\\)`));
    assert.ok(callSite, `expected "tiltGroup.add(${fn}(...))" in main.js`);
    assert.equal(callSite[1].trim(), expectedArg, `${fn} must be called with ${expectedArg}, the real ramp's own tracked points — got "${callSite[1].trim()}"`);
  }

  // Physics unchanged, per instructions — sanity check only.
  // Pinned to each ramp's actual measured point count (2026-09-05, a file-thread sweep found
  // `> 1` here — a ramp collapsed to 2 points would still pass despite its real geometry being
  // entirely gone). `segmentSteps` walks every point, so a truncated array silently drops most
  // of the drawn track without any of these tests noticing under the old threshold.
  assert.equal(buildSlideRamp().ramp.points.length, 4);
  assert.equal(buildMonkeyBarsRamp().ramp.points.length, 4);
  assert.equal(buildTunnelRamp().ramp.points.length, 5);
  assert.equal(buildOrbitRamp().ramp.points.length, 6);
});

test('the SANDBOX pit mesh position reads the real physics capture zone centre, not a duplicated literal (extends the existing radius-only check)', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const m = src.match(/const p = toSceneVec\(sandbox\.captureZone\.centre\.x, sandbox\.captureZone\.centre\.y,\s*0\)/);
  assert.ok(m, 'expected the SANDBOX group\'s own position to read sandbox.captureZone.centre.x/y directly, not a hardcoded position');

  // Physics unchanged, per instructions — sanity check only.
  const sandbox = buildSandbox();
  assert.ok(sandbox.captureZone.centre && typeof sandbox.captureZone.radius === 'number');
});

// PINWHEEL SPINNER — fs2 listed this as one of the 12 catchable blanks ("blade mesh exists at
// zone position"), but it's already covered, just not in THIS file: test/spinner-span.test.mjs
// asserts the rendered blade mesh reads its length from mech.SPINNER_BLADE_LENGTH (not a
// duplicated literal) and that both spinner zones span exactly that length. Not duplicated
// here — fs2's list predates that file's own coverage, this is a correction, not a gap.

// The following three mesh builders were flagged by fs2 (haiku-fs2/
// 20260905-catchable-vs-needs-harness.md, "Mesh-Collider Runtime Alignment") as needing a
// RUNTIME geometry comparison, not a source audit, and that holds — named here, not skipped
// silently, per the operator's explicit instruction:
//
// - Pop bumpers (tested above, "pop bumper skirt mesh radius..."): the source audit already
//   confirms buildPopBumperMesh's skirt radius parameter and its call site both read
//   p.shape.radius, not a literal. What a source audit CANNOT catch: a bug inside THREE.js
//   geometry construction itself, or a future edit to buildPopBumperMesh that computes a
//   *derived* value (a scale factor, an offset) from the radius rather than using it directly —
//   the source pattern would still match "reads p.shape.radius" while the built mesh's actual
//   radius at runtime silently diverged. Needs: load the built mesh, read its geometry's real
//   bounding radius, compare numerically against p.shape.radius.
// - Treehouse (tested above, "treehouse trunk mesh..."): same class of gap — the trunk radius
//   parameter is read correctly per the source audit, but nothing here confirms the resulting
//   CylinderGeometry's actual runtime radius equals it once built.
// - Kickback (tested above, "kickback mesh..."): same again — centre/radius are read correctly
//   at the source level; a runtime check would additionally catch e.g. a stray `.scale` applied
//   to the mesh after construction, which no source-text regex here would ever see.
//
// All three need the SAME missing capability: a runtime harness that instantiates the mesh (or
// a headless-DOM/three.js stand-in) and reads its actual geometry back, not a second source
// audit — building that harness is out of scope for this pass, which is a source-code audit
// extended to more call sites, not a new kind of test.
