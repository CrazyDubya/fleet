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
import { BALL_RADIUS, PITCH_DEG, E_FLIPPER, FLIPPER, E_WALL, MU, K_DRAG } from '../../pinball/src/physics/constants.js';
import * as recess from '../../pinball/src/table/recess.js';
import * as mech from '../../pinball/src/table/mechanisms.js';
import { buildTable, wireTable } from '../../pinball/src/table/assemble.js';
import * as game from '../../pinball/src/game/mechanisms.js';
import { wireInput } from '../../pinball/src/ui/input.js';
import { SCENARIOS, runScenario, formatReport } from './scenarios.js';

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

// Flippers are (re)built by rebuildFlippers() below, once the flipper mesh geometry exists —
// the SAME object (`flippers`) is mutated in place on every rebuild (never reassigned), so
// wireInput's closures (which read flippers.left/.right/.upperLeft live) keep working across a
// live-panel rebuild with no re-wiring.
const flippers = {};

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
function buildFlipperMesh(flipper) {
  const geo = new THREE.BoxGeometry(flipper.length, 0.012, flipper.radius * 2);
  geo.translate(flipper.length / 2, 0, 0);
  const mesh = new THREE.Mesh(geo, flipperMat);
  const p = toSceneVec(flipper.pivot.x, flipper.pivot.y, 0.02);
  mesh.position.set(p.x, p.y, p.z);
  tiltGroup.add(mesh);
  return mesh;
}

/**
 * (Re)builds every flipper via recess.buildFlipperConfigs(overrides) + createFlipper — the
 * live constants panel's flipper controls (E_FLIPPER, upMs lower/upper, restAngle,
 * activeAngle) all go through this. `overrides` uses buildFlipperConfigs' own override shape
 * (lowerRestAngle/lowerActiveAngle/lowerUpMs/lowerDownMs/upperUpMs/upperDownMs/eFlipper) — a
 * signature buildFlipperConfigs gained specifically for this (games/pinball, a default-
 * preserving widening, not a physics change: recess.buildFlipperConfigs() with no argument is
 * byte-identical to before that parameter existed — see test/builder-overrides.test.mjs).
 * Reused rather than reimplemented because the right flipper's angles mirror the left's
 * (180 - value); recomputing that here would be a copy of physics logic, not a reuse of it.
 *
 * world.flippers is replaced wholesale (no removeFlipper in physics/world.js — an empty array
 * plus re-adding is the whole API surface, and flippers are cheap, stateless-between-rebuilds
 * kinematic objects). Existing meshes are reused by name (geometry/position never change —
 * only length/radius could move a mesh, and neither is panel-tunable), so a rebuild never
 * touches the scene graph once the three meshes exist.
 */
function rebuildFlippers(overrides) {
  world.flippers = [];
  for (const cfg of recess.buildFlipperConfigs(overrides)) {
    const flipper = createFlipper(cfg);
    addFlipper(world, flipper);
    flipper._mesh = flippers[cfg.name]?._mesh ?? buildFlipperMesh(flipper);
    flippers[cfg.name] = flipper;
  }
}
rebuildFlippers();

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
  clearTrail(entry);
  balls = balls.filter((b) => b !== entry);
  if (mostRecentBall === entry) mostRecentBall = balls[balls.length - 1] ?? null;
  if (mgrMounted && mgrMounted.entry === entry) mgrMounted = null;
  // game/mechanisms.js's scoop now holds an array (armScoop pushes, tickScoop ejects every
  // captured ball together — fixed 2026-09-05 after the single-`scoop.ball` field orphaned a
  // second ball captured during the same hold; see scenarios.js's 'scoop-two-balls' doc
  // comment). A despawned ball just needs pruning out of that array if it's in it.
  const idx = scoop.balls.indexOf(entry.phys);
  if (idx !== -1) {
    scoop.balls.splice(idx, 1);
    if (scoop.balls.length === 0) {
      scoop.ejectAt = null;
      scoopHeldSinceS = null;
    }
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

// --- Feel readout: tip-launch speed per flip, against the design doc's 4.5-6.0 m/s band ------
// (opus2 measured 6.31 m/s shipped, 5.47 m/s at upMs 16 — this is what makes that a live,
// watchable number instead of a report). wireInput's onFlipperEdge fires once per activation
// edge (press, not hold) for 'left'/'right' — the upper flipper shares the left key and isn't
// separately edge-tracked, matching ui/input.js's own binding. On each edge, the nearest ball
// within tip reach is tracked for FLIP_WINDOW_S; the peak speed it reaches in that window is
// reported as the launch speed (the true peak — the instant of separation from the flipper —
// happens within a few physics steps of the flip, so a short window after the edge captures
// it without needing to detect the exact separation instant).
const FLIP_BAND = { min: 4.5, max: 6.0 };
const FLIP_WINDOW_S = 0.5;
const flipReadoutEl = document.getElementById('flipReadout');
let flipTracking = []; // { side, ball, startS, peak }
let lastFlipResult = null; // { side, speed, atS }

function onFlipperEdge(side) {
  const flipper = flippers[side];
  if (!flipper) return;
  const reach = flipper.length + flipper.radius + BALL_RADIUS + 0.03;
  let nearest = null, nearestDist = Infinity;
  for (const entry of balls) {
    if (entry.phys.captured || entry.mgrMounted) continue;
    const d = Math.hypot(entry.phys.pos.x - flipper.pivot.x, entry.phys.pos.y - flipper.pivot.y);
    if (d <= reach && d < nearestDist) { nearest = entry; nearestDist = d; }
  }
  if (!nearest) return;
  flipTracking.push({ side, ball: nearest, startS: elapsedS, peak: Math.hypot(nearest.phys.vel.x, nearest.phys.vel.y) });
}

function tickFlipTracking() {
  const stillTracking = [];
  for (const t of flipTracking) {
    if (!balls.includes(t.ball)) continue; // drained/cleared mid-window
    t.peak = Math.max(t.peak, Math.hypot(t.ball.phys.vel.x, t.ball.phys.vel.y));
    if (elapsedS - t.startS < FLIP_WINDOW_S) {
      stillTracking.push(t);
    } else {
      lastFlipResult = { side: t.side, speed: t.peak, atS: elapsedS };
    }
  }
  flipTracking = stillTracking;
}

function drawFlipReadout() {
  if (!lastFlipResult) {
    flipReadoutEl.textContent = 'no flip yet';
    flipReadoutEl.style.color = '#d8e8ff';
    return;
  }
  const { side, speed } = lastFlipResult;
  const inBand = speed >= FLIP_BAND.min && speed <= FLIP_BAND.max;
  flipReadoutEl.style.color = inBand ? '#7fe08a' : '#ff8f6b';
  flipReadoutEl.textContent =
    `${side} flip: ${speed.toFixed(2)} m/s\n` +
    `doc band: ${FLIP_BAND.min.toFixed(1)}-${FLIP_BAND.max.toFixed(1)} m/s ` +
    `[${inBand ? 'in band' : speed > FLIP_BAND.max ? 'over' : 'under'}]`;
}

// --- Trajectory trails: [T] toggles ----------------------------------------------------------
let trailsVisible = false;
const TRAIL_MAX_POINTS = 50;
const trailMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });

function updateTrail(entry) {
  if (!entry.trail) entry.trail = [];
  entry.trail.push(entry.mesh.position.clone());
  if (entry.trail.length > TRAIL_MAX_POINTS) entry.trail.shift();
  if (!trailsVisible || entry.trail.length < 2) {
    if (entry.trailLine) entry.trailLine.visible = false;
    return;
  }
  const n = entry.trail.length;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const age = i / (n - 1); // 0 = oldest, 1 = newest
    colors[i * 3] = 1.0;
    colors[i * 3 + 1] = 0.55 + 0.35 * age;
    colors[i * 3 + 2] = 0.15 * age;
    // fades toward the background colour, not just dim red -> bright yellow, so an old trail
    // segment reads as "fading out" rather than "a different, still-solid colour".
    const fade = 0.15 + 0.85 * age;
    colors[i * 3] *= fade;
    colors[i * 3 + 1] *= fade;
    colors[i * 3 + 2] *= fade;
  }
  const geo = new THREE.BufferGeometry().setFromPoints(entry.trail);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (entry.trailLine) {
    tiltGroup.remove(entry.trailLine);
    entry.trailLine.geometry.dispose();
  }
  entry.trailLine = new THREE.Line(geo, trailMat);
  entry.trailLine.visible = true;
  tiltGroup.add(entry.trailLine);
}

function clearTrail(entry) {
  if (entry.trailLine) {
    tiltGroup.remove(entry.trailLine);
    entry.trailLine.geometry.dispose();
    entry.trailLine = null;
  }
  entry.trail = [];
}

// --- Input: flippers (reused verbatim), Clear key, trail toggle, click/drag ball placement ---
wireInput(canvas, { flippers, onFlipperEdge });

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyC') clearAllBalls();
  if (e.code === 'KeyT') {
    trailsVisible = !trailsVisible;
    if (!trailsVisible) for (const entry of balls) clearTrail(entry);
  }
});

// --- Live constants panel -------------------------------------------------------------------
// Every default is read FROM physics/constants.js (imported above), never restated: the panel
// literally cannot drift from the shipped values, because it has no second copy of them to
// drift from. Applying a change never reloads the page:
//   - flipper fields (E_FLIPPER, upMs lower/upper, restAngle, activeAngle) -> rebuildFlippers()
//   - E_WALL -> mutated in place on the real wall Segment shapes already sitting in
//     world.layers.get('playfield') (the same objects wireTable() wired in — table.wallSegments
//     IS that data, not a copy of it), so the very next collision reads the new value; no
//     rebuild, no risk of stale references to sandbox/merryGoRound/etc. from a full re-assembly
//   - MU, K_DRAG -> mutated in place on world.tuning, which physics/solver.js already reads
//     live every substep (world.js:176) — the "tuning object" the dispatch asked for
const live = {
  eFlipper: E_FLIPPER,
  lowerUpMs: FLIPPER.lower.upMs,
  upperUpMs: FLIPPER.upper.upMs,
  lowerRestAngle: FLIPPER.lower.restAngle,
  lowerActiveAngle: FLIPPER.lower.activeAngle,
  eWall: E_WALL,
  mu: MU,
  kDrag: K_DRAG,
};

function applyEWall(value) {
  for (const seg of wallSegments) seg.restitution = value;
}

function applyTuning() {
  world.tuning.mu = live.mu;
  world.tuning.kDrag = live.kDrag;
}

function applyFlippers() {
  rebuildFlippers({
    lowerRestAngle: live.lowerRestAngle,
    lowerActiveAngle: live.lowerActiveAngle,
    lowerUpMs: live.lowerUpMs,
    upperUpMs: live.upperUpMs,
    eFlipper: live.eFlipper,
  });
}

const PANEL_FIELDS = [
  { key: 'eFlipper', label: 'E_FLIPPER', min: 0.3, max: 1.0, step: 0.01, apply: applyFlippers },
  { key: 'lowerUpMs', label: 'upMs (lower)', min: 8, max: 30, step: 1, apply: applyFlippers },
  { key: 'upperUpMs', label: 'upMs (upper)', min: 8, max: 30, step: 1, apply: applyFlippers },
  { key: 'lowerRestAngle', label: 'restAngle', min: -70, max: -20, step: 1, apply: applyFlippers },
  { key: 'lowerActiveAngle', label: 'activeAngle', min: 15, max: 50, step: 1, apply: applyFlippers },
  { key: 'eWall', label: 'E_WALL', min: 0.1, max: 0.9, step: 0.01, apply: () => applyEWall(live.eWall) },
  { key: 'mu', label: 'MU', min: 0, max: 0.3, step: 0.005, apply: applyTuning },
  { key: 'kDrag', label: 'K_DRAG', min: 0, max: 0.5, step: 0.01, apply: applyTuning },
];

const panelEl = document.getElementById('panel');
const sliderEls = {};
function buildPanel() {
  panelEl.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = 'live constants';
  panelEl.appendChild(h);
  for (const field of PANEL_FIELDS) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = field.label;
    const val = document.createElement('span');
    val.className = 'val';
    label.appendChild(name);
    label.appendChild(val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    input.value = String(live[field.key]);
    val.textContent = live[field.key];
    input.addEventListener('input', () => {
      live[field.key] = Number(input.value);
      val.textContent = live[field.key];
      field.apply();
    });
    sliderEls[field.key] = { input, val };
    row.appendChild(label);
    row.appendChild(input);
    panelEl.appendChild(row);
  }
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset to shipped values';
  resetBtn.addEventListener('click', () => {
    live.eFlipper = E_FLIPPER;
    live.lowerUpMs = FLIPPER.lower.upMs;
    live.upperUpMs = FLIPPER.upper.upMs;
    live.lowerRestAngle = FLIPPER.lower.restAngle;
    live.lowerActiveAngle = FLIPPER.lower.activeAngle;
    live.eWall = E_WALL;
    live.mu = MU;
    live.kDrag = K_DRAG;
    for (const field of PANEL_FIELDS) {
      sliderEls[field.key].input.value = String(live[field.key]);
      sliderEls[field.key].val.textContent = live[field.key];
    }
    applyFlippers();
    applyEWall(live.eWall);
    applyTuning();
  });
  panelEl.appendChild(resetBtn);
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'applies immediately, no reload — [T] toggles trails, [C] clears balls';
  panelEl.appendChild(hint);
}
buildPanel();

// --- Scenario harness panel --------------------------------------------------------------
// Runs a named scenario from scenarios.js: a fresh, headless physics/table world (never the
// live scene's world — see scenarios.js's own doc comment on why determinism, not real-time
// playback, is the point), stepped to completion instantly, with the result printed here.
// This is the same runScenario() a `node --test` run calls — clicking a button here and
// asserting on it in test/scenarios.test.mjs read the identical report shape.
const scenarioPanelEl = document.getElementById('scenarioPanel');
function buildScenarioPanel() {
  scenarioPanelEl.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = 'scenarios';
  scenarioPanelEl.appendChild(h);
  const readout = document.createElement('pre');
  readout.id = 'scenarioReadout';
  readout.textContent = 'pick a scenario to run';
  for (const name of Object.keys(SCENARIOS)) {
    const btn = document.createElement('button');
    btn.textContent = `Run: ${SCENARIOS[name].label}`;
    btn.addEventListener('click', () => {
      readout.textContent = formatReport(runScenario(name));
    });
    scenarioPanelEl.appendChild(btn);
  }
  scenarioPanelEl.appendChild(readout);
}
buildScenarioPanel();

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

  const ejectedBalls = game.tickScoop(scoop, elapsedS);
  if (ejectedBalls) {
    // Every ball armScoop captured since the last eject leaves together (game/mechanisms.js's
    // own doc comment on armScoop) — matches games/pinball/src/main.js's own eject snippet.
    const evel = sandbox.eject.vel;
    const evLen = Math.hypot(evel.x, evel.y) || 1;
    const clear = sandbox.captureZone.radius * 1.3;
    for (const ejected of ejectedBalls) {
      ejected.pos = {
        x: sandbox.captureZone.centre.x + (evel.x / evLen) * clear,
        y: sandbox.captureZone.centre.y + (evel.y / evLen) * clear,
      };
      ejected.vel = { x: evel.x, y: evel.y };
      ejected.captured = false;
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
    updateTrail(entry);
  }
  for (const flipper of Object.values(flippers)) {
    flipper._mesh.rotation.y = flipper.angle;
  }

  tickFlipTracking();
  drawFlipReadout();

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
      `[C] clear all balls  [T] trails: ${trailsVisible ? 'on' : 'off'}`;
  } else {
    readoutEl.textContent =
      holdText +
      (dragReadout ? `${dragReadout}\n` : 'no ball placed yet — click the playfield\n') +
      `[C] clear all balls  [T] trails: ${trailsVisible ? 'on' : 'off'}`;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
