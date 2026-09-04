// Guard for the 2026-09-04 mirrored-diagonal-geometry bug: src/main.js draws wall
// segments and slingshot bars with `mesh.rotation.y = -Math.atan2(dy, dx)`, but
// toSceneVec (render/scene.js) already maps table (x, y) -> scene (x, 0, -y), and a
// three.js Y-rotation by angle a sends local +x to scene (cos a, 0, -sin a), which
// maps back to table direction (cos a, +sin a) — so the correct sign is
// `+Math.atan2(dy, dx)`; the leading minus double-counts the flip toSceneVec already
// applies. An AXIS-ALIGNED segment cannot catch this: reflecting a centred
// axis-aligned box is a geometric no-op, which is exactly why this survived —
// every wall/slingshot test asserted so far happens to use one. Only a diagonal
// segment (dx != 0 and dy != 0) distinguishes the two sign conventions.
//
// main.js can't be imported directly under `node --test` — it imports 'three' as a
// bare specifier resolved only by index.html's browser import map (see
// glue-scope.test.mjs) — so this is a source-text extraction (which sign does the
// committed file actually use) combined with real transform arithmetic (does that
// sign's implied world-space geometry match the physics segment's true endpoints),
// using the actual vendored three.js for the rotation math rather than a
// reimplementation of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MAIN_JS = path.join(root, 'src/main.js');

// Duplicated from src/render/scene.js's toSceneVec (that file also imports 'three'
// as a bare specifier and can't be imported here either). Table (x, y) -> scene
// (x, 0, -y).
function toSceneVec(x, y, z = 0) {
  return { x, y: z, z: -y };
}

// A real, diagonal (non-axis-aligned) apron-left wall segment, per the operator's
// numeric check against the physics geometry.
const DIAGONAL_SEGMENT = { a: { x: -0.257, y: 0.300 }, b: { x: -0.205, y: 0.120 } };

function extractRotationSign(line) {
  const m = line.match(/=\s*(-)?\s*Math\.atan2\(dy,\s*dx\)/);
  assert.ok(m, `expected a "= [-]Math.atan2(dy, dx)" rotation assignment, got: "${line.trim()}"`);
  return m[1] === '-' ? -1 : 1;
}

function findRotationLine(src, varName) {
  const line = src.split('\n').find(
    (l) => l.includes(`${varName}.rotation.y`) && l.includes('atan2')
  );
  assert.ok(line, `expected to find a "${varName}.rotation.y = ...atan2..." line in main.js`);
  return line;
}

/** Endpoint error (metres, scene space) between what `sign * atan2(dy, dx)` implies
 * a box mesh's ends are, and where the physics segment's ends actually are. */
function impliedEndpointError(sign, seg) {
  const dx = seg.b.x - seg.a.x;
  const dy = seg.b.y - seg.a.y;
  const len = Math.hypot(dx, dy);
  const midScene = toSceneVec((seg.a.x + seg.b.x) / 2, (seg.a.y + seg.b.y) / 2, 0);

  const obj = new THREE.Object3D();
  obj.position.set(midScene.x, midScene.y, midScene.z);
  obj.rotation.y = sign * Math.atan2(dy, dx);
  obj.updateMatrixWorld(true);

  const half = new THREE.Vector3(len / 2, 0, 0).applyQuaternion(obj.quaternion);
  const endPlus = obj.position.clone().add(half); // local +x end -> should be seg.b
  const endMinus = obj.position.clone().sub(half); // local -x end -> should be seg.a

  const sceneA = toSceneVec(seg.a.x, seg.a.y, 0);
  const sceneB = toSceneVec(seg.b.x, seg.b.y, 0);

  const errA = endMinus.distanceTo(new THREE.Vector3(sceneA.x, sceneA.y, sceneA.z));
  const errB = endPlus.distanceTo(new THREE.Vector3(sceneB.x, sceneB.y, sceneB.z));
  return Math.max(errA, errB);
}

test('wall-segment mesh rotation matches physics endpoints for a diagonal segment', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const sign = extractRotationSign(findRotationLine(src, 'mesh'));
  const err = impliedEndpointError(sign, DIAGONAL_SEGMENT);
  assert.ok(
    err < 1e-9,
    `wall-segment rotation sign desyncs rendered geometry from physics for a ` +
    `diagonal segment: endpoint error ${(err * 1000).toFixed(1)}mm (sign=${sign})`
  );
});

test('slingshot bar mesh rotation matches physics endpoints for a diagonal segment', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const sign = extractRotationSign(findRotationLine(src, 'bar'));
  const err = impliedEndpointError(sign, DIAGONAL_SEGMENT);
  assert.ok(
    err < 1e-9,
    `slingshot bar rotation sign desyncs rendered geometry from physics for a ` +
    `diagonal segment: endpoint error ${(err * 1000).toFixed(1)}mm (sign=${sign})`
  );
});
