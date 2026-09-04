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
import { buildMerryGoRound, buildFunLanes, buildPopBumpers, buildTreehouseStandup, buildKickback } from '../src/table/mechanisms.js';
import { buildSandbox } from '../src/table/ramps.js';

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
