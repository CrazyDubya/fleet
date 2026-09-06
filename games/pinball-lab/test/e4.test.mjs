import test from 'node:test';
import assert from 'node:assert/strict';
import { buildE4World, pocketSolve, guideEndpoints, classifySettle } from '../src/arenas/e4_pocket.js';
import { runTrial, runTrialWithMeta } from '../src/instrument.js';
import { buildE4SliceCfgs, buildE4Controls, buildE4StageA1Cfgs, E4_LAB2_WINNER } from '../src/sweep.js';
import { guardStatusLines } from '../src/e4Report.js';

const BASE = {
  exp: 'e4', ...E4_LAB2_WINNER, pol: 'heldActive', inj: 'drop',
  guide: null, feed: null, post: null, outlaneW: null, shelf: false, release: false,
};

// --- §2.5 assertion 1: a shape fouling the flipper's swept capsule must throw at build time. ---

test('§2.5 assertion 1: a guide placed ON the flipper pivot fouls the sweep and throws', () => {
  assert.throws(() => {
    buildE4World({ ...BASE, guide: { gapX: 0, tiltDeg: 0, endDy: 0, guideE: 0.45 } });
  }, /fouls the flipper sweep/);
});

test('§2.5 assertion 1: a tip post placed directly on the flipper tip fouls the sweep and throws', () => {
  assert.throws(() => {
    buildE4World({ ...BASE, post: { dx: 0, dy: 0, postR: 0.02, postE: 0.45 } });
  }, /fouls the flipper sweep/);
});

test('§2.5 assertion 1: a reasonable W1 guide (design doc §1.1 band) does NOT foul the sweep', () => {
  assert.doesNotThrow(() => {
    buildE4World({ ...BASE, guide: { gapX: 0.026, tiltDeg: 0, endDy: 0, guideE: 0.45 } });
  });
});

test('§2.5 assertion 1: every buildable Stage A1 cfg genuinely clears the sweep (spot check a sample)', () => {
  const { cfgs, excluded, total } = buildE4StageA1Cfgs();
  // Pinned to the actual measured grid (2026-09-05, a file-thread sweep: `> 0`/`> 0` here would
  // pass identically whether 350 of 360 survived or just 1 of 360 — a regression that fouled
  // 99% of the grid would still satisfy both thresholds). 350/10 is the real, current split;
  // this only re-checks the ratio stays this shape, not an exact count that would need updating
  // on every deliberate grid change — a >= 300 survivor floor and a <= 30 foul ceiling both fail
  // loudly on a widespread regression in either direction, without demanding an exact number
  // that legitimate grid edits would otherwise have to keep re-typing.
  assert.ok(cfgs.length >= 300, `expected most of the 360-cfg grid to survive the foul check, got only ${cfgs.length}`);
  assert.ok(excluded >= 1 && excluded <= 30, `expected a small minority fouled (design doc §2.1: "one too tight"), got ${excluded}/360`);
  assert.equal(cfgs.length + excluded, total);
  for (const cfg of cfgs.slice(0, 25)) assert.doesNotThrow(() => buildE4World(cfg));
});

// --- §2.5 assertion 2: an injection point overlapping a primitive must throw. ---

test('§2.5 assertion 2: an inlane rail routed straight through a tight guide throws on injection overlap', () => {
  assert.throws(() => {
    buildE4World({
      ...BASE, inj: 'inlane',
      guide: { gapX: 0.026, tiltDeg: 16, endDy: 0, guideE: 0.45 },
      feed: { feedAngleDeg: 24, feedHs: 0.65 },
    });
  }, /overlaps shape/);
});

test('§2.5 assertion 2: a well-clear inlane rail does not throw, and its own segment is excluded from its own spawn-point check', () => {
  assert.doesNotThrow(() => {
    buildE4World({
      ...BASE, inj: 'inlane',
      guide: { gapX: 0.026, tiltDeg: 16, endDy: 0, guideE: 0.45 },
      feed: { feedAngleDeg: 24, feedHs: 0.35 },
    });
  });
});

// --- §1.1 pocketSolve: verified against the design doc's own hand-derived table (§1.1). ---

test('pocketSolve reproduces the design doc §1.1 table (rest position, both directions match)', () => {
  const cases = [
    { activeAngleDeg: 26, flipperRadius: 0.009, gapX: 0.0234, x: -0.0879, y: 0.1252 },
    { activeAngleDeg: 26, flipperRadius: 0.012, gapX: 0.0247, x: -0.0892, y: 0.1279 },
    { activeAngleDeg: 32, flipperRadius: 0.012, gapX: 0.0270, x: -0.0915, y: 0.1266 },
    { activeAngleDeg: 38, flipperRadius: 0.015, gapX: 0.0310, x: -0.0955, y: 0.1275 },
  ];
  for (const c of cases) {
    const r = pocketSolve({ gapX: c.gapX, tiltDeg: 0, endDy: 0, activeAngleDeg: c.activeAngleDeg, flipperRadius: c.flipperRadius, side: 1 });
    assert.ok(r.feasible, `expected feasible at ${JSON.stringify(c)}`);
    assert.ok(Math.abs(r.point.x - c.x) < 1e-4, `x mismatch: got ${r.point.x}, want ${c.x}`);
    assert.ok(Math.abs(r.point.y - c.y) < 1e-4, `y mismatch: got ${r.point.y}, want ${c.y}`);
    // Mirror check: the right-side solve should be the exact x-mirror of the left.
    const mirrored = pocketSolve({ gapX: c.gapX, tiltDeg: 0, endDy: 0, activeAngleDeg: c.activeAngleDeg, flipperRadius: c.flipperRadius, side: -1 });
    assert.ok(Math.abs(mirrored.point.x + r.point.x) < 1e-9);
    assert.ok(Math.abs(mirrored.point.y - r.point.y) < 1e-9);
  }
});

// Note: pocketSolve's force-balance sign check depends only on the guide/flipper ANGLES (an
// infinite-line intersection), not on gapX magnitude — so it cannot by itself detect design
// doc §10 H6's "above ~0.035 the ball falls past the pivot cap" failure mode, which is a
// capsule-END-truncation effect the two-line model doesn't represent. That's why §5.3's `pk`
// (theory vs measurement) is its own reported column rather than assumed to be ~0 everywhere.

test('guideEndpoints mirrors correctly: right-side T/U are the exact x-mirror of left', () => {
  const l = guideEndpoints({ gapX: 0.026, tiltDeg: 16, endDy: 0.01, side: 1 });
  const r = guideEndpoints({ gapX: 0.026, tiltDeg: 16, endDy: 0.01, side: -1 });
  assert.ok(Math.abs(l.T.x + r.T.x) < 1e-9);
  assert.ok(Math.abs(l.T.y - r.T.y) < 1e-9);
  assert.ok(Math.abs(l.U.x + r.U.x) < 1e-9);
  assert.ok(Math.abs(l.U.y - r.U.y) < 1e-9);
});

// --- classifySettle: the §5.1 geometric predicates in isolation, no physics involved. ---

// CONST-IMPORT, checked: pivot/length/radius/angle/ballRadius below happen to resemble the real
// lower flipper and ball, but this is classifySettle's own geometric predicate math in
// isolation ("no physics involved", per this section's own comment) — not a claim about the
// real game's current flipper. The sibling test right below this one proves the point by using
// a totally different, explicitly "contrived" pivot/length pair and the SAME ballRadius, and
// still exercises the same predicate correctly — so none of these numbers are standing in for
// a specific real constant, and classifySettle's own correctness here doesn't depend on
// matching whatever FLIPPER.lower/BALL_RADIUS currently are. Kept as literals on purpose — a
// real geometry change would not, and should not, need this test to move.
test('classifySettle: a ball at the flipper capsule surface (not near any guide) is cr but not cp', () => {
  const flippers = {
    left: { pivot: { x: -0.078, y: 0.105 }, angle: (26 * Math.PI) / 180, length: 0.075, radius: 0.012 },
    right: { pivot: { x: 0.078, y: 0.105 }, angle: ((180 - 26) * Math.PI) / 180, length: 0.075, radius: 0.012 },
  };
  const midFace = { x: -0.078 + Math.cos((26 * Math.PI) / 180) * 0.075 * 0.5, y: 0.105 + Math.sin((26 * Math.PI) / 180) * 0.075 * 0.5 };
  const normal = { x: -Math.sin((26 * Math.PI) / 180), y: Math.cos((26 * Math.PI) / 180) };
  const ballRadius = 0.0135;
  const touchDist = 0.012 + ballRadius; // exactly at contact
  const ballPos = { x: midFace.x + normal.x * touchDist, y: midFace.y + normal.y * touchDist };
  const cls = classifySettle({ ballPos, ballRadius, flippers, guideShapes: [] });
  assert.equal(cls.cr, 1);
  assert.equal(cls.cp, 0);
  assert.equal(cls.cv, 0);
  assert.ok(cls.hsS > 0.4 && cls.hsS < 0.6);
});

test('classifySettle: cv fires only when both flippers are simultaneously in contact', () => {
  const flippers = {
    left: { pivot: { x: -0.02, y: 0.1 }, angle: 0, length: 0.05, radius: 0.012 },
    right: { pivot: { x: 0.02, y: 0.1 }, angle: Math.PI, length: 0.05, radius: 0.012 },
  };
  const ballRadius = 0.0135;
  // Ball resting between two facing, nearly-touching flipper segments (a contrived closed-V).
  const ballPos = { x: 0, y: 0.1 };
  const cls = classifySettle({ ballPos, ballRadius, flippers, guideShapes: [] });
  assert.equal(cls.cv, 1);
});

// --- End-to-end determinism / basic shape, matching instrument.test.mjs's E1 conventions. ---

test('e4: determinism — same (cfgId, seed) reproduces a bit-identical record', () => {
  const cfgs = buildE4SliceCfgs();
  for (const cfg of cfgs) {
    const a = runTrial(cfg, 3);
    const b = runTrial(cfg, 3);
    assert.deepEqual(a, b, `cfg ${cfg.cfgId} (${cfg.arm}) is not deterministic`);
  }
});

test('e4: every slice/control cfg produces a well-formed record with a terminal state', () => {
  const cfgs = buildE4SliceCfgs();
  for (const cfg of cfgs) {
    const { record, steps } = runTrialWithMeta(cfg, 5);
    assert.ok(steps > 0);
    assert.ok(['settled', 'drain', 'shotline', 'timeout', 'escaped', 'nan'].includes(record.term));
    assert.ok(record.sd === 'L' || record.sd === 'R');
  }
});

test('e4: C0 uses E1\'s 2.0s window, C0b uses the 4.0s default (distinguishable via longer median settle time)', () => {
  const [c0, c0b] = buildE4Controls();
  assert.equal(c0.timeoutS, 2.0);
  assert.equal(c0b.timeoutS, undefined);
});

test('e4: Stage C (release) trials continue past settle instead of terminating on STALLED', () => {
  const cfgs = buildE4SliceCfgs();
  const w1 = cfgs.find((c) => c.arm === 'W1-slice');
  const releaseCfg = { ...w1, pol: 'holdThenRelease', releaseDelayMs: 60, release: true, cfgId: `${w1.cfgId}-rel` };
  let sawPostSettleStep = false;
  for (let s = 0; s < 40 && !sawPostSettleStep; s++) {
    let settledAtStep = null;
    let stepIdx = 0;
    runTrialWithMeta(releaseCfg, s, {
      onStep: () => {
        stepIdx += 1;
      },
    });
    const { record } = runTrialWithMeta(releaseCfg, s);
    if (record.ct === 1 && record.term !== 'settled') sawPostSettleStep = true;
  }
  assert.ok(sawPostSettleStep, 'no seed among the first 40 ever settled-then-continued for a release cfg — Stage C loop is terminating on STALLED like Stage A/B');
});

// --- LAB-20: every ranking guard must be visible in the markdown -------------------------
// e4Report computes four guards (a1/a2/b/releaseDispersion) but only three had a per-table ⚠
// block. `a1` renders no table of its own at all, so a failing a1 was invisible to a reader of
// the .md and survived only as a JSON field. A per-table block cannot fix that class of gap —
// a guard with no table has nowhere to hang one — so the status of ALL FOUR is now stated in
// one block near the top, whatever each guard's verdict.
test('LAB-20: guardStatusLines reports every guard, including one with no table of its own (a1)', () => {
  const lines = guardStatusLines({
    a1: { ok: false, n: 350, reason: 'only 1 distinct value(s) across 350 rows (floor 5) — cannot support an ordering' },
    a2: { ok: true, n: 198, reason: null },
    b: { ok: false, n: 540, reason: 'top-20 cut lands inside a 101-way tie for 20 remaining slot(s) (5.05x, ceiling 2x)' },
    releaseDispersion: { ok: false, n: 6, reason: 'only 3 distinct value(s) across 6 rows (floor 5)' },
  });
  const text = lines.join('\n');
  for (const k of ['a1', 'a2', 'b', 'releaseDispersion']) {
    assert.match(text, new RegExp(`\\b${k}\\b`), `${k} must appear in the guard status block`);
  }
  assert.match(text, /101-way tie/, "b's reason must be quoted, not just its name");
  assert.match(text, /cannot support an ordering/, "a1's reason must be quoted");
});

test('LAB-20: guardStatusLines marks an all-passing set as such without crying wolf', () => {
  const lines = guardStatusLines({
    a1: { ok: true, n: 350, reason: null },
    a2: { ok: true, n: 198, reason: null },
    b: { ok: true, n: 540, reason: null },
    releaseDispersion: { ok: true, n: 6, reason: null },
  });
  const text = lines.join('\n');
  assert.doesNotMatch(text, /RANKING INVALID/, 'no failure banner when every guard passes');
  assert.match(text, /a1/, 'still enumerates the guards so their status is on the record');
});
