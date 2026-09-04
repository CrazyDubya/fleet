// Guard for opus2's whole-table audit finding: the three ramp entry gates (SLIDE, MONKEY
// BARS, TUNNEL) are 44mm zone spans with no mesh at all — the player can't see where the
// ramp's mouth actually is. Draws each as a thin chrome wire (a cylinder) along the gate's
// own real segment endpoints, same rotation convention as the walls: rotation.y =
// +Math.atan2(dy, dx), never negated. CylinderGeometry's default axis is Y (vertical), unlike
// the walls' BoxGeometry whose long axis is already X (horizontal) — so a FIXED rotation.z =
// -Math.PI/2 lays the wire flat first, before the same yaw the walls use. That extra Z
// rotation carries no sign-convention ambiguity of its own (it's a constant, not derived from
// the segment direction); this test verifies the *combination* actually lands on the real
// endpoints using real vendored three.js, not a hand-derived formula taken on faith.
//
// main.js can't be imported under `node --test` (bare 'three' specifier, browser-only import
// map — see glue-scope.test.mjs), so this is source-text extraction of the exact rotation
// expressions plus real transform arithmetic, same idiom as render-tilt.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';
import { buildSlideRamp, buildMonkeyBarsRamp, buildTunnelRamp } from '../src/table/ramps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MAIN_JS = path.join(root, 'src/main.js');

function toSceneVec(x, y, z = 0) {
  return { x, y: z, z: -y };
}

function findGateWireFunction(src) {
  const start = src.indexOf('function addGateWireMesh');
  assert.ok(start >= 0, 'expected to find "function addGateWireMesh" in main.js');
  const end = src.indexOf('\n}', start);
  return src.slice(start, end);
}

function extractRotationZ(body) {
  const m = body.match(/\.rotation\.z\s*=\s*(-Math\.PI\s*\/\s*2)/);
  assert.ok(m, 'expected a ".rotation.z = -Math.PI / 2" flat-lay rotation in addGateWireMesh');
  return -Math.PI / 2;
}

function extractRotationYSign(body) {
  const m = body.match(/\.rotation\.y\s*=\s*(-)?\s*Math\.atan2\(dy,\s*dx\)/);
  assert.ok(m, 'expected a "[-]Math.atan2(dy, dx)" yaw rotation in addGateWireMesh');
  return m[1] === '-' ? -1 : 1;
}

/** Endpoint error (metres, scene space) implied by a cylinder (default local axis (0,1,0))
 * first flattened by rotationZ, then yawed by `ySign * atan2(dy, dx)` — matching the extracted
 * main.js expression exactly — against the real gate segment's own endpoints. */
function impliedGateEndpointError(gate, rotationZ, ySign) {
  const dx = gate.b.x - gate.a.x;
  const dy = gate.b.y - gate.a.y;
  const len = Math.hypot(dx, dy);
  const mid = toSceneVec((gate.a.x + gate.b.x) / 2, (gate.a.y + gate.b.y) / 2, 0);

  const obj = new THREE.Object3D();
  obj.position.set(mid.x, mid.y, mid.z);
  obj.rotation.z = rotationZ;
  obj.rotation.y = ySign * Math.atan2(dy, dx);
  obj.updateMatrixWorld(true);

  const half = new THREE.Vector3(0, len / 2, 0).applyQuaternion(obj.quaternion);
  const endPlus = obj.position.clone().add(half);
  const endMinus = obj.position.clone().sub(half);

  const sceneA = toSceneVec(gate.a.x, gate.a.y, 0);
  const sceneB = toSceneVec(gate.b.x, gate.b.y, 0);

  const dPlusToB = endPlus.distanceTo(new THREE.Vector3(sceneB.x, sceneB.y, sceneB.z));
  const dPlusToA = endPlus.distanceTo(new THREE.Vector3(sceneA.x, sceneA.y, sceneA.z));
  const dMinusToA = endMinus.distanceTo(new THREE.Vector3(sceneA.x, sceneA.y, sceneA.z));
  const dMinusToB = endMinus.distanceTo(new THREE.Vector3(sceneB.x, sceneB.y, sceneB.z));
  // Either +half->b & -half->a, or the endpoints land swapped (+half->a & -half->b) — both are
  // "the wire spans the segment correctly", so take whichever pairing is smaller.
  return Math.min(Math.max(dPlusToB, dMinusToA), Math.max(dPlusToA, dMinusToB));
}

const GATES = [
  ['slide', buildSlideRamp().gate],
  ['monkeyBars', buildMonkeyBarsRamp().gate],
  ['tunnel', buildTunnelRamp().gate],
];

test('addGateWireMesh uses +Math.atan2(dy, dx) (never negated) for its yaw', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const body = findGateWireFunction(src);
  const sign = extractRotationYSign(body);
  assert.equal(sign, 1, 'gate wire yaw must be +Math.atan2(dy, dx), same convention as the walls');
});

for (const [name, gate] of GATES) {
  test(`${name} gate wire mesh endpoints match the real gate segment`, () => {
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const body = findGateWireFunction(src);
    const rotationZ = extractRotationZ(body);
    const ySign = extractRotationYSign(body);
    const err = impliedGateEndpointError(gate, rotationZ, ySign);
    assert.ok(
      err < 1e-9,
      `${name} gate wire mesh endpoints don't match its real segment: error ${(err * 1000).toFixed(2)}mm`
    );
  });
}

test('all three ramp gates are drawn (addGateWireMesh called for slide/monkeyBars/tunnel)', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  for (const call of ['addGateWireMesh(slide.gate)', 'addGateWireMesh(monkeyBars.gate)', 'addGateWireMesh(tunnel.gate)']) {
    assert.ok(src.includes(call), `expected main.js to call ${call}`);
  }
});
