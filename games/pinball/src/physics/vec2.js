// Plain-object 2D vector helpers. Pure functions only — no classes, no mutation of inputs
// unless the function name says otherwise (`addInPlace` etc.).

export function v2(x = 0, y = 0) {
  return { x, y };
}

export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a, s) {
  return { x: a.x * s, y: a.y * s };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

export function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

export function lengthSq(a) {
  return a.x * a.x + a.y * a.y;
}

export function length(a) {
  return Math.sqrt(lengthSq(a));
}

export function normalize(a) {
  const len = length(a);
  if (len < 1e-12) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}

export function perp(a) {
  // rotate +90deg
  return { x: -a.y, y: a.x };
}

export function rotate(a, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function distanceSq(a, b) {
  return lengthSq(sub(a, b));
}

export function distance(a, b) {
  return Math.sqrt(distanceSq(a, b));
}
