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
import { createWorld, addBall, removeBall, addFlipper, advance } from '../../pinball/src/physics/world.js';
import { createFlipper } from '../../pinball/src/physics/flipper.js';
import { BALL_RADIUS, PITCH_DEG } from '../../pinball/src/physics/constants.js';
import * as recess from '../../pinball/src/table/recess.js';
import * as mech from '../../pinball/src/table/mechanisms.js';
import { buildTable, wireTable } from '../../pinball/src/table/assemble.js';
import * as game from '../../pinball/src/game/mechanisms.js';
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
// Every playfield primitive/zone/capture-zone/ramp comes from table/assemble.js's
// buildTable()/wireTable() — the exact same shared module games/pinball/src/main.js calls.
// Before this, the sandbox re-listed builders by hand and fell behind: it never called
// mech.buildSwingSetPosts() or mech.buildSpinners() at all (found by grep, not by the old
// parity test — see test/table-parity.test.mjs). One source of truth now; a builder added to
// the game's assembly is on the sandbox's table on the next load, nothing to re-list.
const world = createWorld();
const table = buildTable();
wireTable(world, table);
const {
  wallSegments, popBumpers, slingshots, hopscotch, sandBank, treehouse,
  slide, monkeyBars, tunnel, sandbox, merryGoRound, mgrRelease,
} = table;

const flippers = {};
for (const cfg of recess.buildFlipperConfigs()) {
  const flipper = createFlipper(cfg);
  addFlipper(world, flipper);
  flippers[cfg.name] = flipper;
}

// SANDBOX scoop: capture-and-release timer only (game/mechanisms.js's createScoop/armScoop/
// tickScoop) — the mechanical part, not a rules decision. Eject math mirrors main.js exactly
// (same sandbox.eject.vel, same capture-radius clearance).
const scoop = game.createScoop();
let scoopHeldSinceS = null;

// The merry-go-round's real behaviour (lock progression toward a 3-ball rules-driven
// multiball release, gated by TREEHOUSE lighting) lives entirely in rules/multiball.js's
// onMerryGoRoundEntry (src/rules/multiball.js:49-89), consumed by rules/game.js:237 — there is
// no fixed hold duration anywhere in the physics/table/game layers this sandbox is allowed to
// use. Per "no locks, no multiball": the sandbox mounts one ball at a time (a second capture
// while occupied is ejected immediately via the same real placement math main.js's
// ejectFromMergeGoRound fallback uses) and releases it after a fixed MGR_HOLD_S — a disclosed
// sandbox-only invention, not a physics or rules value, standing in for what the lock/
// multiball state machine decides in the real game.
let mgrMounted = null; // { entry, mountedAtS } | null
const MGR_HOLD_S = 2.5;
// Rendering-only visual tuning, copied from main.js's own local (unexported) literals for
// visual parity — not physics values, so there's nothing to import.
const MGR_MOUNT_RADIUS = 0.045;
const MGR_BALL_HEIGHT = 0.02;
const MGR_SPIN_S = 0.6; // rad/s, main.js's MGR_SPIN_IDLE — the sandbox has no multiball to spin faster for

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

// Ramps: a generic tube-per-segment renderer walking each ramp's own real `points` (the
// physics track itself), one call per ramp with a different colour for legibility. Not a copy
// of main.js's per-ramp art (box-frame slide, wireform monkey bars, open culvert tunnel) —
// same reasoning as the generic segment/circle renderers above. RAMP_TUBE_RADIUS is a
// rendering-only thickness (ramps have no single physics "radius" to read from — friction and
// pitch, not a tube radius, are what physics/ramp.js actually tracks).
const RAMP_TUBE_RADIUS = 0.02;
function addRampTubeMesh(points, color) {
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.5 });
  for (let i = 0; i < points.length - 1; i++) {
    const a = toSceneVec(points[i].x, points[i].y, points[i].z);
    const b = toSceneVec(points[i + 1].x, points[i + 1].y, points[i + 1].z);
    const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = dir.length();
    if (len < 1e-6) continue;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(RAMP_TUBE_RADIUS, RAMP_TUBE_RADIUS, len, 12), mat);
    tube.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    tiltGroup.add(tube);
  }
}
addRampTubeMesh(slide.ramp.points, 0xf0c927);
addRampTubeMesh(monkeyBars.ramp.points, 0xd8d8d8);
addRampTubeMesh(tunnel.ramp.points, 0x7d6b58);

// THE SANDBOX: pit + rim drawn at the real capture radius, same as main.js post-becbdbe (a
// ball visibly on the sand IS within the scoop's real capture radius).
const SANDBOX_RIM_LIP = 0.006; // rendering-only decorative lip, not a physics quantity
{
  const pit = new THREE.Mesh(
    new THREE.CircleGeometry(sandbox.captureZone.radius, 20),
    new THREE.MeshStandardMaterial({ color: 0xd9c07a })
  );
  pit.rotation.x = -Math.PI / 2;
  const pp = toSceneVec(sandbox.captureZone.centre.x, sandbox.captureZone.centre.y, 0.001);
  pit.position.set(pp.x, pp.y, pp.z);
  tiltGroup.add(pit);
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(sandbox.captureZone.radius, sandbox.captureZone.radius + SANDBOX_RIM_LIP, 20),
    new THREE.MeshStandardMaterial({ color: 0x8a6339 })
  );
  rim.rotation.x = -Math.PI / 2;
  const rp = toSceneVec(sandbox.captureZone.centre.x, sandbox.captureZone.centre.y, 0.0015);
  rim.position.set(rp.x, rp.y, rp.z);
  tiltGroup.add(rim);
}

// THE MERRY-GO-ROUND: base drawn at the real capture radius (merryGoRound.radius), same as
// main.js post-becbdbe. mgrGroup is kept as a top-level reference so a mounted ball's mesh can
// be reparented onto it (to visibly ride the rotation) and back.
const mgrGroup = new THREE.Group();
{
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(merryGoRound.radius, merryGoRound.radius, 0.012, 20),
    new THREE.MeshStandardMaterial({ color: 0xe0a832, metalness: 0.2, roughness: 0.5 })
  );
  base.position.y = 0.006;
  mgrGroup.add(base);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, 0.09, 8),
    new THREE.MeshStandardMaterial({ color: 0xb8b8b8 })
  );
  pole.position.y = 0.05;
  mgrGroup.add(pole);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.03, 8),
    new THREE.MeshStandardMaterial({ color: 0x4a7a3a })
  );
  roof.position.y = 0.1;
  mgrGroup.add(roof);
}
{
  const p = toSceneVec(merryGoRound.centre.x, merryGoRound.centre.y, 0);
  mgrGroup.position.set(p.x, p.y, p.z);
}
tiltGroup.add(mgrGroup);

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

function findBallEntry(physBall) {
  return balls.find((b) => b.phys === physBall) ?? null;
}

function despawnBall(entry) {
  removeBall(world, entry.phys.id);
  // A merry-go-round-mounted ball's mesh is parented under mgrGroup, not tiltGroup.
  if (entry.mgrMounted) mgrGroup.remove(entry.mesh);
  else tiltGroup.remove(entry.mesh);
  balls = balls.filter((b) => b !== entry);
  if (mostRecentBall === entry) mostRecentBall = balls[balls.length - 1] ?? null;
  if (mgrMounted && mgrMounted.entry === entry) mgrMounted = null;
  if (scoop.ball === entry.phys) {
    scoop.ball = null;
    scoop.ejectAt = null;
    scoopHeldSinceS = null;
  }
}

function clearAllBalls() {
  for (const entry of [...balls]) despawnBall(entry);
}

/** Mount a captured ball onto the carousel so it visibly rides the rotation — same reparenting
 * technique as main.js's mountAtMergeGoRound, single slot only (see the "no locks" note above
 * where mgrMounted is declared). */
function mountAtMergeGoRound(entry) {
  tiltGroup.remove(entry.mesh);
  mgrGroup.add(entry.mesh);
  entry.mesh.position.set(MGR_MOUNT_RADIUS, MGR_BALL_HEIGHT, 0);
  entry.mgrMounted = true;
}

/** Hand the ball back to tiltGroup and launch it from the real, pre-computed clear landing
 * point (mgrRelease, from mech.buildEjectionSites -> computeMergeGoRoundRelease) — same
 * function main.js's releaseFromMergeGoRound/ejectFromMergeGoRound use, not reimplemented. */
function releaseFromMergeGoRound(entry, speed) {
  if (entry.mgrMounted) {
    mgrGroup.remove(entry.mesh);
    tiltGroup.add(entry.mesh);
    entry.mgrMounted = false;
  }
  entry.phys.layer = 'playfield';
  entry.phys.z = 0;
  entry.phys.captured = false;
  entry.phys.pos = { x: mgrRelease.pos.x, y: mgrRelease.pos.y };
  entry.phys.vel = { x: mgrRelease.heading.x * speed, y: mgrRelease.heading.y * speed };
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
let elapsedS = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  elapsedS += dt;

  const events = advance(world, dt);

  // Capture handling: the mechanical part only (SANDBOX hold timer, merry-go-round mount) —
  // no scoring, no locks, no multiball. See the declarations above for what's a real reused
  // function vs. a disclosed sandbox-only stand-in.
  for (const event of events) {
    if (event.tag === sandbox.captureZone.tag) {
      const entry = findBallEntry(event.ball);
      if (entry) {
        game.armScoop(scoop, elapsedS, entry.phys);
        scoopHeldSinceS = elapsedS;
      }
    } else if (event.tag === merryGoRound.captureZone.tag) {
      const entry = findBallEntry(event.ball);
      if (!entry) continue;
      if (mgrMounted) {
        // Already riding one ball (single-slot, see "no locks" note) — eject the new capture
        // immediately via the same real placement math, mirroring main.js's
        // ejectFromMergeGoRound fallback for an unlit pass-through capture.
        releaseFromMergeGoRound(entry, 1.4);
      } else {
        mountAtMergeGoRound(entry);
        mgrMounted = { entry, mountedAtS: elapsedS };
      }
    }
  }

  if (game.tickScoop(scoop, elapsedS)) {
    const evel = sandbox.eject.vel;
    const evLen = Math.hypot(evel.x, evel.y) || 1;
    const clear = sandbox.captureZone.radius * 1.3;
    if (scoop.ball) {
      scoop.ball.pos = {
        x: sandbox.captureZone.centre.x + (evel.x / evLen) * clear,
        y: sandbox.captureZone.centre.y + (evel.y / evLen) * clear,
      };
      scoop.ball.vel = { x: evel.x, y: evel.y };
      scoop.ball.captured = false;
    }
    scoopHeldSinceS = null;
  }

  if (mgrMounted && elapsedS >= mgrMounted.mountedAtS + MGR_HOLD_S) {
    releaseFromMergeGoRound(mgrMounted.entry, 1.6);
    mgrMounted = null;
  }
  mgrGroup.rotation.y += MGR_SPIN_S * dt;

  for (const entry of [...balls]) {
    if (entry.mgrMounted) continue; // carried by mgrGroup's own rotation instead
    // A captured (scoop-held) ball is pinned at the zone centre, not drained — but its mesh
    // still needs to follow that pinned position, same as any other ball.
    if (!entry.phys.captured && recess.isDrained(entry.phys)) {
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

  const holdLines = [];
  if (scoopHeldSinceS !== null) holdLines.push(`hold: sandbox ${(elapsedS - scoopHeldSinceS).toFixed(2)}s`);
  if (mgrMounted) holdLines.push(`hold: merry-go-round ${(elapsedS - mgrMounted.mountedAtS).toFixed(2)}s`);
  const holdText = holdLines.length ? holdLines.join('\n') + '\n' : '';

  if (mostRecentBall && balls.includes(mostRecentBall)) {
    const speed = Math.hypot(mostRecentBall.phys.vel.x, mostRecentBall.phys.vel.y);
    readoutEl.textContent =
      `balls: ${balls.length}\n` +
      `speed: ${speed.toFixed(3)} m/s\n` +
      `pos:   (${mostRecentBall.phys.pos.x.toFixed(3)}, ${mostRecentBall.phys.pos.y.toFixed(3)})\n` +
      `peak:  ${mostRecentBall.peakSpeed.toFixed(3)} m/s\n` +
      holdText +
      (dragReadout ? `${dragReadout}\n` : '') +
      `[C] clear all balls`;
  } else {
    readoutEl.textContent =
      holdText +
      (dragReadout ? `${dragReadout}\n` : 'no ball placed yet — click the playfield\n') +
      `[C] clear all balls`;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
