// RECESS pinball sandbox — a free-play physics playground for the real table. No rules, no
// scoring, no multiball, no modes, no plunger: this loads the REAL RECESS physics and table
// geometry by relative import from ../pinball/src/ (same pattern as
// games/pinball-lab/src/instrument.js) and lets you drop balls onto it directly.
//
// Physics/table geometry is imported, never copied — pinball fixes (wall/slingshot/drop-target
// rotation and sizing, PITCH_DEG, etc.) land here automatically the next time this file is
// loaded, with zero duplication to keep in sync. See test/boundary.test.mjs for the guard: no
// file under games/pinball-sandbox is ever imported by games/pinball, and nothing under
// games/pinball/src/physics or /table is duplicated locally here.
import * as THREE from 'three';
import { createScene, toSceneVec } from '../../pinball/src/render/scene.js';
import {
  createWorld, setLayerPrimitives, addBall, removeBall, addFlipper, advance,
} from '../../pinball/src/physics/world.js';
import { createFlipper } from '../../pinball/src/physics/flipper.js';
import { BALL_RADIUS, PITCH_DEG } from '../../pinball/src/physics/constants.js';
import * as recess from '../../pinball/src/table/recess.js';
import * as mech from '../../pinball/src/table/mechanisms.js';
import { wireInput } from '../../pinball/src/ui/input.js';

const canvas = document.getElementById('view');
const readoutEl = document.getElementById('readout');
const { scene, camera, renderer, tiltGroup, resize } = createScene(canvas);
tiltGroup.rotation.x = -THREE.MathUtils.degToRad(PITCH_DEG);
camera.position.set(0, 1.0, 0.65);
camera.lookAt(0, 0, -0.5);

function resizeToWindow() {
  resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resizeToWindow);
resizeToWindow();

// --- Floor, for visual orientation only (not raycast against — picking uses an analytic
// plane in tiltGroup-local space, see pickTablePoint below). ---
const floorGeo = new THREE.PlaneGeometry(recess.LANE_OUTER_X * 2, recess.HEIGHT);
const floorMat = new THREE.MeshLambertMaterial({ color: 0x1c2a20 });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0, -recess.HEIGHT / 2);
tiltGroup.add(floor);

// --- World + real table geometry -----------------------------------------------------------
// Same table the game plays on: walls, flippers, pop bumpers, slingshots, and both drop-target
// banks (still and un-droppable here — there's no rules layer to ever drop or reset them, so
// they simply sit at their physics geometry as fixed colliders). Ramps, the SANDBOX scoop and
// the merry-go-round are deliberately out of scope for this first slice — see the handoff's
// "next slice" list.
const world = createWorld();
const wallSegments = recess.buildWalls();
const popBumpers = mech.buildPopBumpers();
const slingshots = mech.buildSlingshots();
const hopscotch = mech.buildHopscotchBank();
const sandBank = mech.buildSandBank();
const treehouse = mech.buildTreehouseStandup();

setLayerPrimitives(world, 'playfield', [
  ...wallSegments.map((shape) => ({ shape })),
  ...popBumpers.map((p) => ({ shape: p.shape })),
  ...slingshots.left.map((shape) => ({ shape })),
  ...slingshots.right.map((shape) => ({ shape })),
  ...hopscotch.targets.map((t) => ({ shape: t.shape })),
  ...sandBank.targets.map((t) => ({ shape: t.shape })),
  { shape: treehouse.shape },
]);

const flippers = {};
for (const cfg of recess.buildFlipperConfigs()) {
  const flipper = createFlipper(cfg);
  addFlipper(world, flipper);
  flippers[cfg.name] = flipper;
}

// --- Minimal generic table renderer --------------------------------------------------------
// Not a copy of games/pinball/src/main.js's stylized per-mechanism art (wood-tone rails,
// textured playfield, swing-set posts, etc.) — main.js has no exported mesh-builder functions
// to import, and games/pinball/** must not be modified to add any. Instead this draws the
// SAME physics geometry generically by shape kind (every 'segment' as a box, every 'circle' as
// a cylinder), using the identical rotation convention the wall/slingshot/drop-target fix
// established: rotation.y = +Math.atan2(dy, dx) — toSceneVec already flips z, no negation.
const segmentMat = new THREE.MeshStandardMaterial({ color: 0x8fa0b8, metalness: 0.4, roughness: 0.5 });
const circleMat = new THREE.MeshStandardMaterial({ color: 0xd98f3a, metalness: 0.2, roughness: 0.6 });

function addSegmentMesh(seg) {
  const dx = seg.b.x - seg.a.x;
  const dy = seg.b.y - seg.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const geo = new THREE.BoxGeometry(len, 0.03, 0.01);
  const mesh = new THREE.Mesh(geo, segmentMat);
  const p = toSceneVec((seg.a.x + seg.b.x) / 2, (seg.a.y + seg.b.y) / 2, 0.015);
  mesh.position.set(p.x, p.y, p.z);
  mesh.rotation.y = Math.atan2(dy, dx);
  tiltGroup.add(mesh);
}

function addCircleMesh(shape) {
  const geo = new THREE.CylinderGeometry(shape.radius, shape.radius, 0.02, 20);
  const mesh = new THREE.Mesh(geo, circleMat);
  const p = toSceneVec(shape.centre.x, shape.centre.y, 0.01);
  mesh.position.set(p.x, p.y, p.z);
  tiltGroup.add(mesh);
}

for (const seg of wallSegments) addSegmentMesh(seg);
for (const seg of [...slingshots.left, ...slingshots.right]) addSegmentMesh(seg);
for (const t of [...hopscotch.targets, ...sandBank.targets]) addSegmentMesh(t.shape);
for (const p of popBumpers) addCircleMesh(p.shape);
addCircleMesh(treehouse.shape);

const flipperMat = new THREE.MeshLambertMaterial({ color: 0xcc3333 });
for (const flipper of Object.values(flippers)) {
  const geo = new THREE.BoxGeometry(flipper.length, 0.012, flipper.radius * 2);
  geo.translate(flipper.length / 2, 0, 0);
  const mesh = new THREE.Mesh(geo, flipperMat);
  const p = toSceneVec(flipper.pivot.x, flipper.pivot.y, 0.02);
  mesh.position.set(p.x, p.y, p.z);
  tiltGroup.add(mesh);
  flipper._mesh = mesh;
}

// --- Balls -----------------------------------------------------------------------------------
const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 24, 16);
const ballMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, metalness: 0.7, roughness: 0.25 });
let ballIdSeq = 0;
let balls = [];
let mostRecentBall = null;

function spawnBall(pos, vel) {
  const phys = addBall(world, {
    id: `s${ballIdSeq++}`, pos: { ...pos }, vel: { ...vel },
    radius: BALL_RADIUS, active: true, layer: 'playfield', captured: false, z: 0,
  });
  const mesh = new THREE.Mesh(ballGeo, ballMat);
  tiltGroup.add(mesh);
  const entry = { phys, mesh, peakSpeed: Math.hypot(vel.x, vel.y) };
  balls.push(entry);
  mostRecentBall = entry;
  return entry;
}

function despawnBall(entry) {
  removeBall(world, entry.phys.id);
  tiltGroup.remove(entry.mesh);
  balls = balls.filter((b) => b !== entry);
  if (mostRecentBall === entry) mostRecentBall = balls[balls.length - 1] ?? null;
}

function clearAllBalls() {
  for (const entry of [...balls]) despawnBall(entry);
}

// --- Input: flippers (reused verbatim), Clear key, click/drag ball placement ----------------
wireInput(canvas, { flippers });

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyC') clearAllBalls();
});

// Picking: an analytic plane at tiltGroup-local y = 0 (the playfield plane — see
// render/scene.js's toSceneVec doc comment: "local y = 0 (playfield plane)"), transformed into
// world space by tiltGroup's current matrix, so this stays correct regardless of the cabinet
// pitch applied above. Table (x, y) is the exact inverse of toSceneVec: x = local.x,
// y = -local.z.
const raycaster = new THREE.Raycaster();
const localPickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function pickTablePoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  tiltGroup.updateMatrixWorld(true);
  const worldPlane = localPickPlane.clone().applyMatrix4(tiltGroup.matrixWorld);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(worldPlane, hit)) return null;
  const local = tiltGroup.worldToLocal(hit.clone());
  return { x: local.x, y: -local.z };
}

// Drag-to-launch: the raw table-space drag vector (metres) scaled to a velocity. Tuned so a
// half-table-width drag (~0.13m) gives a brisk few-m/s throw, matching PLUNGER_MAX_SPEED's
// order of magnitude (5.0 m/s) without needing a plunger.
const DRAG_VELOCITY_SCALE = 6;
const DRAG_MIN_DISTANCE = 0.006; // below this, treat as a plain click (ball at rest)

let dragStart = null; // table-space point, or null when not dragging
let dragLine = null;
const dragLineMat = new THREE.LineBasicMaterial({ color: 0xffee66 });

function startDrag(clientX, clientY) {
  const p = pickTablePoint(clientX, clientY);
  if (!p) return;
  dragStart = p;
}

function updateDrag(clientX, clientY) {
  if (!dragStart) return;
  const p = pickTablePoint(clientX, clientY);
  if (!p) return;
  const a = toSceneVec(dragStart.x, dragStart.y, 0.02);
  const b = toSceneVec(p.x, p.y, 0.02);
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(a.x, a.y, a.z),
    new THREE.Vector3(b.x, b.y, b.z),
  ]);
  if (dragLine) {
    tiltGroup.remove(dragLine);
    dragLine.geometry.dispose();
  }
  dragLine = new THREE.Line(geo, dragLineMat);
  tiltGroup.add(dragLine);
  const dx = p.x - dragStart.x, dy = p.y - dragStart.y;
  const speed = Math.hypot(dx, dy) * DRAG_VELOCITY_SCALE;
  dragReadout = `drag: ${speed.toFixed(2)} m/s`;
}

function endDrag(clientX, clientY) {
  if (!dragStart) return;
  const p = pickTablePoint(clientX, clientY) ?? dragStart;
  const dx = p.x - dragStart.x;
  const dy = p.y - dragStart.y;
  const dist = Math.hypot(dx, dy);
  if (dist < DRAG_MIN_DISTANCE) {
    spawnBall(dragStart, { x: 0, y: 0 });
  } else {
    spawnBall(dragStart, { x: dx * DRAG_VELOCITY_SCALE, y: dy * DRAG_VELOCITY_SCALE });
  }
  dragStart = null;
  dragReadout = '';
  if (dragLine) {
    tiltGroup.remove(dragLine);
    dragLine.geometry.dispose();
    dragLine = null;
  }
}

let dragReadout = '';
canvas.addEventListener('pointerdown', (e) => {
  // setPointerCapture can throw for a pointer id the browser doesn't consider active (seen
  // with synthetic events during testing); dragging still works fine without capture, it just
  // stops tracking if the pointer leaves the canvas mid-drag, so this is best-effort.
  try { canvas.setPointerCapture(e.pointerId); } catch { /* best-effort only */ }
  startDrag(e.clientX, e.clientY);
});
canvas.addEventListener('pointermove', (e) => {
  if (dragStart) updateDrag(e.clientX, e.clientY);
});
canvas.addEventListener('pointerup', (e) => {
  endDrag(e.clientX, e.clientY);
});

// --- Frame loop --------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  advance(world, dt);

  for (const entry of [...balls]) {
    if (recess.isDrained(entry.phys)) {
      despawnBall(entry);
      continue;
    }
    const speed = Math.hypot(entry.phys.vel.x, entry.phys.vel.y);
    entry.peakSpeed = Math.max(entry.peakSpeed, speed);
    const p = toSceneVec(entry.phys.pos.x, entry.phys.pos.y, entry.phys.radius + (entry.phys.z || 0));
    entry.mesh.position.set(p.x, p.y, p.z);
  }
  for (const flipper of Object.values(flippers)) {
    flipper._mesh.rotation.y = flipper.angle;
  }

  if (mostRecentBall && balls.includes(mostRecentBall)) {
    const speed = Math.hypot(mostRecentBall.phys.vel.x, mostRecentBall.phys.vel.y);
    readoutEl.textContent =
      `balls: ${balls.length}\n` +
      `speed: ${speed.toFixed(3)} m/s\n` +
      `pos:   (${mostRecentBall.phys.pos.x.toFixed(3)}, ${mostRecentBall.phys.pos.y.toFixed(3)})\n` +
      `peak:  ${mostRecentBall.peakSpeed.toFixed(3)} m/s\n` +
      (dragReadout ? `${dragReadout}\n` : '') +
      `[C] clear all balls`;
  } else {
    readoutEl.textContent =
      (dragReadout ? `${dragReadout}\n` : 'no ball placed yet — click the playfield\n') +
      `[C] clear all balls`;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
