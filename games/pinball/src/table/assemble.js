// The playfield physics assembly — pure data, no THREE, no DOM, importable under
// `node --test`. This is the ONE place that lists every table builder (recess/mechanisms/
// ramps) that contributes to the playfield layer's primitives, zones, capture zones and
// ramps. Extracted 2026-09-04 from what was inline in src/main.js, byte-identical: every
// value this returns is exactly what main.js built inline before this file existed (verified
// by test/assemble.test.mjs and by re-running opus2's mesh-vs-physics method against the
// same segment/circle before and after).
//
// Why this exists: before this file, the sandbox project's src/main.js had to re-list these
// same builder calls by hand to build its own copy of the table — and it fell behind (missed
// buildSwingSetPosts and buildSpinners entirely; found by grep, not by its own parity test,
// which only checked capture zones and gates). One source of truth: both main.js files call
// buildTable()/wireTable() from here, so a builder added to the game's assembly is on the
// sandbox's table on the next load, with nothing to re-list and nothing to fall behind.
import { setLayerPrimitives, setLayerZones, addRamp, setCaptureZones } from '../physics/world.js';
import * as recess from './recess.js';
import * as mech from './mechanisms.js';
import * as ramps from './ramps.js';

/**
 * Builds every table entity the playfield layer needs, plus the flattened primitive/zone/
 * capture-zone/ramp lists ready for wireTable(). Returns the individual built objects too
 * (hopscotch, slingshots, sandbox, etc.) — main.js's rendering and game-state code needs
 * those directly (e.g. hopscotch.targets for the drop-bank runtime state, sandbox.eject for
 * the scoop's eject vector), not just the flattened arrays.
 */
export function buildTable() {
  const wallSegments = recess.buildWalls();
  const popBumpers = mech.buildPopBumpers();
  const slingshots = mech.buildSlingshots();
  const hopscotch = mech.buildHopscotchBank();
  const sandBank = mech.buildSandBank();
  const treehouse = mech.buildTreehouseStandup();
  const funLaneDefs = mech.buildFunLanes();
  const spinnerDefs = mech.buildSpinners();
  const swingSetPosts = mech.buildSwingSetPosts();

  const slide = ramps.buildSlideRamp();
  const monkeyBars = ramps.buildMonkeyBarsRamp();
  const tunnel = ramps.buildTunnelRamp();
  const sandbox = ramps.buildSandbox();
  const merryGoRound = mech.buildMerryGoRound();

  // Every mechanism-leaving landing point (merry-go-round release/eject, SANDBOX add-a-ball)
  // computed against the real table layout up front — see computeEjectPlacement's doc comment
  // in table/mechanisms.js for why this exists (the P0 jackpot-runaway bug, and the SANDBOX
  // add-a-ball's own instance of the same class of bug).
  const ejectionSites = new Map(mech.buildEjectionSites(sandbox).map((s) => [s.name, s]));
  const mgrRelease = ejectionSites.get('merry_go_round_release').placement;
  const sandboxAddABallPlacement = ejectionSites.get('sandbox_add_a_ball').placement;

  const primitives = [
    ...wallSegments.map((shape) => ({ shape })),
    ...popBumpers.map((p) => ({ shape: p.shape })),
    ...slingshots.left.map((shape) => ({ shape })),
    ...slingshots.right.map((shape) => ({ shape })),
    ...hopscotch.targets.map((t) => ({ shape: t.shape })),
    ...sandBank.targets.map((t) => ({ shape: t.shape })),
    { shape: treehouse.shape },
    ...swingSetPosts.map((p) => ({ shape: p.shape })),
  ];

  const zones = [
    ...funLaneDefs.map((f) => f.zone),
    spinnerDefs.tetherball,
    spinnerDefs.pinwheel,
    slide.gate,
    monkeyBars.gate,
    tunnel.gate,
  ];

  const captureZones = [sandbox.captureZone, merryGoRound.captureZone];
  const rampTracks = [slide.ramp, monkeyBars.ramp, tunnel.ramp];

  return {
    wallSegments, popBumpers, slingshots, hopscotch, sandBank, treehouse, funLaneDefs,
    spinnerDefs, swingSetPosts, slide, monkeyBars, tunnel, sandbox, merryGoRound,
    ejectionSites, mgrRelease, sandboxAddABallPlacement,
    primitives, zones, captureZones, rampTracks,
  };
}

/** Wires a built table (from buildTable()) onto a physics world's 'playfield' layer —
 * setLayerPrimitives, addRamp per ramp, setLayerZones, setCaptureZones — exactly the four
 * calls main.js made inline before this file existed. */
export function wireTable(world, table) {
  setLayerPrimitives(world, 'playfield', table.primitives);
  for (const ramp of table.rampTracks) addRamp(world, ramp);
  setLayerZones(world, 'playfield', table.zones);
  setCaptureZones(world, 'playfield', table.captureZones);
}
