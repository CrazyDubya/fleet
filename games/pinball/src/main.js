import * as THREE from 'three';
import { createScene, toSceneVec } from './render/scene.js';
import { createWorld, setLayerPrimitives, setLayerZones, addBall, addFlipper, advance } from './physics/world.js';
import { createFlipper } from './physics/flipper.js';
import { BALL_RADIUS, PLUNGER_MAX_SPEED } from './physics/constants.js';
import * as recess from './table/recess.js';
import * as mech from './table/mechanisms.js';
import {
  SW_FUN, SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  SW_HOPSCOTCH, SW_SAND, SW_TREEHOUSE,
} from './table/switches.js';
import * as game from './game/mechanisms.js';
import { createScoreboard, applySwitch, fallbackPointsFor } from './game/scoreboard.js';
import { wireInput } from './ui/input.js';
import { isDebugEnabled, mountDebugPanel, mountEventLog } from './ui/debug.js';

const canvas = document.getElementById('view');
const { scene, camera, renderer, tiltGroup, resize } = createScene(canvas);
tiltGroup.rotation.x = -THREE.MathUtils.degToRad(6.5);
camera.position.set(0, 1.0, 0.65);
camera.lookAt(0, 0, -0.5);

// --- Playground look pass (T3b minimum) ---------------------------------------------
// A first art pass so the table reads as a sunny blacktop playground rather than grey
// boxes. Full models (slide, monkey bars, merry-go-round, ...) are T10; this is deliberately
// cheap: flat-shaded primitives, shared materials, no textures.

// Blacktop playfield, painted with a hopscotch grid and four-square lines near the top,
// a grass strip along the very top, and a wood-chip patch where the spring riders (T4)
// will sit.
const floorGeo = new THREE.PlaneGeometry(recess.LANE_OUTER_X * 2, recess.HEIGHT);
const floorMat = new THREE.MeshLambertMaterial({ color: 0x4a4a4a }); // asphalt
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0, -recess.HEIGHT / 2);
tiltGroup.add(floor);

const paintMat = new THREE.MeshLambertMaterial({ color: 0xf2ecd8 }); // chalky white paint
function paintLine(cx, cy, w, h, rotationDeg = 0) {
  const geo = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geo, paintMat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = THREE.MathUtils.degToRad(rotationDeg);
  const p = toSceneVec(cx, cy, 0.001);
  mesh.position.set(p.x, p.y, p.z);
  tiltGroup.add(mesh);
}
// Four-square grid, centred a bit above the flippers.
const fsCx = 0, fsCy = 0.62, fsSize = 0.16;
paintLine(fsCx, fsCy, fsSize, 0.006);
paintLine(fsCx, fsCy, 0.006, fsSize);
paintLine(fsCx, fsCy, fsSize + 0.006, 0.006, 0); // border top/bottom handled by box below
// Hopscotch ladder, off to the right of four-square.
for (let i = 0; i < 5; i++) paintLine(0.16, 0.68 + i * 0.07, 0.09, 0.006);
paintLine(0.16, 0.68 - 0.035, 0.006, 5 * 0.07 + 0.03);
paintLine(0.16 - 0.045, 0.68, 0.006, 0.07);
paintLine(0.16 + 0.045, 0.68, 0.006, 0.07);

// Grass strip along the top edge.
const grassGeo = new THREE.PlaneGeometry(recess.LANE_OUTER_X * 2, 0.08);
const grassMat = new THREE.MeshLambertMaterial({ color: 0x4c9a4c });
const grass = new THREE.Mesh(grassGeo, grassMat);
grass.rotation.x = -Math.PI / 2;
const gp = toSceneVec(0, recess.HEIGHT - 0.04, 0.0015);
grass.position.set(gp.x, gp.y, gp.z);
tiltGroup.add(grass);

// Wood-chip pit under where the spring riders will sit (T4).
const chipGeo = new THREE.CircleGeometry(0.09, 20);
const chipMat = new THREE.MeshLambertMaterial({ color: 0x8a6339 });
const chips = new THREE.Mesh(chipGeo, chipMat);
chips.rotation.x = -Math.PI / 2;
const cp = toSceneVec(-0.06, 0.82, 0.0015);
chips.position.set(cp.x, cp.y, cp.z);
tiltGroup.add(chips);

// Sky/fence backdrop: a low chain-link-style fence of posts along the very top, in front
// of the sky-blue background.
const fenceMat = new THREE.MeshLambertMaterial({ color: 0x777777 });
const postGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.09, 6);
for (let x = -recess.HALF_WIDTH; x <= recess.HALF_WIDTH + 0.02; x += 0.045) {
  const post = new THREE.Mesh(postGeo, fenceMat);
  const p = toSceneVec(x, recess.HEIGHT + 0.01, 0.045);
  post.position.set(p.x, p.y, p.z);
  tiltGroup.add(post);
}

// THE SLIDE — placeholder silhouette for the T5 ramp, top-left.
const slideMat = new THREE.MeshLambertMaterial({ color: 0x2f6fb5 });
const slideGeo = new THREE.BoxGeometry(0.09, 0.02, 0.22);
const slide = new THREE.Mesh(slideGeo, slideMat);
slide.rotation.z = THREE.MathUtils.degToRad(20);
const sp = toSceneVec(-0.16, 0.75, 0.03);
slide.position.set(sp.x, sp.y, sp.z);
tiltGroup.add(slide);

// --- World, walls, flippers ---
const world = createWorld();
const wallSegments = recess.buildWalls();
setLayerPrimitives(world, 'playfield', wallSegments.map((shape) => ({ shape })));

const wallColorByTag = {
  left: 0xe8b923, top: 0xe8b923,
  'apron-left': 0xdd5522, 'apron-right': 0xdd5522, // safety-orange apron, reads as a curb
  'lane-outer': 0x2f6fb5, 'lane-inner': 0x2f6fb5, 'lane-floor': 0x2f6fb5, // blue lane guide
  'lane-deflector': 0x2f6fb5, 'lane-gate': 0x2f6fb5,
};
const wallMats = new Map();
function wallMaterial(tag) {
  const color = wallColorByTag[tag] ?? 0xe8b923;
  if (!wallMats.has(color)) wallMats.set(color, new THREE.MeshLambertMaterial({ color }));
  return wallMats.get(color);
}
for (const seg of wallSegments) {
  const dx = seg.b.x - seg.a.x;
  const dy = seg.b.y - seg.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) continue;
  const geo = new THREE.BoxGeometry(len, 0.03, 0.01);
  const mesh = new THREE.Mesh(geo, wallMaterial(seg.tag));
  const p = toSceneVec((seg.a.x + seg.b.x) / 2, (seg.a.y + seg.b.y) / 2, 0.015);
  mesh.position.set(p.x, p.y, p.z);
  mesh.rotation.y = -Math.atan2(dy, dx);
  tiltGroup.add(mesh);
}

// Seesaw flippers: a plank pivoting on a fulcrum, per the design doc's literal
// playground mapping (§4.2). The fulcrum is a fixed cone at the pivot; the plank is the
// physics capsule's visual stand-in, painted playground-red/yellow.
const flipperConfigs = recess.buildFlipperConfigs();
const flippers = {};
const plankMat = new THREE.MeshLambertMaterial({ color: 0xcc3333 });
const fulcrumMat = new THREE.MeshLambertMaterial({ color: 0xdddddd });
const fulcrumGeo = new THREE.ConeGeometry(0.018, 0.03, 8);
for (const cfg of flipperConfigs) {
  const flipper = createFlipper(cfg);
  addFlipper(world, flipper);
  flippers[cfg.name] = flipper;

  const geo = new THREE.BoxGeometry(flipper.length, 0.012, flipper.radius * 2);
  geo.translate(flipper.length / 2, 0, 0); // pivot end at local origin, plank extends +x
  const mesh = new THREE.Mesh(geo, plankMat);
  mesh.userData.flipper = flipper;
  tiltGroup.add(mesh);
  flipper._mesh = mesh;

  const fulcrum = new THREE.Mesh(fulcrumGeo, fulcrumMat);
  const fp = toSceneVec(flipper.pivot.x, flipper.pivot.y, 0.005);
  fulcrum.position.set(fp.x, fp.y, fp.z);
  tiltGroup.add(fulcrum);
}

function updateFlipperMesh(flipper) {
  const mesh = flipper._mesh;
  const p = toSceneVec(flipper.pivot.x, flipper.pivot.y, 0.02);
  mesh.position.set(p.x, p.y, p.z);
  mesh.rotation.y = flipper.angle;
}

// --- T4 scoring mechanisms: physics data + runtime state -----------------------------
const popBumpers = mech.buildPopBumpers();
const slingshots = mech.buildSlingshots();
const hopscotch = mech.buildHopscotchBank();
const sandBank = mech.buildSandBank();
const treehouse = mech.buildTreehouseStandup();
const funLaneDefs = mech.buildFunLanes();
const spinnerDefs = mech.buildSpinners();

setLayerPrimitives(world, 'playfield', [
  ...wallSegments.map((shape) => ({ shape })),
  ...popBumpers.map((p) => ({ shape: p.shape })),
  ...slingshots.left.map((shape) => ({ shape })),
  ...slingshots.right.map((shape) => ({ shape })),
  ...hopscotch.targets.map((t) => ({ shape: t.shape })),
  ...sandBank.targets.map((t) => ({ shape: t.shape })),
  { shape: treehouse.shape },
]);
setLayerZones(world, 'playfield', [
  ...funLaneDefs.map((f) => f.zone),
  spinnerDefs.tetherball,
  spinnerDefs.pinwheel,
]);

const hopscotchBankState = game.createHopscotchBank(hopscotch.targets);
const sandBankState = game.createSandBank(sandBank.targets);
const funLamps = game.createFunLamps();
const tetherballSpinner = game.createSpinner();
const pinwheelSpinner = game.createSpinner();
const scoreboard = createScoreboard();

let elapsedS = 0;

// Only these tags are T4 scoring mechanisms; every other collision (plain walls, the
// launch-lane floor, the flipper capsules themselves) is plumbing, not a switch, and must
// not reach the scoreboard/event log.
const MECHANISM_TAGS = new Set([
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  ...SW_HOPSCOTCH, ...SW_SAND,
  SW_TREEHOUSE,
  ...SW_FUN,
  SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
]);

function tagOf(event) {
  return event.tag ?? event.primitive?.shape?.tag;
}

function processMechanismEvents(events) {
  for (const event of events) {
    const tag = tagOf(event);
    if (!tag || !MECHANISM_TAGS.has(tag)) continue;

    if (hopscotch.targets.some((t) => t.tag === tag)) {
      for (const fired of game.applyDropHit(hopscotchBankState, tag, elapsedS)) {
        applySwitch(scoreboard, fired, fallbackPointsFor(fired));
        if (eventLog) eventLog.log(fired);
      }
    } else if (sandBank.targets.some((t) => t.tag === tag)) {
      for (const fired of game.applyDropHit(sandBankState, tag, elapsedS)) {
        applySwitch(scoreboard, fired, fallbackPointsFor(fired));
        if (eventLog) eventLog.log(fired);
      }
    } else if (SW_FUN.includes(tag)) {
      for (const fired of game.applyFunCross(funLamps, tag)) {
        applySwitch(scoreboard, fired, fallbackPointsFor(fired));
        if (eventLog) eventLog.log(fired);
      }
    } else if (tag === SW_TETHERBALL_SPIN) {
      game.registerSpinnerHit(tetherballSpinner);
      applySwitch(scoreboard, tag);
      if (eventLog) eventLog.log(tag);
    } else if (tag === SW_PINWHEEL_SPIN) {
      game.registerSpinnerHit(pinwheelSpinner);
      applySwitch(scoreboard, tag);
      if (eventLog) eventLog.log(tag);
    } else {
      applySwitch(scoreboard, tag);
      if (eventLog) eventLog.log(tag);
    }
  }
}

// --- T4 models: spring riders, swings, drop-target banks, TREEHOUSE, F-U-N, spinners ---
function coloredMesh(geo, color) {
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
}

function buildPopBumperMesh(name, centre) {
  const group = new THREE.Group();
  const skirt = coloredMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.006, 16), 0x999999);
  skirt.position.y = 0.003;
  group.add(skirt);
  const spring = coloredMesh(new THREE.CylinderGeometry(0.006, 0.006, 0.05, 8), 0xaaaaaa);
  spring.position.y = 0.03;
  group.add(spring);
  if (name === 'duck') {
    const body = coloredMesh(new THREE.SphereGeometry(0.026, 12, 10), 0xf4d13a);
    body.position.y = 0.07;
    group.add(body);
    const beak = coloredMesh(new THREE.ConeGeometry(0.008, 0.02, 8), 0xe8862a);
    beak.rotation.z = Math.PI / 2;
    beak.position.set(0.024, 0.068, 0);
    group.add(beak);
  } else if (name === 'horse') {
    const body = coloredMesh(new THREE.CylinderGeometry(0.02, 0.024, 0.05, 10), 0x8a5a34);
    body.position.y = 0.075;
    group.add(body);
    const head = coloredMesh(new THREE.ConeGeometry(0.014, 0.03, 8), 0x6b4423);
    head.position.set(0, 0.11, 0.01);
    head.rotation.x = -0.3;
    group.add(head);
  } else {
    const body = coloredMesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), 0xdd3333);
    body.position.y = 0.075;
    group.add(body);
    const nose = coloredMesh(new THREE.ConeGeometry(0.018, 0.025, 10), 0xf2f2f2);
    nose.position.y = 0.11;
    group.add(nose);
    for (const side of [-1, 1]) {
      const fin = coloredMesh(new THREE.BoxGeometry(0.006, 0.02, 0.016), 0xf2f2f2);
      fin.position.set(side * 0.02, 0.055, 0);
      group.add(fin);
    }
  }
  const p = toSceneVec(centre.x, centre.y, 0);
  group.position.set(p.x, p.y, p.z);
  return group;
}
for (const p of popBumpers) tiltGroup.add(buildPopBumperMesh(p.name, p.centre));

function buildSlingshotMesh(segments, color) {
  const group = new THREE.Group();
  for (const seg of segments) {
    const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
    const len = Math.hypot(dx, dy);
    const bar = coloredMesh(new THREE.BoxGeometry(len, 0.05, 0.012), color);
    const p = toSceneVec((seg.a.x + seg.b.x) / 2, (seg.a.y + seg.b.y) / 2, 0.025);
    bar.position.set(p.x, p.y, p.z);
    bar.rotation.y = -Math.atan2(dy, dx);
    group.add(bar);
  }
  return group;
}
tiltGroup.add(buildSlingshotMesh(slingshots.left, 0x3399cc));
tiltGroup.add(buildSlingshotMesh(slingshots.right, 0x3399cc));
// A pair of swing-set posts + top bar behind each slingshot, for the "swing set" read.
function buildSwingSetPosts(apex) {
  const group = new THREE.Group();
  const postGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.09, 8);
  for (const dx of [-0.03, 0.03]) {
    const post = coloredMesh(postGeo, 0x777777);
    const p = toSceneVec(apex.x + dx, apex.y + 0.02, 0.045);
    post.position.set(p.x, p.y, p.z);
    group.add(post);
  }
  const bar = coloredMesh(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 8), 0x777777);
  bar.rotation.z = Math.PI / 2;
  const bp = toSceneVec(apex.x, apex.y + 0.02, 0.09);
  bar.position.set(bp.x, bp.y, bp.z);
  group.add(bar);
  return group;
}
tiltGroup.add(buildSwingSetPosts({ x: -0.135, y: 0.175 }));
tiltGroup.add(buildSwingSetPosts({ x: 0.135, y: 0.175 }));

// Drop-target banks: standing plates, one per target, scaled to 0 height when dropped.
function buildDropBankMeshes(bank, color) {
  const meshes = new Map();
  for (const t of bank.targets) {
    const plate = coloredMesh(new THREE.BoxGeometry(0.03, 0.03, 0.006), color);
    const p = toSceneVec(t.centre.x, t.centre.y, 0.015);
    plate.position.set(p.x, p.y, p.z);
    tiltGroup.add(plate);
    meshes.set(t.tag, plate);
  }
  return meshes;
}
const hopscotchMeshes = buildDropBankMeshes(hopscotch, 0xe0a832);
const sandMeshes = buildDropBankMeshes(sandBank, 0xd9c07a);

// TREEHOUSE standup: a little box-and-roof.
{
  const group = new THREE.Group();
  const trunk = coloredMesh(new THREE.BoxGeometry(0.02, 0.03, 0.02), 0x8a5a34);
  trunk.position.y = 0.015;
  group.add(trunk);
  const roof = coloredMesh(new THREE.ConeGeometry(0.02, 0.025, 4), 0x4a7a3a);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 0.04;
  group.add(roof);
  const p = toSceneVec(treehouse.shape.centre.x, treehouse.shape.centre.y, 0);
  group.position.set(p.x, p.y, p.z);
  tiltGroup.add(group);
}

// F-U-N rollover lanes: thin strips that light up when the pointer sits on them, and stay
// lit until the set completes.
const funMeshes = funLaneDefs.map((f) => {
  const mat = new THREE.MeshLambertMaterial({ color: 0x555555 });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.01, 0.006), mat);
  const mid = { x: (f.zone.a.x + f.zone.b.x) / 2, y: (f.zone.a.y + f.zone.b.y) / 2 };
  const p = toSceneVec(mid.x, mid.y, 0.005);
  bar.position.set(p.x, p.y, p.z);
  tiltGroup.add(bar);
  return { tag: f.tag, mesh: bar, mat };
});

// Spinners: a rotating rod whose spin visualises the click/decay state.
function buildSpinnerMesh(zone) {
  const mid = { x: (zone.a.x + zone.b.x) / 2, y: (zone.a.y + zone.b.y) / 2 };
  const rod = coloredMesh(new THREE.BoxGeometry(0.05, 0.006, 0.006), 0x333333);
  const p = toSceneVec(mid.x, mid.y, 0.02);
  rod.position.set(p.x, p.y, p.z);
  tiltGroup.add(rod);
  return rod;
}
const tetherballMesh = buildSpinnerMesh(spinnerDefs.tetherball);
const pinwheelMesh = buildSpinnerMesh(spinnerDefs.pinwheel);

// --- Ball ---
const ball = addBall(world, { id: 'b0', pos: { ...recess.LAUNCH_POSITION }, vel: { x: 0, y: 0 }, radius: BALL_RADIUS, active: false });
const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 24, 16);
const ballMat = new THREE.MeshStandardMaterial({ color: 0xcc2222, metalness: 0.2, roughness: 0.4 });
const ballMesh = new THREE.Mesh(ballGeo, ballMat);
tiltGroup.add(ballMesh);

function serveBall() {
  ball.pos = { ...recess.LAUNCH_POSITION };
  ball.vel = { x: 0, y: 0 };
  ball.active = true;
}
serveBall();

// --- Input: flippers, plunger, nudge ---
let plungerPower = 0;
let charging = false;

wireInput(canvas, {
  flippers,
  onPlungerChange: (p) => {
    charging = true;
    plungerPower = p;
  },
  onPlungerRelease: () => {
    if (charging) {
      ball.vel = { x: 0, y: Math.max(0.6, plungerPower) * PLUNGER_MAX_SPEED };
      charging = false;
      plungerPower = 0;
    }
  },
  onNudge: ({ x, y }) => {
    const len = Math.hypot(x, y) || 1;
    const impulse = 0.35;
    ball.vel = { x: ball.vel.x + (x / len) * impulse, y: ball.vel.y + (y / len) * impulse };
  },
  onFlipperEdge: () => game.advanceFunPointer(funLamps),
});

if (isDebugEnabled()) mountDebugPanel(world, flippers);
const eventLog = isDebugEnabled() ? mountEventLog() : null;

// --- HUD: provisional score, always visible (per design doc §9 T4: "provisional scores
// to the HUD area" — the real chalkboard display is ui/hud.js, T12). ---
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:8px;right:8px;color:#fff;font:14px monospace;text-shadow:0 1px 2px #000;z-index:5;pointer-events:none;';
document.body.appendChild(hud);

function resizeToWindow() {
  resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resizeToWindow);
resizeToWindow();

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  elapsedS += dt;

  const events = advance(world, dt);
  processMechanismEvents(events);
  game.tickDropBank(hopscotchBankState, elapsedS);
  game.tickDropBank(sandBankState, elapsedS);
  game.tickSpinner(tetherballSpinner, dt);
  game.tickSpinner(pinwheelSpinner, dt);

  if (recess.isDrained(ball)) {
    serveBall();
  }

  const p = toSceneVec(ball.pos.x, ball.pos.y, ball.radius);
  ballMesh.position.set(p.x, p.y, p.z);
  for (const flipper of Object.values(flippers)) updateFlipperMesh(flipper);

  for (const [tag, mesh] of hopscotchMeshes) mesh.visible = !hopscotchBankState.dropped.has(tag);
  for (const [tag, mesh] of sandMeshes) mesh.visible = !sandBankState.dropped.has(tag);
  funMeshes.forEach((f, i) => {
    const lit = funLamps.lit.has(f.tag);
    const pointed = funLamps.pointer === i;
    f.mat.color.set(lit ? 0x33cc33 : pointed ? 0xffcc33 : 0x555555);
  });
  tetherballMesh.rotation.y = tetherballSpinner.angle;
  pinwheelMesh.rotation.y = pinwheelSpinner.angle;

  hud.textContent = `SCORE ${scoreboard.score.toLocaleString()}`;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__pinball = {
  world, ball, flippers, advance, isDrained: recess.isDrained,
  scoreboard, hopscotchBankState, sandBankState, funLamps, tetherballSpinner, pinwheelSpinner,
};
