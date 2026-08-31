// Multi-ball world: owns the fixed-step accumulator and per-layer primitive lists.
// Headless — no rendering imports, no DOM, no wall-clock reads (callers pass elapsed seconds in).

import { stepBall } from './solver.js';
import { STEP_DT, gravityForPitch, tuning as defaultTuning } from './constants.js';
import { updateFlipper, flipperEntry } from './flipper.js';

export function createWorld({ pitchDeg, tuning } = {}) {
  return {
    balls: [], // { id, pos, vel, radius, layer, active }
    layers: new Map(), // layerId -> primitives[]
    zones: new Map(), // layerId -> Zone shapes[] (non-blocking; see checkZoneCrossings)
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

/** Advance the world by `dtSeconds` of wall-clock time, at a fixed STEP_DT internally. */
export function advance(world, dtSeconds) {
  world.accumulator += dtSeconds;
  const events = [];

  while (world.accumulator >= STEP_DT) {
    for (const flipper of world.flippers) updateFlipper(flipper, STEP_DT);
    const flipperEntriesByLayer = new Map();
    for (const flipper of world.flippers) {
      const list = flipperEntriesByLayer.get(flipper.layer) ?? [];
      list.push(flipperEntry(flipper));
      flipperEntriesByLayer.set(flipper.layer, list);
    }

    for (const ball of world.balls) {
      if (!ball.active) continue;
      const prevPos = { x: ball.pos.x, y: ball.pos.y };
      const primitives = (world.layers.get(ball.layer) ?? []).concat(flipperEntriesByLayer.get(ball.layer) ?? []);
      const evs = stepBall(ball, world.gravity, primitives, STEP_DT, world.tuning);
      for (const e of evs) events.push({ ...e, ball });
      for (const e of checkZoneCrossings(world, ball, prevPos)) events.push(e);
    }
    world.accumulator -= STEP_DT;
  }

  world.events = events;
  return events;
}
