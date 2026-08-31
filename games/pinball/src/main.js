import * as THREE from 'three';
import { createScene, toSceneVec } from './render/scene.js';
import { createWorld, setLayerPrimitives, setLayerZones, addRamp, setCaptureZones, addBall, addFlipper, advance } from './physics/world.js';
import { createFlipper } from './physics/flipper.js';
import { sampleRamp } from './physics/ramp.js';
import { BALL_RADIUS, PLUNGER_MAX_SPEED } from './physics/constants.js';
import * as recess from './table/recess.js';
import * as mech from './table/mechanisms.js';
import * as ramps from './table/ramps.js';
import {
  SW_FUN, SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  SW_HOPSCOTCH, SW_SAND, SW_TREEHOUSE,
  SW_SLIDE_ENTER, SW_MONKEYBARS_ENTER, SW_TUNNEL_ENTER,
  SW_SANDBOX_ENTRY, SW_SANDBOX_EJECT,
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

// --- Art pass (T4b): reference-photo redirect -----------------------------------------
// A worn 1960s playground-pinball playfield (games/pinball/assets/textures/playfield.jpg)
// UV-mapped directly onto the table rect, replacing the flat-painted "sunny blacktop"
// placeholder from T3b. The photo already carries the hopscotch ladder, bumper rings and
// slide artwork, so the mechanisms below are restyled to sit on top of it rather than
// paint their own ground graphics.
const floorGeo = new THREE.PlaneGeometry(recess.LANE_OUTER_X * 2, recess.HEIGHT);
const floorMat = new THREE.MeshLambertMaterial({ color: 0x2f5a3a }); // worn-green fallback until the texture loads
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0, -recess.HEIGHT / 2);
tiltGroup.add(floor);
new THREE.TextureLoader().load('./assets/textures/playfield.jpg', (tex) => {
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  floorMat.map = tex;
  floorMat.color.set(0xffffff);
  floorMat.needsUpdate = true;
});

// --- World, walls, flippers ---
const world = createWorld();
const wallSegments = recess.buildWalls();
setLayerPrimitives(world, 'playfield', wallSegments.map((shape) => ({ shape })));

// Wood-tone side rails + chrome lane/apron guides, sampled from the reference photo's
// worn pine border and chrome slingshot/corner plates (was flat gold/blue placeholder).
const wallColorByTag = {
  left: 0xc9a267, top: 0xc9a267, // worn pine rail
  'apron-left': 0x5a5a5a, 'apron-right': 0x5a5a5a, // dark chrome corner plate
  'lane-outer': 0xb8b8b8, 'lane-inner': 0xb8b8b8, 'lane-floor': 0xb8b8b8, // chrome lane guide
  'lane-deflector': 0xb8b8b8, 'lane-gate': 0xb8b8b8,
};
const wallMats = new Map();
function wallMaterial(tag) {
  const color = wallColorByTag[tag] ?? 0xc9a267;
  const metal = tag !== 'left' && tag !== 'top';
  const key = `${color}:${metal}`;
  if (!wallMats.has(key)) {
    wallMats.set(key, metal
      ? new THREE.MeshStandardMaterial({ color, metalness: 0.7, roughness: 0.35 })
      : new THREE.MeshLambertMaterial({ color }));
  }
  return wallMats.get(key);
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
const plankMat = new THREE.MeshLambertMaterial({ color: 0xcc3333 }); // red bat body
const tipMat = new THREE.MeshLambertMaterial({ color: 0xf2ecd8 }); // white-tipped, per the reference
const fulcrumMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.6, roughness: 0.4 });
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

  const tipLen = flipper.length * 0.22;
  const tip = new THREE.Mesh(new THREE.BoxGeometry(tipLen, 0.0122, flipper.radius * 2.02), tipMat);
  tip.position.x = flipper.length - tipLen / 2;
  mesh.add(tip); // rides the flipper mesh's own rotation, no separate update needed

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

// --- T5 ramps, orbits and the SANDBOX scoop ---------------------------------------------
const slide = ramps.buildSlideRamp();
const monkeyBars = ramps.buildMonkeyBarsRamp();
const tunnel = ramps.buildTunnelRamp();
const sandbox = ramps.buildSandbox();

addRamp(world, slide.ramp);
addRamp(world, monkeyBars.ramp);
addRamp(world, tunnel.ramp);

setLayerZones(world, 'playfield', [
  ...funLaneDefs.map((f) => f.zone),
  spinnerDefs.tetherball,
  spinnerDefs.pinwheel,
  slide.gate,
  monkeyBars.gate,
  tunnel.gate,
]);
setCaptureZones(world, 'playfield', [sandbox.captureZone]);

const hopscotchBankState = game.createHopscotchBank(hopscotch.targets);
const sandBankState = game.createSandBank(sandBank.targets);
const funLamps = game.createFunLamps();
const tetherballSpinner = game.createSpinner();
const pinwheelSpinner = game.createSpinner();
const scoreboard = createScoreboard();
const scoop = game.createScoop();

let elapsedS = 0;

// Only these tags are T4/T5 scoring mechanisms; every other collision (plain walls, the
// launch-lane floor, the flipper capsules themselves) is plumbing, not a switch, and must
// not reach the scoreboard/event log. Ramp exit/rollback tags are derived from the ramp
// ids themselves (see physics/world.js's stepRampLayerBall/tryEnterGate) rather than a
// switches.js export for the rollback case, since "did the shot make it" isn't scored.
const MECHANISM_TAGS = new Set([
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  ...SW_HOPSCOTCH, ...SW_SAND,
  SW_TREEHOUSE,
  ...SW_FUN,
  SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
  SW_SLIDE_ENTER, SW_MONKEYBARS_ENTER, SW_TUNNEL_ENTER,
  `${slide.ramp.id}_exit`, `${monkeyBars.ramp.id}_exit`, `${tunnel.ramp.id}_exit`,
  `${slide.ramp.id}_rollback`, `${monkeyBars.ramp.id}_rollback`, `${tunnel.ramp.id}_rollback`,
  SW_SANDBOX_ENTRY, SW_SANDBOX_EJECT,
]);

function tagOf(event) {
  return event.tag ?? event.primitive?.shape?.tag;
}

function processMechanismEvents(events) {
  for (const event of events) {
    const tag = tagOf(event);
    if (!tag || !MECHANISM_TAGS.has(tag)) continue;

    if (SPARK_TAGS.has(tag)) flashSparkAt(ball.pos.x, ball.pos.y);

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
    } else if (tag === SW_SLIDE_ENTER || tag === SW_MONKEYBARS_ENTER || tag === SW_TUNNEL_ENTER) {
      // Only a successful gate entry (the ball actually switched layers) is worth logging —
      // a slow crossing that didn't clear RAMP_ENTRY_MIN_SPEED fires the same tag but never
      // transitions (see physics/world.js's tryEnterGate).
      if (event.gateEntered) {
        applySwitch(scoreboard, tag, 0);
        if (eventLog) eventLog.log(tag);
      }
    } else if (tag === SW_SANDBOX_ENTRY) {
      game.armScoop(scoop, elapsedS);
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

// Worn red-dome pop bumpers, per the reference photo — the three switches keep their
// duck/horse/rocket tag names (game logic unaffected), but all three now read as the same
// chipped red dome-and-ring bumper the photo actually shows, with a gold star decal.
const bumperDomeMat = new THREE.MeshStandardMaterial({ color: 0xb8362c, metalness: 0.1, roughness: 0.6 });
const bumperRingMat = new THREE.MeshLambertMaterial({ color: 0xc23c30 });
const bumperStarMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.5, roughness: 0.4 });
function buildPopBumperMesh(name, centre) {
  const group = new THREE.Group();
  const skirt = coloredMesh(new THREE.CylinderGeometry(0.032, 0.032, 0.006, 16), 0x8a8a8a);
  skirt.position.y = 0.003;
  group.add(skirt);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.036, 0.044, 24), bumperRingMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.0015;
  group.add(ring);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), bumperDomeMat);
  dome.position.y = 0.006;
  group.add(dome);
  const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.007, 0), bumperStarMat);
  star.scale.y = 0.35;
  star.position.set(0.014, 0.03, 0.012);
  group.add(star);
  const p = toSceneVec(centre.x, centre.y, 0);
  group.position.set(p.x, p.y, p.z);
  return group;
}
for (const p of popBumpers) tiltGroup.add(buildPopBumperMesh(p.name, p.centre));

const slingshotMat = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, metalness: 0.75, roughness: 0.3 });
function buildSlingshotMesh(segments) {
  const group = new THREE.Group();
  for (const seg of segments) {
    const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
    const len = Math.hypot(dx, dy);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.012), slingshotMat);
    const p = toSceneVec((seg.a.x + seg.b.x) / 2, (seg.a.y + seg.b.y) / 2, 0.025);
    bar.position.set(p.x, p.y, p.z);
    bar.rotation.y = -Math.atan2(dy, dx);
    group.add(bar);
  }
  return group;
}
tiltGroup.add(buildSlingshotMesh(slingshots.left));
tiltGroup.add(buildSlingshotMesh(slingshots.right));
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

// --- T5 models: ramp/orbit tracks and the SANDBOX pit -----------------------------------
// Each ramp is rendered as a chain of oriented boxes along its own points (x,y,z) — a
// simple "tube" read that's cheap and needs no new geometry type. Colour and width are the
// only per-ramp styling: THE SLIDE (blue plastic curl), MONKEY BARS (grey steel wireform,
// thinner, more overhead read via its height), THE TUNNEL (dull concrete culvert).
function buildTrackMesh(points, color, width, opacity = 1) {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity });
  for (let i = 0; i < points.length - 1; i++) {
    const a = toSceneVec(points[i].x, points[i].y, points[i].z);
    const b = toSceneVec(points[i + 1].x, points[i + 1].y, points[i + 1].z);
    const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = dir.length();
    if (len < 1e-6) continue;
    const box = new THREE.Mesh(new THREE.BoxGeometry(len, width * 0.6, width), mat);
    box.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    box.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.clone().normalize());
    group.add(box);
  }
  return group;
}
tiltGroup.add(buildTrackMesh(slide.ramp.points, 0x2f6fb5, 0.08));
tiltGroup.add(buildTrackMesh(monkeyBars.ramp.points, 0xd8d8d8, 0.018));
tiltGroup.add(buildTrackMesh(tunnel.ramp.points, 0x8a7a6a, 0.06, 0.9));

// THE SANDBOX: a shallow tan pit with a darker rim, at the scoop's capture radius.
{
  const group = new THREE.Group();
  const pit = coloredMesh(new THREE.CircleGeometry(sandbox.captureZone.radius * 1.6, 20), 0xd9c07a);
  pit.rotation.x = -Math.PI / 2;
  pit.position.y = 0.001;
  group.add(pit);
  const rim = coloredMesh(new THREE.RingGeometry(sandbox.captureZone.radius * 1.5, sandbox.captureZone.radius * 1.9, 20), 0x8a6339);
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.0015;
  group.add(rim);
  const p = toSceneVec(sandbox.captureZone.centre.x, sandbox.captureZone.centre.y, 0);
  group.position.set(p.x, p.y, p.z);
  tiltGroup.add(group);
}

// --- Cheap hit-flash: a small pool of additive spark sprites (spark.jpg, per the
// reference), flashed at the ball's position on a bumper/slingshot hit and faded out over
// ~0.2s. Reuses a fixed pool rather than allocating per hit. ---
const sparkTexture = new THREE.TextureLoader().load('./assets/textures/spark.jpg');
const SPARK_LIFE = 0.2;
const sparkPool = Array.from({ length: 4 }, () => {
  const mat = new THREE.SpriteMaterial({ map: sparkTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.09, 0.09, 1);
  sprite.userData.life = 0;
  tiltGroup.add(sprite);
  return sprite;
});
let sparkCursor = 0;
function flashSparkAt(x, y) {
  const sprite = sparkPool[sparkCursor];
  sparkCursor = (sparkCursor + 1) % sparkPool.length;
  const p = toSceneVec(x, y, 0.03);
  sprite.position.set(p.x, p.y, p.z);
  sprite.userData.life = SPARK_LIFE;
}
const SPARK_TAGS = new Set([SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET, SW_SLING_LEFT, SW_SLING_RIGHT]);

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
  ball.layer = 'playfield';
  ball.captured = false;
  ball.z = 0;
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

  if (game.tickScoop(scoop, elapsedS)) {
    // Nudge the ball just clear of the capture radius along the eject direction before
    // releasing it — otherwise, at 240 Hz, a single physics step doesn't carry it outside
    // the zone yet and checkCaptures (physics/world.js) immediately re-captures it.
    const evel = sandbox.eject.vel;
    const evLen = Math.hypot(evel.x, evel.y) || 1;
    const clear = sandbox.captureZone.radius * 1.3;
    ball.pos = {
      x: sandbox.captureZone.centre.x + (evel.x / evLen) * clear,
      y: sandbox.captureZone.centre.y + (evel.y / evLen) * clear,
    };
    ball.vel = { x: evel.x, y: evel.y };
    ball.captured = false;
    applySwitch(scoreboard, sandbox.eject.tag);
    if (eventLog) eventLog.log(sandbox.eject.tag);
  }

  if (!ball.captured && recess.isDrained(ball)) {
    serveBall();
  }

  const p = toSceneVec(ball.pos.x, ball.pos.y, ball.radius + (ball.z || 0));
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

  for (const sprite of sparkPool) {
    sprite.userData.life = Math.max(0, sprite.userData.life - dt);
    sprite.material.opacity = sprite.userData.life / SPARK_LIFE;
  }

  hud.textContent = `SCORE ${scoreboard.score.toLocaleString()}`;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__pinball = {
  world, ball, flippers, advance, isDrained: recess.isDrained,
  scoreboard, hopscotchBankState, sandBankState, funLamps, tetherballSpinner, pinwheelSpinner,
  slide, monkeyBars, tunnel, sandbox, scoop,
};
