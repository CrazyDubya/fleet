import * as THREE from 'three';
import { createScene, toSceneVec } from './render/scene.js';
import { startTween, tweenPosition } from './render/presentationTween.js';
import { createWorld, addBall, removeBall, addFlipper, advance } from './physics/world.js';
import { createFlipper, setActive } from './physics/flipper.js';
import { BALL_RADIUS, PLUNGER_MAX_SPEED, NUDGE_IMPULSE, PITCH_DEG } from './physics/constants.js';
import * as recess from './table/recess.js';
import * as mech from './table/mechanisms.js';
import { buildTable, wireTable } from './table/assemble.js';
import {
  SW_SOFT_PLUNGE,
  SW_FUN, SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  SW_KICKBACK,
  SW_HOPSCOTCH, SW_SAND, SW_TREEHOUSE,
  SW_SLIDE_ENTER, SW_MONKEYBARS_ENTER, SW_TUNNEL_ENTER, SW_ORBIT_ENTER, SW_DIVERTER_ENTER,
  SW_SANDBOX_ENTRY, SW_SANDBOX_EJECT,
  SW_MERRY_GO_ROUND, SW_BALL_ADDED,
  drainTagFor, mechanismTags,
} from './table/switches.js';
import * as game from './game/mechanisms.js';
import { createGame, launchBall, processEvents as processRules, activePlayer, tiltBall, slamTilt } from './rules/game.js';
import { MODE_SHOT_TAGS } from './rules/modes.js';
import * as tilt from './rules/tilt.js';
import { wireInput } from './ui/input.js';
import { isDebugEnabled, mountDebugPanel, mountEventLog } from './ui/debug.js';
import { createCalloutLayer } from './ui/callouts.js';
import { createMomentScreen, bonusBreakdownLines } from './ui/moment-screen.js';
import { insertScore, loadHighScores, saveHighScores, highScoreLines } from './ui/high-scores.js';

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
  spinnerDefs, swingSetPosts, kickback, slide, monkeyBars, tunnel, orbit, sandbox, merryGoRound,
  diverter, ejectionSites, mgrRelease, sandboxAddABallPlacement,
} = table;

// DIV-2 (2026-09-05): wired once, here, not per-frame — physics/world.js's tryEnterGate calls
// this synchronously at the moment of a successful entry, before it moves on to the next ball
// in the same substep (see that file's own comment). This is what makes a second ball crossing
// the gate in the same tick take the OTHER route rather than reading the same stale toLayer:
// the flip now happens as part of THIS ball's own entry, not deferred to a later pass over all
// of the tick's events. Returns the route this ball actually took (or null on a corrupt
// toLayer, already console.error'd inside currentDiverterRoute) so the event consumer below
// doesn't have to re-derive it from state a later-in-this-tick entry may have already changed.
diverter.gate.gate.onEnter = () => {
  const route = game.currentDiverterRoute(diverter);
  if (route === null) return null;
  game.setDiverterRoute(diverter, route === 'A' ? 'B' : 'A');
  return route;
};

// Wood-tone side rails + chrome lane/apron guides, sampled from the reference photo's
// worn pine border and chrome slingshot/corner plates (was flat gold/blue placeholder).
const wallColorByTag = {
  left: 0xc9a267, top: 0xc9a267, // worn pine rail
  'apron-left': 0x5a5a5a, 'apron-right': 0x5a5a5a, // dark chrome corner plate
  'lane-outer': 0xb8b8b8, 'lane-inner': 0xb8b8b8, 'lane-floor': 0xb8b8b8, // chrome lane guide
  'lane-deflector': 0xb8b8b8, 'lane-gate': 0xb8b8b8,
  'outlane-divider-left': 0xb8b8b8, 'outlane-divider-right': 0xb8b8b8, // same chrome guide-rail finish as the lane guides — a real machine's outlane/inlane divider is the same metal stock
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
const kickbackState = game.createKickback();
// TILT (design §4.4): the bob and its "flippers died" flag both reset on 'ballServed' (a
// genuinely new ball) — see the display-handling loop below. A DO-OVER re-serve ('ballSaved')
// does NOT reset either: it's the same ball continuing, and the design's "resets each ball"
// means a new ball, not a save.
const tiltBob = tilt.createTiltBob();
let flippersDisabled = false;
const callouts = createCalloutLayer();
const momentScreen = createMomentScreen();
// GAME-POLISH: rules/modes.js's own internal names, mapped to what the design doc actually
// calls each mode (§4.4) — a 'modeStart'/'modeEnd' display event carries the internal name
// (e.g. 'HIDE_SEEK'), never the player-facing one.
const MODE_DISPLAY_NAMES = { KICKBALL: 'KICKBALL', HIDE_SEEK: 'HIDE & SEEK', DODGEBALL: 'DODGEBALL', JUMP_ROPE: 'JUMP ROPE' };
// CALLOUT-1: TEACHER'S WATCHING describes CURRENT, ongoing risk ("you have a warning against
// you right now") — it stops being true the instant the ball it warned about ends, so it's
// tied to this ball's own generation number and ended the moment a new one is served (see the
// 'ballServed' branch below). SENT TO THE PRINCIPAL / SLAM TILT / SUPER JACKPOT! all describe
// something that ALREADY HAPPENED (an award, a game-over) — true forever, so those stay
// unscoped, same as before this fix. See ui/callouts.js's own doc comment for the general rule.
let ballGeneration = 0;
// MOMENT-SCOPE (haiku-opencode2's review, 20260905-moment-screen-review.md): the bonus
// moment screen for ball G is shown in the SAME synchronous display batch as the turnChange
// that serves ball G+1 (endOfBall pushes 'bonus' near the top of its return array, 'turnChange'
// at the end — both processed in one applyDisplayEvents pass, no frame in between). Clearing
// scope `ballGeneration` in onNewBall, the way callouts.endScope does, would therefore clear
// the moment that was JUST shown a few lines earlier in this same call, before a single frame
// ever paints it. `previousBallGeneration` lags one ball behind on purpose: onNewBall clears
// the ball BEFORE the one that just ended, never the one that just ended — so ball G's bonus
// screen survives ball G+1's entire play (or its own timer, whichever is shorter) and is only
// force-cleared once ball G+2 begins, if nothing ever replaced it (ball G+1 scored zero).
let previousBallGeneration = -1;
// MOMENT-SCOPE: a separate counter for game-scoped moments (the high-score table), never the
// same numeric space as ballGeneration — see moment-screen.js's own doc comment on why a
// bare integer would risk an accidental cross-scope match. No new-game flow exists yet to
// increment this (T12); declared now so the high-score screen's scope is correctly shaped
// while there's only one caller, per the dispatch.
let gameGeneration = 0;

/** Everything that resets on a genuinely new ball (design §4.4's "resets each ball" for tilt,
 * plus the kickback's once-per-ball rearm and CALLOUT-1's own ball-generation scope) —
 * factored out since it's needed at both 'ballServed' sites below (a direct serve, and the one
 * inside a turnChange's own launchBall call). `callouts.endScope` runs BEFORE the generation
 * bumps, ending whatever the ball that just finished was showing (see ui/callouts.js's own doc
 * comment on why only the warning callout is scoped this way). `momentScreen.endScope` uses
 * the LAGGED generation — see this file's own doc comment above on why it can't use the same
 * one callouts does. */
function onNewBall() {
  game.resetKickbackForNewBall(kickbackState);
  tilt.resetTiltBob(tiltBob);
  flippersDisabled = false;
  callouts.endScope(ballGeneration);
  momentScreen.endScope(`ball:${previousBallGeneration}`);
  previousBallGeneration = ballGeneration;
  ballGeneration += 1;
}
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
const MECHANISM_TAGS = mechanismTags({ slide: slide.ramp.id, monkeyBars: monkeyBars.ramp.id, tunnel: tunnel.ramp.id, orbit: orbit.ramp.id });

// Looked up by a ramp's own id (the same id its `_exit`/`_rollback` tags are built from, per
// switches.js's mechanismTags) so the presentation tween below can read that ramp's own real
// `points`/`exit` — never a duplicated coordinate. `[ramp.id]: ramp` keys off the SAME `.ramp`
// object main.js already renders from (buildSlideMesh(slide.ramp.points) etc, per fs2's audit).
const RAMPS_BY_ID = { [slide.ramp.id]: slide.ramp, [monkeyBars.ramp.id]: monkeyBars.ramp, [tunnel.ramp.id]: tunnel.ramp, [orbit.ramp.id]: orbit.ramp };

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
    } else if (tag === SW_SLIDE_ENTER || tag === SW_MONKEYBARS_ENTER || tag === SW_TUNNEL_ENTER || tag === SW_ORBIT_ENTER) {
      // Only a successful gate entry (the ball actually switched layers) is worth logging —
      // a slow crossing that didn't clear RAMP_ENTRY_MIN_SPEED fires the same tag but never
      // transitions (see physics/world.js's tryEnterGate).
      if (event.gateEntered) {
        fired.push(tag);
        if (eventLog) eventLog.log(tag);
      }
    } else if (tag === SW_DIVERTER_ENTER) {
      // The production caller game/mechanisms.js's setDiverterRoute needed (2026-09-05, an
      // outside review caught it): without this, the diverter was hardwired to route A
      // forever — a runtime-switchable API with nothing in the running game ever calling it.
      // Design choice, no real-machine source: alternates on every successful entry (real
      // diverters commonly do exactly this — flip after each ball through). Only a real gate
      // entry alternates it, same "gateEntered, not just a slow graze" guard as the ramp
      // gates above, so a ball merely grazing the mouth below RAMP_ENTRY_MIN_SPEED can't
      // silently flip the route without ever actually taking a path.
      //
      // DIV-2 (2026-09-05): the flip itself no longer happens here — it already ran inside
      // physics/world.js's tryEnterGate, via the onEnter hook wired above, at the moment of
      // THIS ball's own entry. Re-deriving it here (a second call to currentDiverterRoute)
      // used to be flat-out wrong in multiball: with two balls crossing the same gate mouth in
      // one physics substep (reachable, since no two balls ever collide — nothing keeps them
      // more than a tick apart), both would read the SAME pre-flip toLayer during physics, and
      // this later re-derivation, run once per event after every substep in the frame had
      // already completed, could not tell them apart — the two flips cancelled to a net no-op,
      // and both balls had already been physically routed identically besides. Reading
      // event.hookResult instead — the route recorded AT the moment of entry, before anything
      // later in the same tick could change it again — fixes both halves: each ball's own
      // score/log reflects the route IT actually took, and (since the flip now runs inside
      // physics, in ball-processing order) a second ball in the same tick is also physically
      // routed to the other ramp. A corrupt toLayer still yields null (already console.error'd,
      // rate-limited, inside currentDiverterRoute) and withholds only this one event's
      // score/log — the ball itself already physically transited regardless, and every other
      // event this frame is unaffected either way.
      if (event.gateEntered && event.hookResult !== null) {
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
    } else if (tag === SW_KICKBACK) {
      // The physics-level contact always fires this tag (passive collider, no unconditional
      // .kick — see table/mechanisms.js's buildKickback); tryKickback is the actual lit/
      // once-per-ball decision, and only overrides the ball's velocity when it says yes.
      if (game.tryKickback(kickbackState)) {
        event.ball.vel = { x: kickback.kick.vel.x, y: kickback.kick.vel.y };
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

// Left outlane kickback — a lit/unlit rail, not a dome (nothing to bounce off overhead, unlike
// a pop bumper): a short cylinder drawn at the physics collision radius itself, colored by lit
// state (checked and re-set every frame below, so a future relight mechanism needs no render
// change).
const kickbackLitMat = new THREE.MeshStandardMaterial({ color: 0xffcc33, metalness: 0.3, roughness: 0.4 });
const kickbackUnlitMat = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.3, roughness: 0.6 });
function buildKickbackMesh(centre, radius) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.01, 16), kickbackLitMat);
  const p = toSceneVec(centre.x, centre.y, 0.005);
  mesh.position.set(p.x, p.y, p.z);
  return mesh;
}
const kickbackMesh = buildKickbackMesh(kickback.centre, kickback.shape.radius);
tiltGroup.add(kickbackMesh);

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

// THE ORBIT: a wireform loop, same technique as MONKEY BARS above (two parallel rails) rather
// than a second culvert — it's an open-air loop over the top of the table, not an enclosed
// tube. Added 2026-09-05: the orbit shipped with real physics (table/ramps.js's buildOrbitRamp)
// and its own reachability sweep, but no mesh — a real, playable ramp with nothing drawn for
// it, found while extending this file's own render-audit to cover every mesh builder rather
// than let that gap stand unexamined.
const orbitWireformMat = new THREE.MeshStandardMaterial({ color: 0xb8c8d8, metalness: 0.8, roughness: 0.3 });
function buildOrbitMesh(points) {
  const group = new THREE.Group();
  segmentSteps(points, (mid, dir, len) => {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(0.011);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0032, len, 8), orbitWireformMat);
      rail.position.set(mid.x + perp.x * side, mid.y, mid.z + perp.z * side);
      rail.quaternion.copy(q);
      group.add(rail);
    }
  });
  return group;
}

tiltGroup.add(buildSlideMesh(slide.ramp.points));
tiltGroup.add(buildMonkeyBarsMesh(monkeyBars.ramp.points));
tiltGroup.add(buildTunnelMesh(tunnel.ramp.points));
tiltGroup.add(buildOrbitMesh(orbit.ramp.points));

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
const SANDBOX_UNLIT_COLOR = 0xd9c07a;
let sandboxPitMat;
{
  const group = new THREE.Group();
  const pit = coloredMesh(new THREE.CircleGeometry(sandbox.captureZone.radius, 20), SANDBOX_UNLIT_COLOR);
  sandboxPitMat = pit.material;
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
  // Presentation tween, release: while mgrMounted, entry.mesh.position is LOCAL to the
  // rotating mgrGroup — its real world position depends on mgrGroup's current rotation, which
  // changes every frame. getWorldPosition() (still parented, before the reparent below) reads
  // THREE's own transform pipeline for the exact rendered position, the same way every other
  // number here comes from something physics/rendering already computed rather than a
  // re-derived angle. Converted back to physics space via toSceneVec's own inverse
  // (x, y=-z, z=y — see render/scene.js) so this tween is expressed the same way the other
  // four hand-offs' tweens are, and the render loop's single tweenPosition/toSceneVec
  // consumption path (render-handoffs.test.mjs) needs no special case for this one.
  if (entry.mgrMounted) {
    const worldPos = new THREE.Vector3();
    entry.mesh.getWorldPosition(worldPos);
    mgrGroup.remove(entry.mesh);
    tiltGroup.add(entry.mesh);
    entry.mgrMounted = false;
    entry.presentationTween = startTween(
      { x: worldPos.x, y: -worldPos.z, z: worldPos.y },
      { x: mgrRelease.pos.x, y: mgrRelease.pos.y, z: 0 },
      elapsedS,
    );
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
  // Presentation tween: never mounted, so the mesh has sat at the capture zone's own centre
  // (world.js's checkCaptures) since entry — the same real point the SANDBOX scoop's capture
  // tween reads from, here for the same reason.
  entry.presentationTween = startTween(merryGoRound.centre, { x: mgrRelease.pos.x, y: mgrRelease.pos.y, z: 0 }, elapsedS);
  launchFromMergeGoRound(entry, 1.4);
}

// The 3 balls mounted while building toward the 3rd lock; consumed (and cleared) the moment
// multiballStart releases them.
let mgrMountedSlots = [];
// Scheduled releases from a 'multiballStart': {entry, atS}, 400ms apart per §4.4.
let mgrReleaseQueue = [];

// FIELD DAY (T9): the ball that hit TREEHOUSE is already in play (it's a standup target, not
// a capture — nothing to release), so getting to the design doc's "4-ball multiball" means
// spawning 3 NEW balls rather than releasing already-mounted ones. Scheduled the same way
// mgrReleaseQueue's own 3 releases are (400ms apart) so all 4 don't materialise stacked on
// the exact same point in the same frame: {atS} only — there's no existing ball entry to
// carry like mgrReleaseQueue's release does, spawnBall creates a fresh one when each fires.
let fieldDayReleaseQueue = [];

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

// TROUGH AND SERVE (2026-09-05): every ordinary drain below physically returns its ball to
// this trough (game.captureInTrough); every ordinary serve now pulls the next one back out
// (game.serveFromTrough) rather than an unconditional spawn — the mechanism this game used to
// fake by just creating a fresh ball object on every serve with nothing tracking whether one
// was actually "available". A locked ball (mounted on the merry-go-round) or an add-a-ball
// never touches the trough at all — deliberately: those balls are physically elsewhere, not
// waiting in the under-playfield channel, so pulling them through the trough queue would be
// modelling a path they never take.
//
// Lifecycle, checked (2026-09-05, an outside review asked whether this persists across
// "games"): it does not need special-case resetting on game-over, because there is currently
// no soft-restart path in this file for it to leak state ACROSS in the first place. `rulesState`
// (below), `ballIdSeq`, `chuteBall`, `kickbackState` and this trough are all plain module-level
// bindings created exactly once, at module load; `rulesState.gameOver` going true only changes
// what the HUD displays (see the HUD text check near the bottom of this file) and disables the
// turn-change auto-launch — nothing anywhere calls `createGame`/`createTrough` a second time,
// and no "New Game" control exists yet that would need to. The ONLY way this session ever
// starts over is a full page reload, which re-executes this whole module and recreates every
// one of those bindings fresh, trough included. If a future dispatch adds a soft restart (a
// "New Game" button that doesn't reload the page), THAT dispatch needs to reset this trough
// alongside rulesState/kickbackState/ballIdSeq as one unit — there is no restart path today for
// this comment to wire into.
const troughState = game.createTrough();

function serveToChute() {
  // TROUGH-1 (false-coverage audit, haiku-fs2 20260905T225000Z): this used to read
  // `if (served === null) { warn }` immediately followed by an UNCONDITIONAL spawn below —
  // structured like a guard that protects the spawn, when the spawn never actually depended
  // on `served` at all. A reader checking "what happens on an empty trough?" found the warn
  // and reasonably assumed the empty case was handled; it wasn't.
  //
  // Not fixed by making the spawn conditional: this game has no fixed total-ball pool (see
  // createTrough's own doc comment) — every serve is a freshly spawned object, never drawn
  // from a finite stock the trough actually limits. "Return without spawning" has no defined
  // recipient: the player would simply have no ball, with nothing in this codebase (no
  // game-over path, no retry, no alternate source) to do about it. Inventing that recovery
  // behavior is a real design question — what SHOULD happen if drain/serve genuinely
  // desyncs, a case that would itself be a bug elsewhere, not a normal trough state — and
  // isn't answered here.
  //
  // So: the trough's serve-side count is diagnostic bookkeeping (verified by
  // test/trough.test.mjs's own balance assertions), not a supply gate. Kept honestly
  // separate below — a warning that reports an anomaly, not a check that pretends to act on
  // one — rather than removing the trough call outright, since the balance signal itself is
  // real and worth keeping even though it doesn't block anything.
  const served = game.serveFromTrough(troughState);
  if (served === null) {
    console.warn('serveToChute: trough reported empty on an ordinary serve — drain/serve count has drifted out of balance (diagnostic only; a ball is served regardless).');
  }
  chuteBall = spawnBall(recess.LAUNCH_POSITION, { x: 0, y: 0 });
}
serveToChute();

// TILT (design §4.4): physically drains every ball actually in play — mirrors the ordinary
// per-frame drain loop's own convention of skipping a `captured` ball (one pinned in the
// SANDBOX scoop or mounted on the merry-go-round isn't rolling on the playfield to begin with;
// multiball's own forceEnd, invoked by rules/game.js's tiltBall, already handles clearing a
// mounted/locked slot). Called directly, not via the ordinary SW_DRAIN switch-tag path — a
// tilt bypasses ball-save outright rather than merely failing its window check, so it must not
// go through the same queue that lets a normal drain ask "is this within the save window?".
function drainAllBallsForTilt() {
  for (const entry of [...balls]) {
    if (entry.phys.captured) continue;
    if (entry === chuteBall) chuteBall = null;
    despawnBall(entry);
    game.captureInTrough(troughState, elapsedS);
  }
}

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
    // TILT (design §4.4): the SAME raw {x,y} this callback already receives, fed into the
    // tilt bob (rules/tilt.js) — see TILT-1B, no new input detection needed. A nudge can
    // itself be the thing that crosses a warning threshold (checked instantly here) or, for a
    // single very large nudge, the slam-tilt threshold outright.
    const nudgeResult = tilt.nudgeTiltBob(tiltBob, { x, y });
    if (nudgeResult === 'warning') {
      callouts.show("TEACHER'S WATCHING", { scope: ballGeneration });
    } else if (nudgeResult === 'tilt') {
      applyDisplayEvents(tiltBall(rulesState, elapsedS));
    } else if (nudgeResult === 'slam') {
      applyDisplayEvents(slamTilt(rulesState, elapsedS));
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

/** Reacts to a batch of rules-layer display events — physically spawning/reparenting balls,
 * launching the next player's ball, clearing merry-go-round queues, logging. Extracted from
 * the frame loop (was inline) so a tilt/slam-tilt result — which ends a ball OUTSIDE the
 * ordinary switch-tag queue, see tiltBall/slamTilt's own doc comments in rules/game.js — can
 * feed its own display array through the SAME reactions (ballServed re-arming the kickback,
 * turnChange auto-launching the next ball, multiballForceEnd clearing MGR queues) instead of
 * this file growing a second, parallel copy of that handling. */
function applyDisplayEvents(display) {
  for (const d of display) {
    if (d.kind === 'ballServed' || d.kind === 'ballSaved') serveToChute();
    if (d.kind === 'ballSaved') {
      // PLAYTEST-2: found by actually playing it — a DO-OVER re-serve was completely silent.
      // The ball vanishes from wherever it drained and reappears sitting in the chute, same
      // score, same ball number, needing a fresh plunge nothing prompts for. Without this, it
      // reads as the game having glitched, not as a save.
      callouts.show('BALL SAVED', { durationMs: 1800 });
    }
    // A genuinely NEW ball (not a DO-OVER 'ballSaved' — see game/mechanisms.js's
    // resetKickbackForNewBall doc comment for why the two are treated differently) re-arms
    // the kickback's once-per-ball use, and — TILT (design §4.4: "resets each ball") — the
    // bob and the "flippers died" flag.
    if (d.kind === 'ballServed') {
      onNewBall();
    }
    // Auto-launch the next ball on a turn change — there's no "plunge to start" menu flow
    // yet (ui/menus.js is T12), so without this the game would silently stop taking balls
    // after the first one ends. gameOver is checked instead so a real end-of-game doesn't
    // immediately re-launch a ball that has nowhere to go.
    if (d.kind === 'turnChange' && !rulesState.gameOver) {
      for (const d2 of launchBall(rulesState, elapsedS)) {
        if (d2.kind === 'ballServed') {
          serveToChute();
          onNewBall();
        }
      }
    }

    // GAME-POLISH: a mode starting or ending had NO player-facing signal at all before this —
    // found by actually playing the game (see the handoff): the HUD doesn't show a mode name
    // anywhere, and ui/callouts.js already exists and is already used for TILT/SUPER JACKPOT/
    // FIELD DAY, so this is the same channel, not a new one.
    if (d.kind === 'modeStart') {
      callouts.show(MODE_DISPLAY_NAMES[d.mode] ?? d.mode, { durationMs: 2200 });
    } else if (d.kind === 'modeEnd') {
      const name = MODE_DISPLAY_NAMES[d.mode] ?? d.mode;
      callouts.show(d.success ? `${name} COMPLETE` : `${name} OVER`);
    } else if (d.kind === 'extraBall') {
      // RECESS METER's own two awards (§4.4: "Filling it awards EXTRA BALL ... then SPECIAL")
      // — same silent-award gap as modeStart/multiballStart, same fix.
      callouts.show('EXTRA BALL!', { durationMs: 2200 });
    } else if (d.kind === 'special') {
      callouts.show('SPECIAL!', { durationMs: 2200 });
    } else if (d.kind === 'score' && d.tag === 'multiball_jackpot') {
      // SIGNAL-LOST (display-event transit audit, haiku-fs2 20260905T215000Z): 'score' fires
      // for every scorable shot on the table — bumpers, slings, ramps, mode shots, skill
      // shots — and only 'multiball_jackpot' (below) gets a callout. Deliberate, not an
      // oversight left over from an incomplete wiring pass: the HUD already shows the running
      // total every frame, and a distinct popup for every single shot would be exactly the
      // "announces everything" failure mode this table has already drawn the opposite line
      // against twice today (LIT-WIRE's "do not light everything," this same dispatch's own
      // "do not add seven callouts"). The tags that DO get their own announcement
      // (multiball_jackpot here, plus lock/jackpotValue/bonusX/lockNotLit elsewhere in this
      // same loop) are the ones large or rare enough that a player needs the specific number
      // or reason, not just a bigger HUD total.
      // CALLOUT-2: the largest scoring event on the table (500,000-16,000,000, per
      // multiball.js's JACKPOT_MAX_VALUE) had no announcement at all. Says the value —
      // a flat "JACKPOT!" would say the same thing for a 500,000 collection and a
      // relocked-up-to-32x 16,000,000 one, wasting the reason this callout exists.
      callouts.show(`JACKPOT ${d.points.toLocaleString()}`, { durationMs: 2200 });
    } else if (d.kind === 'bonus') {
      // HUD-BUILD: the rules already compute a full breakdown (playtime/shots/modes,
      // ×bonusX) and nothing ever showed it — haiku-fs2's HUD inventory. A moment screen
      // (ui/moment-screen.js), not the one-line callout layer: this is several lines of "what
      // this ball was made of," not a transient announcement, and it needs to hold long
      // enough to actually read, not flash by like TILT's own warnings do. bonusBreakdownLines
      // returns null for a zero bonus (see its own doc comment) — nothing shows in that case.
      const lines = bonusBreakdownLines(d);
      // MOMENT-SCOPE: scoped to the CURRENT (not yet incremented) ballGeneration — the ball
      // this bonus describes — so onNewBall's lagged clear (see its own doc comment) can find
      // and end it exactly two balls later if nothing ever replaced it.
      if (lines) momentScreen.show(lines, { durationMs: 4200, scope: `ball:${ballGeneration}` });
    } else if (d.kind === 'lockNotLit') {
      // HISCORE (situational-events sweep): an unlit lock attempt looked identical, from the
      // player's side, to a shot that simply missed. Says explicitly why nothing locked.
      callouts.show('LOCK NOT LIT', { durationMs: 1400 });
    } else if (d.kind === 'jackpotValue') {
      // HISCORE: a relock during active multiball silently doubled the jackpot — the same
      // "say the value" convention CALLOUT-2/JACKPOT-1 already established for jackpot-sized
      // numbers, applied to the one jackpot-value change that had never gotten it.
      callouts.show(`JACKPOT RAISED TO ${d.value.toLocaleString()}`, { durationMs: 2000 });
    } else if (d.kind === 'bonusX') {
      // SIGNAL-LOST (display-event transit audit, haiku-fs2 20260905T215000Z): rules pushed
      // 'bonusX' from four call sites — F-U-N completion, a HANG TIME reward, FIELD DAY's own
      // lock/unlock — with clear intent to tell the player their multiplier changed, and
      // nothing ever matched the kind. The multiplier is the thing a player tracks most
      // closely (the audit's own words); this is the one addition in that sweep, alongside
      // the jackpot-relock announcement above — everything else the sweep found is either
      // already covered or deliberately left silent (see the comments at each of those sites).
      callouts.show(`BONUS X${d.value}`, { durationMs: 1600 });
    } else if (d.kind === 'gameOver') {
      // HISCORE: last item in the HUD backlog. Same moment-screen surface the bonus
      // breakdown uses, per haiku-fs2's own recommendation to share it rather than each
      // screen inventing its own. thisScore <= 0 shows nothing — same "say nothing" rule the
      // bonus screen uses, and for the same reason: an empty/placeholder table for a
      // 0-point game reads as an achievement it isn't. A scoreless game also isn't inserted
      // into the persisted table at all (nothing worth remembering).
      const thisScore = d.scores[0] ?? 0;
      if (thisScore > 0) {
        const scores = insertScore(loadHighScores(window.localStorage), thisScore);
        saveHighScores(scores, window.localStorage);
        const lines = highScoreLines(scores, thisScore);
        // MOMENT-SCOPE: game-scoped, not ball-scoped — namespaced `game:` so this can never
        // collide with a `ball:`-scoped bonus screen reaching the same integer by
        // coincidence. Nothing clears this scope today (no new-game flow exists yet — see
        // PLAYTEST-2's own finding that gameOver is a dead end until page reload), so in
        // practice this lives out its own 6s timer uncontested; the shape is still correct
        // now, while there's only one caller, for whenever a restart flow (T12) exists.
        if (lines) momentScreen.show(lines, { durationMs: 6000, scope: `game:${gameGeneration}` });
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
      // CALLOUT-2: a ball locking toward multiball had no announcement — the second of the
      // two largest silent scoring/state events the coverage review found (see the jackpot
      // callout above). Says which lock (1 or 2; the 3rd never reaches here — it's reported
      // via 'multiballStart' instead, same as it always was).
      callouts.show(`LOCK ${d.locks}`, { durationMs: 1800 });
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
      // GAME-POLISH: the 3-ball release used to be silent — no distinct signal from an
      // ordinary single ball rolling back into play. §4.3's own name for this ("Locks and
      // multiball — RECESS MULTIBALL").
      callouts.show('RECESS MULTIBALL!', { durationMs: 2200 });
    } else if (d.kind === 'multiballEnd') {
      callouts.show('MULTIBALL OVER');
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
    } else if (d.kind === 'multiballForceEnd' || d.kind === 'fieldDayForceEnd') {
      // A ball ended outright mid-multiball (tilt, or any other forced end) — nothing should
      // keep riding the carousel or wait in a staggered release queue into a ball that no
      // longer exists. Also covers the (rare) case a lock was mid-build when FIELD DAY itself
      // started (rules/multiball.js's startFieldDay clears the LAMP but not any already-
      // mounted balls) and then a tilt force-ends the run.
      for (const entry of mgrMountedSlots) releaseFromMergeGoRound(entry, 0);
      mgrMountedSlots = [];
      for (const r of mgrReleaseQueue) releaseFromMergeGoRound(r.entry, 0);
      mgrReleaseQueue = [];
      if (d.kind === 'fieldDayForceEnd') {
        // A single `else if` chain only ever runs ONE branch per display event — this has to
        // be handled here (not in a separate 'fieldDayForceEnd' branch further down) or it
        // would silently never fire alongside the cleanup above.
        callouts.show('FIELD DAY OVER');
        fieldDayReleaseQueue = [];
      }
    } else if (d.kind === 'tilt') {
      // TILT (design §4.4): "flippers die, the ball drains ... no ball save" — the rules side
      // (rules/game.js's tiltBall) already ended the ball with no bonus and no save; this is
      // the physical half main.js owns (the ball objects, the flipper input).
      drainAllBallsForTilt();
      flippersDisabled = true;
      callouts.show("SENT TO THE PRINCIPAL");
    } else if (d.kind === 'slamTilt') {
      callouts.show('SLAM TILT');
    } else if (d.kind === 'superJackpotAwarded') {
      // JACKPOT-1: the same transient callout layer TILT-1B built (ui/callouts.js) — no
      // second message channel, per that dispatch's own instruction.
      callouts.show('SUPER JACKPOT!');
    } else if (d.kind === 'fieldDayStart') {
      // T9: the ball that hit TREEHOUSE stays in play (a standup target, not a capture) —
      // schedule 3 NEW balls, staggered like every other multi-ball release on this table, to
      // reach the design doc's "4-ball multiball".
      const startAtS = elapsedS;
      for (let i = 0; i < 3; i++) fieldDayReleaseQueue.push({ atS: startAtS + (i + 1) * 0.4 });
      callouts.show('FIELD DAY!', { durationMs: 2400 });
    } else if (d.kind === 'fieldDayEnd') {
      // Same channel as every other transient message here (ui/callouts.js) — no second one.
      callouts.show('FIELD DAY COMPLETE');
      fieldDayReleaseQueue = [];
    }

    if (eventLog) eventLog.log(`${d.kind}${'tag' in d ? ':' + d.tag : ''}`);
  }
}

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
  const frameMechanismTags = [...pendingNextFrameTags, ...processMechanismEvents(events)];
  pendingNextFrameTags = [];
  // SEAM-1 (2026-09-05): this frame's real physical collisions (frameMechanismTags — a MONKEY
  // BARS exit switch, say) are processed and scored NOW, before the tilt check below, rather than
  // batched with the rest of the frame's tags into one processRules call at the very end. A
  // ball that genuinely landed a lit super jackpot this frame must bank it before a same-frame
  // tilt (tickTiltBob's decay can cross threshold with no nudge at all — see its own comment
  // below) gets a chance to force-end multiball and clear superJackpotLit first. Previously
  // both were folded into a single end-of-frame scoreTags array, so a same-frame tilt's
  // synchronous forceEnd (called immediately below) always won regardless of which physical
  // event actually happened first within the frame — silently downgrading an earned 1,500,000
  // point super jackpot to its 150,000 point ordinary value with no signal anywhere that this
  // happened (test/tilt-jackpot-frame-order.test.mjs reproduces it). Tags discovered LATER in
  // this same frame (sandbox eject, staggered multiball releases, drains, soft plunge — all
  // below) still go through the ordinary end-of-frame call further down, so tilt still
  // correctly beats any of THOSE same-frame events (e.g. a coincidental same-frame drain),
  // exactly as before; only this one class of already-happened collision is reordered ahead of
  // a tilt that hasn't been decided yet.
  applyDisplayEvents(processRules(rulesState, frameMechanismTags, elapsedS));
  const scoreTags = [];
  game.tickDropBank(hopscotchBankState, elapsedS);
  game.tickDropBank(sandBankState, elapsedS);
  game.tickSpinner(tetherballSpinner, dt);
  game.tickSpinner(pinwheelSpinner, dt);

  // TILT (design §4.4): steps the bob's own damped-oscillator decay forward by this frame's
  // dt (see rules/tilt.js's own doc comment on why it fixed-steps internally rather than
  // integrating at this variable dt directly). A warning/tilt can surface here even with no
  // nudge this frame — decay alone can carry the bob back below threshold and a LATER nudge's
  // own instant check (see onNudge above) is what actually re-crosses it; this call is what
  // catches a crossing the decay itself causes, which is rare (energy only decreases while
  // decaying) but keeps the edge-detection correct regardless of which call last touched it.
  const tiltResult = tilt.tickTiltBob(tiltBob, dt);
  if (tiltResult === 'warning') {
    callouts.show("TEACHER'S WATCHING");
  } else if (tiltResult === 'tilt') {
    applyDisplayEvents(tiltBall(rulesState, elapsedS));
  }

  const ejectedBalls = game.tickScoop(scoop, elapsedS);
  if (ejectedBalls) {
    // Nudge each ball just clear of the capture radius along the eject direction before
    // releasing it — otherwise, at 240 Hz, a single physics step doesn't carry it outside
    // the zone yet and checkCaptures (physics/world.js) immediately re-captures it.
    const evel = sandbox.eject.vel;
    const evLen = Math.hypot(evel.x, evel.y) || 1;
    const clear = sandbox.captureZone.radius * 1.3;
    // Every ball armScoop captured since the last eject leaves together (game/mechanisms.js's
    // own doc comment on armScoop records why together, not queued) — 2026-09-05, fixed after
    // an outside review found a second ball entering the sandbox during multiball orphaned the
    // first: armScoop used to overwrite a single `scoop.ball` field, and the overwritten ball's
    // `captured` flag was never cleared by anything, ever again.
    for (const ball of ejectedBalls) {
      ball.pos = {
        x: sandbox.captureZone.centre.x + (evel.x / evLen) * clear,
        y: sandbox.captureZone.centre.y + (evel.y / evLen) * clear,
      };
      ball.vel = { x: evel.x, y: evel.y };
      ball.captured = false;
      // Presentation tween, eject: `from` is the capture zone's own real centre (where every
      // captured ball has sat, motionless, for its own hold — the same
      // `sandbox.captureZone.centre` physics/world.js's checkCaptures snapped it to on capture);
      // `to` is `ball.pos` above, the exact point physics just computed for the eject — read
      // back, not recomputed, so this can never drift from what physics used.
      const ejectedEntry = findBallEntry(ball);
      if (ejectedEntry) ejectedEntry.presentationTween = startTween(sandbox.captureZone.centre, ball.pos, elapsedS);
    }
    // Scored once per EJECT EVENT, not once per ball in it — unchanged from before this fix
    // (which only ever had one ball to eject, so the distinction never came up). Scoring
    // multiple balls in one eject differently is a real design question (each entry already
    // scores its own SW_SANDBOX_ENTRY on capture, per-ball) but is not the orphan bug this
    // dispatch fixes; left as-is rather than invented here.
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

  // FIELD DAY's own staggered 3-new-ball release — same 400ms cadence, drained the same way,
  // so a spawn due this frame lands in this same frame's SW_BALL_ADDED batch.
  if (fieldDayReleaseQueue.length > 0) {
    const due = fieldDayReleaseQueue.filter((r) => elapsedS >= r.atS);
    if (due.length > 0) {
      fieldDayReleaseQueue = fieldDayReleaseQueue.filter((r) => elapsedS < r.atS);
      for (const r of due) {
        spawnBall(recess.LAUNCH_POSITION, { x: 0, y: PLUNGER_MAX_SPEED * 0.7 });
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
    game.captureInTrough(troughState, elapsedS); // every ordinary drain physically reaches the trough
    const liveBallsRemaining = balls.filter((b) => !b.phys.captured).length;
    scoreTags.push(drainTagFor({ liveBallsRemaining }));
  }

  if (pendingSoftPlunge) {
    scoreTags.push(SW_SOFT_PLUNGE);
    pendingSoftPlunge = false;
  }

  applyDisplayEvents(processRules(rulesState, scoreTags, elapsedS));

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
  // TILT (design §4.4): "flippers die" — forced inactive every frame while tilted, overriding
  // whatever ui/input.js's own key/touch handlers tried to set on flippers directly (main.js
  // has no other hook into that path — see rules/tilt.js's own doc comment on why this lives
  // here rather than in input.js). Cleared on the next 'ballServed' (applyDisplayEvents above).
  if (flippersDisabled) {
    for (const flipper of Object.values(flippers)) setActive(flipper, false);
  }
  for (const flipper of Object.values(flippers)) updateFlipperMesh(flipper);

  const mgrActive = activePlayer(rulesState).multiball.active;
  mgrGroup.rotation.y += (mgrActive ? MGR_SPIN_MULTIBALL : MGR_SPIN_IDLE) * dt;
  mgrGroup.userData.roofMat.color.set(activePlayer(rulesState).multiball.lockLit ? 0xffee55 : 0x4a7a3a);

  kickbackMesh.material = kickbackState.lit ? kickbackLitMat : kickbackUnlitMat;

  // LIT-WIRE: the states a player must see to make a decision — the renderer already had
  // every primitive this needs (color swaps proven on the MGR roof/fun lamps above, material
  // swaps on kickback just above); this was wiring, not a missing feature (see
  // haiku-fs2's render-state-inventory and player-feedback handoffs). Re-read from live rules
  // state every frame — never toggled once and left stale — so a lamp clears the instant the
  // rules clear it (e.g. jackpotReady resets the moment collectJackpot fires), the same
  // "state surviving a boundary" class of bug LIT-1 found four instances of elsewhere today.
  // Distinct colors per MEANING, not per mesh, so two different reasons a shot is lit never
  // look the same: red = a jackpot is ready to cash in right now (the biggest single-shot
  // payouts on the table); purple = the HOPSCOTCH bank's own jackpot, a different, smaller
  // award that happens to land on the same SLIDE shot — same priority order scoreSwitchTag
  // itself already uses (mbJackpot outranks hopscotch); cyan = "this is KICKBALL's next
  // base," the one currently-running mode with a single well-defined next shot (HIDE_SEEK's
  // hidden shot is deliberately NOT lit — showing it would remove the "seek" from the mode).
  const ap = activePlayer(rulesState);
  const kickballShotTag = ap.modesState.activeMode?.name === 'KICKBALL'
    ? MODE_SHOT_TAGS[ap.modesState.activeMode.base] : null;
  const LIT_JACKPOT = 0xff3300;
  const LIT_HOPSCOTCH = 0x9955ff;
  const LIT_MODE_SHOT = 0x33aaff;
  slideFrameMat.color.set(
    ap.multiball.jackpotReady ? LIT_JACKPOT
      : ap.modesState.hopscotchJackpot.lit ? LIT_HOPSCOTCH
      : kickballShotTag === MODE_SHOT_TAGS[0] ? LIT_MODE_SHOT
      : 0xf0c927);
  wireformMat.color.set(
    ap.multiball.superJackpotLit ? LIT_JACKPOT
      : kickballShotTag === MODE_SHOT_TAGS[1] ? LIT_MODE_SHOT
      : 0xd8d8d8);
  culvertMat.color.set(kickballShotTag === MODE_SHOT_TAGS[2] ? LIT_MODE_SHOT : 0x7d6b58);
  sandboxPitMat.color.set(kickballShotTag === MODE_SHOT_TAGS[3] ? LIT_MODE_SHOT : SANDBOX_UNLIT_COLOR);

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
  get ballEntries() { return balls; }, // phys + mesh, for render-side debugging
  camera, scene,
  rulesState, activePlayer: () => activePlayer(rulesState),
  tiltBob, get flippersDisabled() { return flippersDisabled; },
  hopscotchBankState, sandBankState, funLamps, tetherballSpinner, pinwheelSpinner,
  slide, monkeyBars, tunnel, sandbox, scoop, merryGoRound,
  // Injects a synthetic switch-tag batch through the SAME processRules/applyDisplayEvents path
  // frame() uses — for debug scripts driving a specific rules-layer scenario (e.g. forcing a
  // FIELD DAY start) without waiting on the physical shot that would ordinarily produce the tag.
  injectTags: (tags) => applyDisplayEvents(processRules(rulesState, tags, elapsedS)),
  callouts,
};
