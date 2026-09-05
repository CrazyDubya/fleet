// Guard for a defect found by an outside review (2026-09-05, opencode relay), reproduced here:
// lineIntersect divided by `denom = d1x*d2y - d1y*d2x` with no guard. Collinear input drove
// denom to 0, t to NaN, and the resulting joint to {x: NaN, y: NaN} — with nothing thrown and
// nothing logged, silently putting NaN wall coordinates into the physics system. This is the
// defect class the whole outlane/inlane dispatch was about: bad state entering silently
// because the declared success path never checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineIntersect, offsetPolylineMitered } from '../src/table/recess.js';

test('lineIntersect returns null on collinear input instead of NaN', () => {
  // Two collinear segments on the same line y=0 — denom is exactly 0.
  const result = lineIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 });
  assert.equal(result, null, 'collinear lines have no unique intersection — must return null, not {x: NaN, y: NaN}');
});

test('lineIntersect returns null on parallel (non-collinear) input instead of NaN', () => {
  const result = lineIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 });
  assert.equal(result, null, 'parallel, non-intersecting lines must return null, not NaN');
});

test('lineIntersect still finds the real intersection for ordinary, non-degenerate input', () => {
  // Two lines crossing at (1,1): y=x and y=2-x.
  const result = lineIntersect({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 });
  assert.ok(result, 'expected a real intersection point, not null');
  assert.ok(Math.abs(result.x - 1) < 1e-9 && Math.abs(result.y - 1) < 1e-9, `expected (1,1), got (${result.x}, ${result.y})`);
});

test('offsetPolylineMitered falls back to a finite midpoint on a degenerate (straight-run) joint, and warns loudly', () => {
  // a->mid->b all collinear on y=0 — exactly the "apron authored with two straight runs"
  // scenario the operator named: offsetting each segment by the same perpendicular distance
  // produces two PARALLEL offset lines (never intersecting), the degenerate case for real.
  const a = { x: 0, y: 0 };
  const mid = { x: 1, y: 0 };
  const b = { x: 2, y: 0 };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let result;
  try {
    result = offsetPolylineMitered(a, mid, b, 0.05);
  } finally {
    console.warn = originalWarn;
  }

  const [t1a, joint, t2b] = result;
  assert.ok(Number.isFinite(joint.x) && Number.isFinite(joint.y), `joint must be finite, got (${joint.x}, ${joint.y})`);
  // Both offset segments run parallel to y=0 at y=+0.05 (offsetSegment's sign convention: for
  // a rightward a->b, +dist offsets toward +y), so their nearest endpoints (t1b, t2a) coincide
  // exactly — the fallback midpoint of two identical points is just that point, keeping the
  // straight run straight.
  assert.ok(Math.abs(joint.y - 0.05) < 1e-9, `expected the fallback joint to stay on the offset line y=0.05, got y=${joint.y}`);
  assert.equal(warnings.length, 1, 'expected exactly one console.warn call announcing the degenerate joint');
  assert.match(warnings[0], /degenerate joint/i, 'the warning should say plainly what happened, not just fail silently');

  // Sanity: the endpoints on either side of the joint are untouched by the fallback.
  assert.ok(Number.isFinite(t1a.x) && Number.isFinite(t2b.x));
});

test('offsetPolylineMitered still mitres normally (no warning) for an ordinary angled joint', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let result;
  try {
    // Real apron shape: two angled runs, per recess.js's own APRON_TOP/APRON_MID/APRON_NECK.
    result = offsetPolylineMitered({ x: -0.257, y: 0.3 }, { x: -0.205, y: 0.12 }, { x: -0.15, y: 0.02 }, 0.0405);
  } finally {
    console.warn = originalWarn;
  }
  const [, joint] = result;
  assert.ok(Number.isFinite(joint.x) && Number.isFinite(joint.y));
  assert.equal(warnings.length, 0, 'an ordinary angled joint must not trigger the degenerate-joint warning');
});
