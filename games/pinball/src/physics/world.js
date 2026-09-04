// Multi-ball world: owns the fixed-step accumulator and per-layer primitive lists.
// Headless — no rendering imports, no DOM, no wall-clock reads (callers pass elapsed seconds in).

import { stepBall } from './solver.js';
import { dot, distance } from './vec2.js';
import { STEP_DT, gravityForPitch, tuning as defaultTuning } from './constants.js';
import { updateFlipper, flipperEntry, isFlipperMoving, FLIPPER_SUBSTEPS } from './flipper.js';
import { stepRampBall, entryTangent } from './ramp.js';

export function createWorld({ pitchDeg, tuning } = {}) {
  return {
    balls: [], // { id, pos, vel, radius, layer, active, z?, captured?, s?, sVel? }
    layers: new Map(), // layerId -> primitives[]
    zones: new Map(), // layerId -> Zone/Gate shapes[] (non-blocking; see checkZoneCrossings)
    ramps: new Map(), // rampLayerId -> ramp track (see physics/ramp.js) — a ball whose
                       // layer is a key of this map is stepped by stepRampBall, not stepBall.
    captureZones: new Map(), // layerId -> [{centre, radius, tag}] (e.g. the SANDBOX scoop)
    flippers: [],
    gravity: gravityForPitch(pitchDeg),
    tuning: defaultTuning(tuning),
    accumulator: 0,
    events: [],
  };
}

export function setLayerPrimitives(world, layerId, primitives) {
  world.layers.set(layerId, primitives);
}

export function setLayerZones(world, layerId, zones) {
  world.zones.set(layerId, zones);
}

export function addRamp(world, ramp) {
  world.ramps.set(ramp.id, ramp);
}

export function setCaptureZones(world, layerId, zones) {
  world.captureZones.set(layerId, zones);
}

// Segment-vs-segment intersection test (not swept-circle: zones are trigger lines, not
// collision surfaces, so an exact crossing of the ball's centre path is the right test —
// robust regardless of step size, unlike a point-in-region check against a thin zone).
function segmentsCross(p1, p2, a, b) {
  const d1 = { x: p2.x - p1.x, y: p2.y - p1.y };
  const d2 = { x: b.x - a.x, y: b.y - a.y };
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-12) return false;
  const t = ((a.x - p1.x) * d2.y - (a.y - p1.y) * d2.x) / denom;
  const u = ((a.x - p1.x) * d1.y - (a.y - p1.y) * d1.x) / denom;
  return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9;
}

function checkZoneCrossings(world, ball, prevPos) {
  const zones = world.zones.get(ball.layer);
  if (!zones || zones.length === 0) return [];
  const events = [];
  for (const zone of zones) {
    if (zone.active === false) continue;
    if (segmentsCross(prevPos, ball.pos, zone.a, zone.b)) {
      events.push({ zone, tag: zone.tag, ball });
    }
  }
  return events;
}

// A Gate (see physics/shapes.js) is a Zone that also carries `.gate = {toLayer, allowDir,
// minSpeed}`. Crossing it only switches the ball's layer if its velocity is actually
// headed into the ramp — a ball drifting through backwards, or barely grazing it, stays on
// 'playfield'. Onto the ramp, the ball's arclength position/velocity are seeded from its
// real incoming speed projected onto the track's own starting direction, so a fast shot
// carries more momentum up the ramp than a slow one.
function tryEnterGate(world, zoneEvent) {
  const { zone, ball } = zoneEvent;
  if (!zone.gate) return null;
  const ramp = world.ramps.get(zone.gate.toLayer);
  if (!ramp) return null;
  const speedAlong = dot(ball.vel, zone.gate.allowDir);
  if (speedAlong < zone.gate.minSpeed) return null;

  ball.layer = zone.gate.toLayer;
  ball.s = 0;
  ball.sVel = Math.max(speedAlong, ramp.entryBackSpeedFloor);
  const start = ramp.points[0];
  ball.pos = { x: start.x, y: start.y };
  ball.z = start.z ?? 0;
  return { tag: zone.tag, gateEntered: true, ball };
}

/** Runs a ramp/orbit ball to its own 1D physics; returns the exit event, or null if it's
 * still mid-track. On exit, hands the ball back to 'playfield' at the ramp's authored exit
 * (made the shot) or back near the entry, rolling backward (didn't make it) — see
 * physics/ramp.js's doc comment for why the return trip itself isn't simulated. */
function stepRampLayerBall(world, ball) {
  const ramp = world.ramps.get(ball.layer);
  const exited = stepRampBall(ball, ramp, STEP_DT);
  if (!exited) return null;

  if (exited === 'top') {
    ball.layer = 'playfield';
    ball.pos = { x: ramp.exit.pos.x, y: ramp.exit.pos.y };
    ball.vel = { x: ramp.exit.dir.x * ramp.exit.speed, y: ramp.exit.dir.y * ramp.exit.speed };
    ball.z = 0;
    return { tag: `${ramp.id}_exit`, rampExit: 'top', ball };
  }

  // Didn't make it: roll back out of the gate's mouth, moving backward along the track's
  // own entry direction, nudged clear of the gate line so it can't immediately re-trigger it.
  const back = entryTangent(ramp);
  const speed = Math.max(ramp.entryBackSpeedFloor, Math.abs(ball.sVel));
  const start = ramp.points[0];
  ball.layer = 'playfield';
  ball.pos = { x: start.x - back.x * 0.012, y: start.y - back.y * 0.012 };
  ball.vel = { x: -back.x * speed, y: -back.y * speed };
  ball.z = 0;
  return { tag: `${ramp.id}_rollback`, rampExit: 'bottom', ball };
}

function checkCaptures(world, ball) {
  if (ball.captured) return [];
  const zones = world.captureZones.get(ball.layer);
  if (!zones || zones.length === 0) return [];
  for (const zone of zones) {
    if (distance(ball.pos, zone.centre) <= zone.radius) {
      ball.captured = true;
      ball.pos = { x: zone.centre.x, y: zone.centre.y };
      ball.vel = { x: 0, y: 0 };
      return [{ tag: zone.tag, captured: true, ball }];
    }
  }
  return [];
}

export function addBall(world, ball) {
  const b = { layer: 'playfield', active: true, ...ball };
  world.balls.push(b);
  return b;
}

export function removeBall(world, id) {
  world.balls = world.balls.filter((b) => b.id !== id);
}

export function addFlipper(world, flipper) {
  world.flippers.push(flipper);
  return flipper;
}

function isAnyFlipperMoving(world) {
  return world.flippers.some(isFlipperMoving);
}

/** Advance the world by `dtSeconds` of wall-clock time, at a fixed STEP_DT internally. */
export function advance(world, dtSeconds) {
  world.accumulator += dtSeconds;
  const events = [];

  while (world.accumulator >= STEP_DT) {
    // Checked once per STEP_DT, not per substep: if a stroke completes partway through this
    // span, the remaining substeps just resolve a stationary flipper at finer resolution than
    // strictly needed — harmless, and simpler than re-deciding the substep count mid-span.
    const substeps = isAnyFlipperMoving(world) ? FLIPPER_SUBSTEPS : 1;
    const subDt = STEP_DT / substeps;

    for (let s = 0; s < substeps; s++) {
      for (const flipper of world.flippers) updateFlipper(flipper, subDt);
      const flipperEntriesByLayer = new Map();
      for (const flipper of world.flippers) {
        const list = flipperEntriesByLayer.get(flipper.layer) ?? [];
        list.push(flipperEntry(flipper));
        flipperEntriesByLayer.set(flipper.layer, list);
      }

      for (const ball of world.balls) {
        if (!ball.active) continue;
        if (ball.captured) continue; // pinned in a scoop/lock until the game layer ejects it
        if (world.ramps.has(ball.layer)) continue; // ramp balls: stepped once below, unaffected
        // by flipper sub-stepping — stepRampLayerBall integrates on its own 1D track, not
        // against flipper capsules, so it has nothing to gain from a finer dt here and
        // stepRampBall's own internal STEP_DT use would double-count time if called per substep.

        const prevPos = { x: ball.pos.x, y: ball.pos.y };
        const primitives = (world.layers.get(ball.layer) ?? []).concat(flipperEntriesByLayer.get(ball.layer) ?? []);
        const evs = stepBall(ball, world.gravity, primitives, subDt, world.tuning);
        for (const e of evs) events.push({ ...e, ball });

        for (const e of checkZoneCrossings(world, ball, prevPos)) {
          const gateEvent = tryEnterGate(world, e);
          events.push(gateEvent ?? e);
        }

        for (const e of checkCaptures(world, ball)) events.push(e);
      }
    }

    // Ramp balls: exactly one step of the full STEP_DT, same as before sub-stepping existed.
    for (const ball of world.balls) {
      if (!ball.active || ball.captured) continue;
      if (!world.ramps.has(ball.layer)) continue;
      const exitEvent = stepRampLayerBall(world, ball);
      if (exitEvent) events.push(exitEvent);
    }

    world.accumulator -= STEP_DT;
  }

  world.events = events;
  return events;
}
