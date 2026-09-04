import * as THREE from 'three';
import { createScene, toSceneVec } from './render/scene.js';
import { startTween, tweenPosition } from './render/presentationTween.js';
import { createWorld, addBall, removeBall, addFlipper, advance } from './physics/world.js';
import { createFlipper } from './physics/flipper.js';
import { BALL_RADIUS, PLUNGER_MAX_SPEED, NUDGE_IMPULSE, PITCH_DEG } from './physics/constants.js';
import * as recess from './table/recess.js';
import * as mech from './table/mechanisms.js';
import { buildTable, wireTable } from './table/assemble.js';
import {
  SW_SOFT_PLUNGE,
  SW_FUN, SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  SW_HOPSCOTCH, SW_SAND, SW_TREEHOUSE,
  SW_SLIDE_ENTER, SW_MONKEYBARS_ENTER, SW_TUNNEL_ENTER,
  SW_SANDBOX_ENTRY, SW_SANDBOX_EJECT,
  SW_MERRY_GO_ROUND, SW_BALL_ADDED,
  drainTagFor, mechanismTags,
} from './table/switches.js';
import * as game from './game/mechanisms.js';
import { createGame, launchBall, processEvents as processRules, activePlayer } from './rules/game.js';
import { wireInput } from './ui/input.js';
import { isDebugEnabled, mountDebugPanel, mountEventLog } from './ui/debug.js';

const canvas = document.getElementById('view');
const { scene, camera, renderer, tiltGroup, resize } = createScene(canvas);
tiltGroup.rotation.x = -THREE.MathUtils.degToRad(PITCH_DEG);
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
// Every playfield primitive/zone/capture-zone/ramp comes from table/assemble.js's
// buildTable()/wireTable() — the single source of truth the sandbox project's own main.js
// calls too, so neither can silently fall behind the other's builder list (see
// table/assemble.js's header comment for why this exists).
const table = buildTable();
wireTable(world, table);
const {
  wallSegments, popBumpers, slingshots, hopscotch, sandBank, treehouse, funLaneDefs,
  spinnerDefs, swingSetPosts, slide, monkeyBars, tunnel, sandbox, merryGoRound,
  ejectionSites, mgrRelease, sandboxAddABallPlacement,
} = table;

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
  mesh.rotation.y = Math.atan2(dy, dx);
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

// --- T4 scoring mechanisms + T5 ramps/orbits/SANDBOX scoop -----------------------------
// popBumpers, slingshots, hopscotch, sandBank, treehouse, funLaneDefs, spinnerDefs,
// swingSetPosts, slide, monkeyBars, tunnel, sandbox, merryGoRound, ejectionSites,
// mgrRelease, sandboxAddABallPlacement are already destructured from `table` above, and
// every primitive/zone/capture-zone/ramp they contribute was already wired by wireTable().

const hopscotchBankState = game.createHopscotchBank(hopscotch.targets);
const sandBankState = game.createSandBank(sandBank.targets);
const funLamps = game.createFunLamps();
const tetherballSpinner = game.createSpinner();
const pinwheelSpinner = game.createSpinner();
// The rules core (T6): a pure state machine (src/rules/game.js) that owns score, ball
// number, bonus X and turn order, and is fed exclusively through the switch-event queue —
// see processMechanismEvents below, which now only does mechanism bookkeeping (drop-bank
// state, F-U-N lamps, spinner decay, the scoop's hold timer) and *collects* switch tags for
// rules/game.js to score, rather than scoring them itself. This retires the T4
// game/scoreboard.js stub, which duplicated this same switch-points table outside the
// purity boundary; there is now exactly one scoring path.
const rulesState = createGame({ numPlayers: 1, ballsPerPlayer: 3 });
const scoop = game.createScoop();
// T8: which physical ball each SW_MERRY_GO_ROUND capture event this frame belongs to,
// consumed in tag order against the matching lock/eject/multiballStart display events
// rules/game.js returns for those same tags — see the frame loop's display-handling pass.
let mergeGoRoundQueue = [];

let elapsedS = 0;
launchBall(rulesState, elapsedS);

// Only these tags are T4/T5 scoring mechanisms; every other collision (plain walls, the
// launch-lane floor, the flipper capsules themselves) is plumbing, not a switch, and must
// not reach rules/event log. See switches.js's mechanismTags for why the allowlist itself
// lives there and not here.
const MECHANISM_TAGS = mechanismTags({ slide: slide.ramp.id, monkeyBars: monkeyBars.ramp.id, tunnel: tunnel.ramp.id });

// Looked up by a ramp's own id (the same id its `_exit`/`_rollback` tags are built from, per
// switches.js's mechanismTags) so the presentation tween below can read that ramp's own real
// `points`/`exit` — never a duplicated coordinate. `[ramp.id]: ramp` keys off the SAME `.ramp`
// object main.js already renders from (buildSlideMesh(slide.ramp.points) etc, per fs2's audit).
const RAMPS_BY_ID = { [slide.ramp.id]: slide.ramp, [monkeyBars.ramp.id]: monkeyBars.ramp, [tunnel.ramp.id]: tunnel.ramp };

function tagOf(event) {
  return event.tag ?? event.primitive?.shape?.tag;
}

/** Mechanism-state bookkeeping only (no scoring — see the block comment above). Returns
 * the list of switch tags this frame's physics events actually fired, for rules/game.js's
 * processEvents to score in one batch alongside the scoop-eject and drain tags collected in
 * the frame loop below. This is the queue: nothing here calls into rules state directly. */
function processMechanismEvents(events) {
  const fired = [];
  mergeGoRoundQueue = [];
  for (const event of events) {
    const tag = tagOf(event);
    if (!tag || !MECHANISM_TAGS.has(tag)) continue;

    if (SPARK_TAGS.has(tag)) flashSparkAt(event.ball.pos.x, event.ball.pos.y);

    if (hopscotch.targets.some((t) => t.tag === tag)) {
      for (const f of game.applyDropHit(hopscotchBankState, tag, elapsedS)) {
        fired.push(f);
        if (eventLog) eventLog.log(f);
      }
    } else if (sandBank.targets.some((t) => t.tag === tag)) {
      for (const f of game.applyDropHit(sandBankState, tag, elapsedS)) {
        fired.push(f);
        if (eventLog) eventLog.log(f);
      }
    } else if (SW_FUN.includes(tag)) {
      for (const f of game.applyFunCross(funLamps, tag)) {
        fired.push(f);
        if (eventLog) eventLog.log(f);
      }
    } else if (tag === SW_TETHERBALL_SPIN) {
      game.registerSpinnerHit(tetherballSpinner);
      fired.push(tag);
      if (eventLog) eventLog.log(tag);
    } else if (tag === SW_PINWHEEL_SPIN) {
      game.registerSpinnerHit(pinwheelSpinner);
      fired.push(tag);
      if (eventLog) eventLog.log(tag);
    } else if (tag === SW_SLIDE_ENTER || tag === SW_MONKEYBARS_ENTER || tag === SW_TUNNEL_ENTER) {
      // Only a successful gate entry (the ball actually switched layers) is worth logging —
      // a slow crossing that didn't clear RAMP_ENTRY_MIN_SPEED fires the same tag but never
      // transitions (see physics/world.js's tryEnterGate).
      if (event.gateEntered) {
        fired.push(tag);
        if (eventLog) eventLog.log(tag);
      }
    } else if (tag === SW_SANDBOX_ENTRY) {
      game.armScoop(scoop, elapsedS, event.ball);
      // Presentation tween, capture: `checkCaptures` (physics/world.js) has already snapped
      // event.ball.pos to the zone centre by the time this event reaches here — the ball's
      // last REAL position before that snap is `entry.prevPos`, captured at the top of frame()
      // before advance() ran this tick. Both endpoints are real physics numbers; nothing here
      // is invented.
      const capturedEntry = findBallEntry(event.ball);
      if (capturedEntry) capturedEntry.presentationTween = startTween(capturedEntry.prevPos ?? event.ball.pos, event.ball.pos, elapsedS);
      fired.push(tag);
      if (eventLog) eventLog.log(tag);
    } else if (tag === SW_MERRY_GO_ROUND) {
      mergeGoRoundQueue.push(event.ball);
      fired.push(tag);
      if (eventLog) eventLog.log(tag);
    } else if (event.rampExit) {
      // Presentation tween, ramp exit ('top', made the shot) / rollback ('bottom', didn't):
      // physics/ramp.js's own doc comment records this hand-off as instantaneous by design —
      // "the habitrail's/wireform's/orbit's actual downhill return... collapses into a single
      // deterministic hand-off" — so there is no intermediate physics position to draw. `from`
      // is the ramp's own tracked endpoint (`ramp.points`, the SAME array main.js already
      // renders the ramp mesh from — see render-art-follows-physics.test.mjs's sibling checks);
      // `to` is `event.ball.pos`, which physics/world.js's stepRampLayerBall has already set to
      // exactly the real hand-off target (`ramp.exit.pos` on a made shot, the computed rollback
      // landing point otherwise) — read back here rather than recomputed, so it can never drift
      // from what physics actually used.
      const rampId = tag.slice(0, tag.lastIndexOf('_'));
      const ramp = RAMPS_BY_ID[rampId];
      const rampEntry = findBallEntry(event.ball);
      if (ramp && rampEntry) {
        const from = event.rampExit === 'top' ? ramp.points[ramp.points.length - 1] : ramp.points[0];
        rampEntry.presentationTween = startTween(from, event.ball.pos, elapsedS);
      }
      fired.push(tag);
      if (eventLog) eventLog.log(tag);
    } else {
      fired.push(tag);
      if (eventLog) eventLog.log(tag);
    }
  }
  return fired;
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
function buildPopBumperMesh(name, centre, radius) {
  const group = new THREE.Group();
  // Base cylinder drawn at the physics collision radius itself, so the visible edge IS the
  // collision surface — was a hardcoded 0.032 vs the physics 0.030 (POP_SKIRT_RADIUS), with no
  // mesh at the true radius at all (cap sphere 0.028, decorative ring rOut 0.044).
  const skirt = coloredMesh(new THREE.CylinderGeometry(radius, radius, 0.006, 16), 0x8a8a8a);
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
for (const p of popBumpers) tiltGroup.add(buildPopBumperMesh(p.name, p.centre, p.shape.radius));

const slingshotMat = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, metalness: 0.75, roughness: 0.3 });
function buildSlingshotMesh(segments) {
  const group = new THREE.Group();
  for (const seg of segments) {
    const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
    const len = Math.hypot(dx, dy);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.012), slingshotMat);
    const p = toSceneVec((seg.a.x + seg.b.x) / 2, (seg.a.y + seg.b.y) / 2, 0.025);
    bar.position.set(p.x, p.y, p.z);
    bar.rotation.y = Math.atan2(dy, dx);
    group.add(bar);
  }
  return group;
}
tiltGroup.add(buildSlingshotMesh(slingshots.left));
tiltGroup.add(buildSlingshotMesh(slingshots.right));
// A pair of swing-set posts + top bar behind each slingshot, for the "swing set" read.
// Side-post positions read from mech.buildSwingSetPosts() (table/mechanisms.js) — the same
// data the physics layer collides against above — rather than a second, independently-
// hardcoded position list.
const swingSetPostGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.09, 8);
for (const p of swingSetPosts) {
  const mesh = coloredMesh(swingSetPostGeo, 0x777777);
  const sp = toSceneVec(p.centre.x, p.centre.y, 0.045);
  mesh.position.set(sp.x, sp.y, sp.z);
  tiltGroup.add(mesh);
}
// The top crossbar: no collider (mech.buildSwingSetPosts() only returns the two side posts).
// Its lowest point is at scene y = 0.09 - radius(0.004) = 0.086, well above BALL_RADIUS*2
// (0.027) — overhead, same as the TREEHOUSE roof: a ball rolls under it, the side posts are
// the actual colliders. Position read from SWING_SET_APEXES, the same shared apex data.
const swingSetBarGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.07, 8);
for (const apex of mech.SWING_SET_APEXES) {
  const mesh = coloredMesh(swingSetBarGeo, 0x777777);
  mesh.rotation.z = Math.PI / 2;
  const sp = toSceneVec(apex.x, apex.y + 0.02, 0.09);
  mesh.position.set(sp.x, sp.y, sp.z);
  tiltGroup.add(mesh);
}

// Drop-target banks: standing plates, one per target, scaled to 0 height when dropped.
const dropTargetPlateGeo = new THREE.BoxGeometry(0.036, 0.03, 0.006);
function buildDropBankMeshes(bank, color) {
  const meshes = new Map();
  for (const t of bank.targets) {
    const plate = coloredMesh(dropTargetPlateGeo, color);
    const p = toSceneVec(t.centre.x, t.centre.y, 0.015);
    plate.position.set(p.x, p.y, p.z);
    const dx = t.shape.b.x - t.shape.a.x;
    const dy = t.shape.b.y - t.shape.a.y;
    plate.rotation.y = Math.atan2(dy, dx);
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
  // Cylinder at the physics collision radius (was a 20x20mm BoxGeometry over the r=12mm
  // Circle collider — square corners extended 2.1mm past it, flats sat 2mm inside it).
  const trunk = coloredMesh(new THREE.CylinderGeometry(treehouse.shape.radius, treehouse.shape.radius, 0.03, 12), 0x8a5a34);
  trunk.position.y = 0.015;
  group.add(trunk);
  // Roof radius (20mm) is wider than the physics trunk radius (12mm) on purpose: the roof's
  // lowest point sits at y=0.04-0.025/2=0.0275, above BALL_RADIUS*2=0.027 — a ball rolls
  // underneath the overhang and hits only the trunk, which is the physical collider. Accurate,
  // not a mismatch: an overhanging roof is what a treehouse looks like.
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
  // Width read directly off the zone's own span (same idiom as the wall/slingshot/drop-target
  // segments: the real endpoints, not a duplicated width literal) — was a hardcoded 0.03
  // against the physics zone's actual 0.036, the same 30-vs-36 mm pairing the drop targets had.
  const width = Math.hypot(f.zone.b.x - f.zone.a.x, f.zone.b.y - f.zone.a.y);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(width, 0.01, 0.006), mat);
  const mid = { x: (f.zone.a.x + f.zone.b.x) / 2, y: (f.zone.a.y + f.zone.b.y) / 2 };
  const p = toSceneVec(mid.x, mid.y, 0.005);
  bar.position.set(p.x, p.y, p.z);
  tiltGroup.add(bar);
  return { tag: f.tag, mesh: bar, mat };
});

// Spinners: a rotating rod whose spin visualises the click/decay state.
function buildSpinnerMesh(zone) {
  const mid = { x: (zone.a.x + zone.b.x) / 2, y: (zone.a.y + zone.b.y) / 2 };
  const rod = coloredMesh(new THREE.BoxGeometry(mech.SPINNER_BLADE_LENGTH, 0.006, 0.006), 0x333333);
  const p = toSceneVec(mid.x, mid.y, 0.02);
  rod.position.set(p.x, p.y, p.z);
  tiltGroup.add(rod);
  return rod;
}
const tetherballMesh = buildSpinnerMesh(spinnerDefs.tetherball);
const pinwheelMesh = buildSpinnerMesh(spinnerDefs.pinwheel);

// --- T5b: ramp/orbit tracks restyled to the reference photo's world (was flat T5 boxes
// that read as debris against the finished playfield texture). Each ramp still walks its
// own points (x,y,z) as a chain of oriented segments — only the per-segment geometry and
// material changed, per ramp. ------------------------------------------------------------
function segmentSteps(points, fn) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = toSceneVec(points[i].x, points[i].y, points[i].z);
    const b = toSceneVec(points[i + 1].x, points[i + 1].y, points[i + 1].z);
    const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = dir.length();
    if (len < 1e-6) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    fn(mid, dir, len);
  }
}

// THE SLIDE: a yellow plastic frame with an inset white chute, echoing the painted slide
// art on the playfield texture — solid (not translucent) so it reads clearly against the
// warm dim lighting rather than washing out.
const slideFrameMat = new THREE.MeshStandardMaterial({ color: 0xf0c927, metalness: 0.05, roughness: 0.5 });
const slideChuteMat = new THREE.MeshStandardMaterial({ color: 0xf5f0e0, metalness: 0.05, roughness: 0.35 });
function buildSlideMesh(points) {
  const group = new THREE.Group();
  segmentSteps(points, (mid, dir, len) => {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.clone().normalize());
    const frame = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, 0.09), slideFrameMat);
    frame.position.set(mid.x, mid.y, mid.z);
    frame.quaternion.copy(q);
    const chute = new THREE.Mesh(new THREE.BoxGeometry(len * 0.98, 0.012, 0.07), slideChuteMat);
    chute.position.set(0, 0.015, 0); // local offset, rides the frame's own rotation
    frame.add(chute);
    group.add(frame);
  });
  return group;
}

// MONKEY BARS: a thin silver wireform — two parallel steel rails, the way a real habitrail
// overhead ramp looks, rather than a solid slab.
const wireformMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.85, roughness: 0.25 });
function buildMonkeyBarsMesh(points) {
  const group = new THREE.Group();
  segmentSteps(points, (mid, dir, len) => {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(0.011);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0032, len, 8), wireformMat);
      rail.position.set(mid.x + perp.x * side, mid.y, mid.z + perp.z * side);
      rail.quaternion.copy(q);
      group.add(rail);
    }
  });
  return group;
}

// THE TUNNEL: a dull grey-brown concrete culvert — an open-ended pipe (visible from
// inside, so the ball is never hidden) rather than a flat semi-transparent slab.
const culvertMat = new THREE.MeshStandardMaterial({
  color: 0x7d6b58, metalness: 0, roughness: 0.95, side: THREE.DoubleSide,
  transparent: true, opacity: 0.88,
});
function buildTunnelMesh(points) {
  const group = new THREE.Group();
  segmentSteps(points, (mid, dir, len) => {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, len, 16, 1, true), culvertMat);
    pipe.position.set(mid.x, mid.y, mid.z);
    pipe.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    group.add(pipe);
  });
  return group;
}

tiltGroup.add(buildSlideMesh(slide.ramp.points));
tiltGroup.add(buildMonkeyBarsMesh(monkeyBars.ramp.points));
tiltGroup.add(buildTunnelMesh(tunnel.ramp.points));

// THE RAMP GATES: thin chrome wires marking each ramp's entry span, drawn along the gate's
// own real segment endpoints — previously a 44mm zone with no mesh at all, invisible to the
// player. Same rotation convention as the walls: rotation.y = +Math.atan2(dy, dx), never
// negated. CylinderGeometry's default axis is Y (vertical), unlike the walls' BoxGeometry
// whose long axis is already X (horizontal) — so a fixed rotation.z = -Math.PI / 2 lays the
// wire flat first, before the same yaw the walls use. That extra Z rotation is a constant,
// not derived from the segment direction, so it carries no sign-convention ambiguity of its
// own (verified against real endpoints in test/gate-render.test.mjs).
const gateWireMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.9, roughness: 0.2 });
function addGateWireMesh(gate) {
  const dx = gate.b.x - gate.a.x;
  const dy = gate.b.y - gate.a.y;
  const len = Math.hypot(dx, dy);
  const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.0015, len, 10), gateWireMat);
  const p = toSceneVec((gate.a.x + gate.b.x) / 2, (gate.a.y + gate.b.y) / 2, 0.02);
  wire.position.set(p.x, p.y, p.z);
  wire.rotation.z = -Math.PI / 2;
  wire.rotation.y = Math.atan2(dy, dx);
  tiltGroup.add(wire);
}
addGateWireMesh(slide.gate);
addGateWireMesh(monkeyBars.gate);
addGateWireMesh(tunnel.gate);

// THE SANDBOX: a shallow tan pit with a darker rim, drawn at the scoop's actual capture
// radius (not a multiple of it) — true to physics, per the operator's standard: the sand a
// ball visibly sits on IS the region that gets scooped, not a visual overstatement of it.
// SANDBOX_RIM_LIP is rendering-only (how wide the decorative rim reads past the pit edge),
// not a physics quantity, so it stays a local literal rather than a shared constant.
const SANDBOX_RIM_LIP = 0.006;
{
  const group = new THREE.Group();
  const pit = coloredMesh(new THREE.CircleGeometry(sandbox.captureZone.radius, 20), 0xd9c07a);
  pit.rotation.x = -Math.PI / 2;
  pit.position.y = 0.001;
  group.add(pit);
  const rim = coloredMesh(new THREE.RingGeometry(sandbox.captureZone.radius, sandbox.captureZone.radius + SANDBOX_RIM_LIP, 20), 0x8a6339);
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.0015;
  group.add(rim);
  const p = toSceneVec(sandbox.captureZone.centre.x, sandbox.captureZone.centre.y, 0);
  group.position.set(p.x, p.y, p.z);
  tiltGroup.add(group);
}

// --- T8: THE MERRY-GO-ROUND. A small carousel — base, pole, conical roof — that spins
// continuously (doc: "the ride keeps spinning with the ball visibly aboard"), faster once
// multiball is actually running. A locked ball is reparented onto this group at one of
// three 120°-apart mount points so it visibly rides along with the rotation; released
// balls are handed back to tiltGroup and driven by physics again like any other ball. ---
const mgrGroup = new THREE.Group();
{
  const baseMat = new THREE.MeshStandardMaterial({ color: 0xe0a832, metalness: 0.2, roughness: 0.5 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(merryGoRound.radius, merryGoRound.radius, 0.012, 20), baseMat);
  base.position.y = 0.006;
  mgrGroup.add(base);
  const pole = coloredMesh(new THREE.CylinderGeometry(0.006, 0.006, 0.09, 8), 0xb8b8b8);
  pole.position.y = 0.05;
  mgrGroup.add(pole);
  const roof = coloredMesh(new THREE.ConeGeometry(0.05, 0.03, 8), 0x4a7a3a);
  roof.position.y = 0.1;
  mgrGroup.add(roof);
  mgrGroup.userData.roofMat = roof.material;
}
{
  const p = toSceneVec(merryGoRound.centre.x, merryGoRound.centre.y, 0);
  mgrGroup.position.set(p.x, p.y, p.z);
}
tiltGroup.add(mgrGroup);

const MGR_MOUNT_RADIUS = 0.045;
const MGR_BALL_HEIGHT = 0.02;
const MGR_SPIN_IDLE = 0.6; // rad/s — always turning, per the design doc
const MGR_SPIN_MULTIBALL = 2.4;

function mgrSlotLocalPos(slot) {
  const angle = (slot / 3) * Math.PI * 2;
  return { x: MGR_MOUNT_RADIUS * Math.cos(angle), y: MGR_BALL_HEIGHT, z: MGR_MOUNT_RADIUS * Math.sin(angle) };
}

/** A genuine lock (1st or 2nd, or the 3rd on its way into multiballStart's release):
 * reparent the ball's mesh onto the carousel group so it visibly rides the rotation. */
function mountAtMergeGoRound(entry, slot) {
  if (!entry) return;
  tiltGroup.remove(entry.mesh);
  mgrGroup.add(entry.mesh);
  const lp = mgrSlotLocalPos(slot);
  entry.mesh.position.set(lp.x, lp.y, lp.z);
  entry.mgrMounted = true;
}

/** Shared by release and eject: drop the ball at the precomputed clear landing point
 * (mgrRelease — see computeMergeGoRoundRelease) heading out at `speed`. */
function launchFromMergeGoRound(entry, speed) {
  entry.phys.captured = false;
  entry.phys.pos = { x: mgrRelease.pos.x, y: mgrRelease.pos.y };
  entry.phys.vel = { x: mgrRelease.heading.x * speed, y: mgrRelease.heading.y * speed };
}

/** The design doc's "flings all three out at once (staggered 400ms)" and the SANDBOX
 * add-a-ball share this exit path: hand the mesh back to tiltGroup (the per-frame ball-mesh
 * sync takes over from here) and give the ball an outward launch into the main field. */
function releaseFromMergeGoRound(entry, speed) {
  if (!entry) return;
  if (entry.mgrMounted) {
    mgrGroup.remove(entry.mesh);
    tiltGroup.add(entry.mesh);
    entry.mgrMounted = false;
  }
  entry.phys.layer = 'playfield';
  entry.phys.z = 0;
  launchFromMergeGoRound(entry, Math.max(speed, 0.6));
}

/** An unlit pass-through, or a re-lock during an already-active multiball: the ball was
 * physically captured this frame (world.js's checkCaptures always fires on entry) but never
 * mounted, so there's no mesh to reparent — just kick it back out, nudged clear of the
 * capture radius the same way the SANDBOX scoop's eject does. */
function ejectFromMergeGoRound(entry) {
  if (!entry) return;
  launchFromMergeGoRound(entry, 1.4);
}

// The 3 balls mounted while building toward the 3rd lock; consumed (and cleared) the moment
// multiballStart releases them.
let mgrMountedSlots = [];
// Scheduled releases from a 'multiballStart': {entry, atS}, 400ms apart per §4.4.
let mgrReleaseQueue = [];

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

// --- Balls (T8: N-ball, not one global `ball`) ---------------------------------------
// physics/world.js already steps every ball in world.balls each tick (T1); what's new here
// is main.js tracking a *set* of {phys, mesh} pairs instead of one, so multiball locks,
// releases and the SANDBOX add-a-ball can each put another physical ball into play without
// disturbing whichever ball(s) are already rolling.
const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 24, 16);
const ballMat = new THREE.MeshStandardMaterial({ color: 0xcc2222, metalness: 0.2, roughness: 0.4 });
let ballIdSeq = 0;
let balls = [];

function spawnBall(pos, vel) {
  const phys = addBall(world, {
    id: `b${ballIdSeq++}`, pos: { ...pos }, vel: { ...vel },
    radius: BALL_RADIUS, active: true, layer: 'playfield', captured: false, z: 0,
  });
  const mesh = new THREE.Mesh(ballGeo, ballMat);
  tiltGroup.add(mesh);
  const entry = { phys, mesh };
  balls.push(entry);
  return entry;
}

function despawnBall(entry) {
  removeBall(world, entry.phys.id);
  tiltGroup.remove(entry.mesh);
  balls = balls.filter((b) => b !== entry);
}

function findBallEntry(physBall) {
  return balls.find((b) => b.phys === physBall) ?? null;
}

// The ball currently sitting in the launch lane waiting for a manual plunge — set only by a
// normal serve/DO-OVER ('ballServed'/'ballSaved'), never by an auto-plunged post-lock ball,
// a multiball release or an add-a-ball spawn (none of those wait for the player's plunger).
let chuteBall = null;

function serveToChute() {
  chuteBall = spawnBall(recess.LAUNCH_POSITION, { x: 0, y: 0 });
}
serveToChute();

// --- Input: flippers, plunger, nudge ---
let plungerPower = 0;
let charging = false;
// Super skill shot (§4.4): a soft plunge — released under 35% power — dribbles into the
// SANDBOX. Flagged here from the raw release power (not the floored launch speed below,
// which exists only so a very light tap still clears the launch lane) and consumed as a
// synthetic SW_SOFT_PLUNGE tag on the next frame's batch, the same pattern SW_DRAIN uses —
// main.js never calls into rules directly.
const SOFT_PLUNGE_THRESHOLD = 0.35;
let pendingSoftPlunge = false;

wireInput(canvas, {
  flippers,
  onPlungerChange: (p) => {
    charging = true;
    plungerPower = p;
  },
  onPlungerRelease: () => {
    if (charging && chuteBall) {
      if (plungerPower < SOFT_PLUNGE_THRESHOLD) pendingSoftPlunge = true;
      chuteBall.phys.vel = { x: 0, y: Math.max(0.6, plungerPower) * PLUNGER_MAX_SPEED };
      chuteBall = null;
      charging = false;
      plungerPower = 0;
    }
  },
  onNudge: ({ x, y }) => {
    const len = Math.hypot(x, y) || 1;
    for (const b of balls) {
      if (b.phys.captured) continue;
      b.phys.vel = { x: b.phys.vel.x + (x / len) * NUDGE_IMPULSE, y: b.phys.vel.y + (y / len) * NUDGE_IMPULSE };
    }
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

// A single-frame deferral for tags that can only be known *after* this frame's processRules
// call has already returned (the SANDBOX add-a-ball spawn's SW_BALL_ADDED — see the
// 'addABall' display handling below). One frame (~16ms) of lag on that bookkeeping is
// imperceptible and keeps processRules the sole thing that ever mutates rules state.
let pendingNextFrameTags = [];

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  elapsedS += dt;

  // Snapshot each ball's real physics position BEFORE this tick's advance() can teleport it
  // (a ramp exit/rollback, a scoop capture) — the presentation tweens below use this as the
  // real "from" endpoint, never an invented one. Captured every tick (cheap: a plain object
  // copy per ball) because a teleport can land in any tick, not just ones a caller expects.
  for (const entry of balls) entry.prevPos = { x: entry.phys.pos.x, y: entry.phys.pos.y, z: entry.phys.z || 0 };

  const events = advance(world, dt);
  const scoreTags = [...pendingNextFrameTags, ...processMechanismEvents(events)];
  pendingNextFrameTags = [];
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
    if (scoop.ball) {
      scoop.ball.pos = {
        x: sandbox.captureZone.centre.x + (evel.x / evLen) * clear,
        y: sandbox.captureZone.centre.y + (evel.y / evLen) * clear,
      };
      scoop.ball.vel = { x: evel.x, y: evel.y };
      scoop.ball.captured = false;
      // Presentation tween, eject: `from` is the capture zone's own real centre (where the
      // ball has sat, motionless, for the whole hold — the same `sandbox.captureZone.centre`
      // physics/world.js's checkCaptures snapped it to on capture); `to` is `scoop.ball.pos`
      // above, the exact point physics just computed for the eject — read back, not
      // recomputed, so this can never drift from what physics used.
      const ejectedEntry = findBallEntry(scoop.ball);
      if (ejectedEntry) ejectedEntry.presentationTween = startTween(sandbox.captureZone.centre, scoop.ball.pos, elapsedS);
    }
    scoreTags.push(sandbox.eject.tag);
    if (eventLog) eventLog.log(sandbox.eject.tag);
  }

  // T8's staggered multiball release (400ms apart, per §4.4/§9's T8 row) — scheduled by the
  // 'multiballStart' display handling below, drained here so a release due this frame lands
  // in this same frame's scoreTags batch (SW_BALL_ADDED) rather than lagging a frame behind.
  if (mgrReleaseQueue.length > 0) {
    const due = mgrReleaseQueue.filter((r) => elapsedS >= r.atS);
    if (due.length > 0) {
      mgrReleaseQueue = mgrReleaseQueue.filter((r) => elapsedS < r.atS);
      for (const r of due) {
        releaseFromMergeGoRound(r.entry, 1.6);
        scoreTags.push(SW_BALL_ADDED);
      }
    }
  }

  // The drain check is geometric (recess.isDrained), not a physics collision event, but it
  // still goes through the same switch-event queue as everything else — SW_DRAIN/SW_BALL_LOST
  // are pushed onto this frame's tag batch rather than calling into rules state (or
  // respawning a ball) directly. rules/game.js's processEvents is what decides DO-OVER save
  // vs end-of-ball vs "just one of several multiball balls going away"; main.js only reacts
  // to the display events it comes back with. Ball-count-aware (T8): only the truly last
  // live ball's drain is SW_DRAIN — anything draining while others remain live is SW_BALL_LOST,
  // so multiball's own ball count (rules/multiball.js) tracks reality instead of main.js
  // silently ending a ball that still has siblings in play.
  for (const entry of [...balls]) {
    if (entry.phys.captured || !recess.isDrained(entry.phys)) continue;
    if (entry === chuteBall) chuteBall = null;
    despawnBall(entry);
    const liveBallsRemaining = balls.filter((b) => !b.phys.captured).length;
    scoreTags.push(drainTagFor({ liveBallsRemaining }));
  }

  if (pendingSoftPlunge) {
    scoreTags.push(SW_SOFT_PLUNGE);
    pendingSoftPlunge = false;
  }

  const display = processRules(rulesState, scoreTags, elapsedS);
  for (const d of display) {
    if (d.kind === 'ballServed' || d.kind === 'ballSaved') serveToChute();
    // Auto-launch the next ball on a turn change — there's no "plunge to start" menu flow
    // yet (ui/menus.js is T12), so without this the game would silently stop taking balls
    // after the first one ends. gameOver is checked instead so a real end-of-game doesn't
    // immediately re-launch a ball that has nowhere to go.
    if (d.kind === 'turnChange' && !rulesState.gameOver) {
      for (const d2 of launchBall(rulesState, elapsedS)) {
        if (d2.kind === 'ballServed') serveToChute();
      }
    }

    // T8: MERRY-GO-ROUND lock/eject/multiball. Each of these display kinds corresponds 1:1,
    // in emission order, to a queued SW_MERRY_GO_ROUND capture from this same frame's physics
    // events — see mergeGoRoundQueue's doc comment.
    if (d.kind === 'merryGoRoundEject') {
      ejectFromMergeGoRound(findBallEntry(mergeGoRoundQueue.shift()));
    } else if (d.kind === 'lock') {
      const entry = findBallEntry(mergeGoRoundQueue.shift());
      mgrMountedSlots.push(entry);
      mountAtMergeGoRound(entry, d.locks - 1);
    } else if (d.kind === 'lockedBallServed') {
      // "locking ball N serves a new ball" — auto-plunged, not waiting in the chute.
      spawnBall(recess.LAUNCH_POSITION, { x: 0, y: PLUNGER_MAX_SPEED * 0.7 });
    } else if (d.kind === 'multiballStart') {
      // The 3rd lock's own capture is still queued (it triggered this very display event) —
      // it's the third mounted ball, never separately reported via a 'lock' display.
      const thirdEntry = findBallEntry(mergeGoRoundQueue.shift());
      mountAtMergeGoRound(thirdEntry, 2);
      const releasing = [...mgrMountedSlots, thirdEntry];
      mgrMountedSlots = [];
      releasing.forEach((entry, i) => mgrReleaseQueue.push({ entry, atS: elapsedS + i * 0.4 }));
    } else if (d.kind === 'addABall') {
      // The SANDBOX shot that triggered this is a *separate* ball from whichever one the
      // scoop is already timing an ordinary eject for (armed above) — this spawns another.
      // Spawned at sandboxAddABallPlacement (computeEjectPlacement, table/mechanisms.js),
      // not the zone's own centre — spawning at the centre re-captures the ball on the very
      // next physics step, discarding the launch and orphaning the scoop's already-held ball.
      spawnBall(sandboxAddABallPlacement.pos, {
        x: sandboxAddABallPlacement.heading.x * 1.8,
        y: sandboxAddABallPlacement.heading.y * 1.8,
      });
      pendingNextFrameTags.push(SW_BALL_ADDED); // see its declaration below
    } else if (d.kind === 'multiballForceEnd') {
      // A ball ended outright mid-multiball (tilt) — nothing should keep riding the carousel
      // or wait in a staggered release queue into a ball that no longer exists.
      for (const entry of mgrMountedSlots) releaseFromMergeGoRound(entry, 0);
      mgrMountedSlots = [];
      for (const r of mgrReleaseQueue) releaseFromMergeGoRound(r.entry, 0);
      mgrReleaseQueue = [];
    }

    if (eventLog) eventLog.log(`${d.kind}${'tag' in d ? ':' + d.tag : ''}`);
  }

  for (const entry of balls) {
    if (entry.mgrMounted) continue; // carried by mgrGroup's own rotation instead
    // Mid-tween (a ramp exit/rollback or scoop capture/eject fired recently): draw the
    // presentation-only interpolated point instead of snapping straight to entry.phys.pos —
    // physics is already fully at its new position; only the mesh is still catching up.
    let x, y, z;
    if (entry.presentationTween) {
      const tp = tweenPosition(entry.presentationTween, elapsedS);
      x = tp.x; y = tp.y; z = tp.z;
      if (tp.done) entry.presentationTween = null;
    } else {
      x = entry.phys.pos.x; y = entry.phys.pos.y; z = entry.phys.z || 0;
    }
    const p = toSceneVec(x, y, entry.phys.radius + z);
    entry.mesh.position.set(p.x, p.y, p.z);
  }
  for (const flipper of Object.values(flippers)) updateFlipperMesh(flipper);

  const mgrActive = activePlayer(rulesState).multiball.active;
  mgrGroup.rotation.y += (mgrActive ? MGR_SPIN_MULTIBALL : MGR_SPIN_IDLE) * dt;
  mgrGroup.userData.roofMat.color.set(activePlayer(rulesState).multiball.lockLit ? 0xffee55 : 0x4a7a3a);

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

  const player = activePlayer(rulesState);
  hud.textContent = rulesState.gameOver
    ? `GAME OVER — ${player.score.toLocaleString()}`
    : `P${(rulesState.turnIndex % rulesState.numPlayers) + 1} BALL ${player.ball}  SCORE ${player.score.toLocaleString()}`;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__pinball = {
  world, flippers, advance, isDrained: recess.isDrained,
  get ball() { return balls[0]?.phys; }, // the primary/first ball, for single-ball-era scripts
  get balls() { return balls.map((b) => b.phys); },
  rulesState, activePlayer: () => activePlayer(rulesState),
  hopscotchBankState, sandBankState, funLamps, tetherballSpinner, pinwheelSpinner,
  slide, monkeyBars, tunnel, sandbox, scoop, merryGoRound,
};
