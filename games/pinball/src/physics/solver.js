// Swept 2.5D collision solver. See design doc §2.3-2.4. Headless — no rendering imports,
// no DOM, no wall-clock time reads. Kickout scatter uses the seeded rng passed in by callers.

import { sub, dot, length, normalize } from './vec2.js';

const EPS = 1e-9;
const PUSHOUT_EPS = 1e-6;

// Smallest root of a*t^2 + b*t + c = 0 within [0, tmax], or null.
function smallestRoot(a, b, c, tmax) {
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return null;
    const t = -c / b;
    return t >= -EPS && t <= tmax + EPS ? Math.max(t, 0) : null;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  const t1 = (-b + sq) / (2 * a);
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  if (lo >= -EPS && lo <= tmax + EPS) return Math.max(lo, 0);
  if (hi >= -EPS && hi <= tmax + EPS) return Math.max(hi, 0);
  return null;
}

/**
 * Swept circle (centre p0, radius r, moving at v) vs a static Segment, within [0, tmax].
 * Returns { t, point, normal } for the earliest contact, or null.
 */
export function sweepCircleSegment(p0, v, r, seg, tmax) {
  const a = seg.a;
  const b = seg.b;
  const d = sub(b, a);
  const dd = dot(d, d);
  if (dd < 1e-12) return sweepCircleCircle(p0, v, r, { centre: a, radius: 0 }, tmax);

  const m0 = sub(p0, a);
  const A = dot(v, v);
  const B = dot(m0, v);
  const C = dot(m0, m0);
  const Dd = dot(v, d);
  const E = dot(m0, d);

  const candidates = [];

  // Immediate-overlap guard: already penetrating at t=0.
  const s0 = clamp01(E / dd);
  const closest0 = { x: a.x + d.x * s0, y: a.y + d.y * s0 };
  const dist0 = length(sub(p0, closest0));
  if (dist0 <= r + PUSHOUT_EPS) {
    const n = dist0 > 1e-9 ? normalize(sub(p0, closest0)) : normalize({ x: -d.y, y: d.x });
    return { t: 0, point: closest0, normal: n };
  }

  // Flat-face (line) collision, valid where s(t) in [0,1].
  {
    const a2 = A - (Dd * Dd) / dd;
    const b2 = 2 * (B - (E * Dd) / dd);
    const c2 = C - (E * E) / dd - r * r;
    const t = smallestRoot(a2, b2, c2, tmax);
    if (t !== null) {
      const s = (E + Dd * t) / dd;
      if (s >= -1e-6 && s <= 1 + 1e-6) {
        const point = { x: a.x + d.x * clamp01(s), y: a.y + d.y * clamp01(s) };
        const pAtT = { x: p0.x + v.x * t, y: p0.y + v.y * t };
        candidates.push({ t, point, normal: normalize(sub(pAtT, point)) });
      }
    }
  }

  // Endpoint a collision, valid where s(t) <= 0.
  {
    const t = smallestRoot(A, 2 * B, C - r * r, tmax);
    if (t !== null) {
      const s = (E + Dd * t) / dd;
      if (s <= 1e-6) {
        const pAtT = { x: p0.x + v.x * t, y: p0.y + v.y * t };
        candidates.push({ t, point: a, normal: normalize(sub(pAtT, a)) });
      }
    }
  }

  // Endpoint b collision, valid where s(t) >= 1.
  {
    const m1 = sub(p0, b);
    const B1 = dot(m1, v);
    const C1 = dot(m1, m1);
    const t = smallestRoot(A, 2 * B1, C1 - r * r, tmax);
    if (t !== null) {
      const s = (E + Dd * t) / dd;
      if (s >= 1 - 1e-6) {
        const pAtT = { x: p0.x + v.x * t, y: p0.y + v.y * t };
        candidates.push({ t, point: b, normal: normalize(sub(pAtT, b)) });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((x, y) => x.t - y.t);
  return candidates[0];
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Swept circle vs a static Circle (post). Collides at distance r + circle.radius.
 */
export function sweepCircleCircle(p0, v, r, circle, tmax) {
  const m = sub(p0, circle.centre);
  const R = r + circle.radius;
  const A = dot(v, v);
  const B = dot(m, v);
  const C = dot(m, m) - R * R;

  if (C <= PUSHOUT_EPS) {
    // Already overlapping.
    const n = length(m) > 1e-9 ? normalize(m) : { x: 0, y: 1 };
    return { t: 0, point: { x: circle.centre.x + n.x * circle.radius, y: circle.centre.y + n.y * circle.radius }, normal: n };
  }

  const t = smallestRoot(A, 2 * B, C, tmax);
  if (t === null) return null;
  const pAtT = { x: p0.x + v.x * t, y: p0.y + v.y * t };
  const normal = normalize(sub(pAtT, circle.centre));
  const point = { x: circle.centre.x + normal.x * circle.radius, y: circle.centre.y + normal.y * circle.radius };
  return { t, point, normal };
}

function normalizeAngle(a) {
  let x = a % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x;
}

function angleInRange(angle, a0, a1) {
  const a = normalizeAngle(angle);
  let lo = normalizeAngle(a0);
  let hi = normalizeAngle(a1);
  if (lo <= hi) return a >= lo - 1e-6 && a <= hi + 1e-6;
  // Wraps through 0.
  return a >= lo - 1e-6 || a <= hi + 1e-6;
}

/**
 * Swept circle vs a static Arc. The arc is a zero-thickness wall of radius `radius`;
 * the ball collides on whichever side it starts on (outside -> R+r, inside -> R-r),
 * then the contact point's angle is checked against [a0, a1].
 */
export function sweepCircleArc(p0, v, r, arc, tmax) {
  const distFromCentre = length(sub(p0, arc.centre));
  const outside = distFromCentre >= arc.radius;
  const R = outside ? arc.radius + r : Math.max(arc.radius - r, 0);

  const m = sub(p0, arc.centre);
  const A = dot(v, v);
  const B = dot(m, v);
  const C = dot(m, m) - R * R;

  const check = (t) => {
    if (t === null) return null;
    const pAtT = { x: p0.x + v.x * t, y: p0.y + v.y * t };
    const rel = sub(pAtT, arc.centre);
    const angle = Math.atan2(rel.y, rel.x);
    if (!angleInRange(angle, arc.a0, arc.a1)) return null;
    const dirOut = normalize(rel);
    const normal = outside ? dirOut : { x: -dirOut.x, y: -dirOut.y };
    const point = { x: arc.centre.x + dirOut.x * arc.radius, y: arc.centre.y + dirOut.y * arc.radius };
    return { t, point, normal };
  };

  if (C <= PUSHOUT_EPS && C > -Infinity) {
    const already = check(0);
    if (already) return already;
  }

  const t = smallestRoot(A, 2 * B, C, tmax);
  return check(t);
}

/**
 * Earliest impact of a moving ball against a list of static/kinematic primitives.
 * `primitives` entries: { shape, surfaceVelocityAt?(point) } — surfaceVelocityAt is used
 * by kinematic primitives (flippers) added in a later task; static shapes omit it.
 * Returns { t, primitive, normal, point } or null.
 */
export function earliestImpact(p0, v, r, primitives, tmax) {
  let best = null;
  for (const entry of primitives) {
    const shape = entry.shape ?? entry;
    if (shape.active === false) continue;
    if (shape.oneWay && dot(v, shape.oneWay.allow) > shape.oneWay.threshold) continue;
    const rEff = r + (shape.padding || 0);
    let hit = null;
    if (shape.kind === 'segment') hit = sweepCircleSegment(p0, v, rEff, shape, tmax);
    else if (shape.kind === 'circle') hit = sweepCircleCircle(p0, v, rEff, shape, tmax);
    else if (shape.kind === 'arc') hit = sweepCircleArc(p0, v, rEff, shape, tmax);
    if (hit && (best === null || hit.t < best.t)) {
      best = { ...hit, primitive: entry };
    }
  }
  return best;
}

/**
 * Resolve a bounce against a (possibly moving) surface. surfaceVel defaults to {0,0}.
 */
export function resolve(v, normal, restitution, mu, surfaceVel = { x: 0, y: 0 }) {
  const rel = sub(v, surfaceVel);
  const vn = dot(rel, normal);
  const vt = { x: rel.x - vn * normal.x, y: rel.y - vn * normal.y };
  const outRel = {
    x: vt.x * (1 - mu) - vn * restitution * normal.x,
    y: vt.y * (1 - mu) - vn * restitution * normal.y,
  };
  return { x: outRel.x + surfaceVel.x, y: outRel.y + surfaceVel.y };
}

/**
 * Advance one ball { pos:{x,y}, vel:{x,y} } by dt seconds against `primitives`, using the
 * swept substep loop from §2.4. `gravity` is {x,y}. `tuning` = { mu, kDrag, maxImpacts }.
 * Returns an array of contact events: { primitive, normal, point }.
 */
export function stepBall(ball, gravity, primitives, dt, tuning) {
  const { mu, kDrag, maxImpacts = 8 } = tuning;
  let remaining = dt;
  const events = [];

  for (let i = 0; i < maxImpacts; i++) {
    ball.vel = { x: ball.vel.x + gravity.x * remaining, y: ball.vel.y + gravity.y * remaining };

    const hit = earliestImpact(ball.pos, ball.vel, ball.radius, primitives, remaining);
    if (!hit) {
      ball.pos = { x: ball.pos.x + ball.vel.x * remaining, y: ball.pos.y + ball.vel.y * remaining };
      remaining = 0;
      break;
    }

    ball.pos = { x: ball.pos.x + ball.vel.x * hit.t, y: ball.pos.y + ball.vel.y * hit.t };
    remaining -= hit.t;

    const shape = hit.primitive.shape ?? hit.primitive;
    const restitution = shape.restitution ?? 0.45;
    const surfaceVel = hit.primitive.surfaceVelocityAt ? hit.primitive.surfaceVelocityAt(hit.point) : { x: 0, y: 0 };
    ball.vel = resolve(ball.vel, hit.normal, restitution, mu, surfaceVel);

    // Active kicker (pop bumper / slingshot): if the elastic bounce alone didn't reach the
    // kicker's target speed, boost along the outgoing direction — models the solenoid kick
    // on top of the passive rubber bounce, without a special-cased second collision pass.
    if (shape.kick) {
      const speed = length(ball.vel);
      if (speed < shape.kick) {
        const dir = speed > 1e-6 ? { x: ball.vel.x / speed, y: ball.vel.y / speed } : hit.normal;
        ball.vel = { x: dir.x * shape.kick, y: dir.y * shape.kick };
      }
    }

    // Kill residual penetration.
    ball.pos = { x: ball.pos.x + hit.normal.x * PUSHOUT_EPS * 1000, y: ball.pos.y + hit.normal.y * PUSHOUT_EPS * 1000 };

    events.push({ primitive: hit.primitive, normal: hit.normal, point: hit.point });

    if (remaining <= 0) break;
  }

  const drag = Math.max(0, 1 - kDrag * dt);
  ball.vel = { x: ball.vel.x * drag, y: ball.vel.y * drag };

  return events;
}
