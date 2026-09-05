// Parameter grids -> [{cfgId, ...cfg}], plus the stable cfgId hash every record/summary
// traces back to its parameters by (program handoff §2.4/§2.9). Pure — no I/O; `cfgs/*.json`
// files are written by callers (see the bottom of this file for the pilot generator, run
// once and committed) or by a future LAB-2 script for the full Stage A/B grids.
import { createHash } from 'node:crypto';
import {
  SERIES_A_FIELD_WIDTH, SERIES_A_FIELD_HEIGHT, SERIES_A_FIELD_AREA,
  NOMINAL_SKIRT_RADIUS, SERIES_B_AREA_FRACTION,
  seriesASkirtRadius, seriesBFieldSize, effectiveAreaFraction,
} from './arenas/e2_bumpers.js';
import { buildE4World, pocketSolve, LEFT_PIVOT } from './arenas/e4_pocket.js';

/** First 8 hex of sha256 over the sorted-key JSON of `cfg` — same value regardless of key
 * insertion order, so two callers building "the same" cfg by different code paths agree. */
export function cfgId(cfg) {
  const sorted = sortKeysDeep(cfg);
  const json = JSON.stringify(sorted);
  return createHash('sha256').update(json).digest('hex').slice(0, 8);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

/** Cartesian product of named parameter lists: {a:[1,2], b:['x','y']} -> four cfgs. */
export function expandGrid(paramLists) {
  const keys = Object.keys(paramLists);
  let cfgs = [{}];
  for (const key of keys) {
    const next = [];
    for (const partial of cfgs) {
      for (const value of paramLists[key]) next.push({ ...partial, [key]: value });
    }
    cfgs = next;
  }
  return cfgs;
}

/** Throws if `cfgs` (each already carrying a `cfgId`) has a repeated id. Interim fix for the
 * code review's P1-3 (32-bit cfgId, 13.3% birthday collision probability at the largest
 * committed grid's size): converts a silent merge of two geometries' records under one id into
 * a loud failure at build time, cheaply, without widening cfgId (that needs a versioned
 * `cfgIdV2` migration, deferred — see review §2, P1-3). */
export function assertUniqueCfgIds(cfgs, label) {
  const seen = new Map();
  for (let i = 0; i < cfgs.length; i++) {
    const id = cfgs[i].cfgId;
    if (seen.has(id)) {
      throw new Error(`${label}: duplicate cfgId ${id} (collision between cfg #${seen.get(id)} and #${i} of ${cfgs.length})`);
    }
    seen.set(id, i);
  }
}

/** Attach a stable cfgId to every cfg in a list produced by expandGrid (or hand-built). */
export function withCfgIds(cfgs, label = 'withCfgIds') {
  const withIds = cfgs.map((cfg) => ({ cfgId: cfgId(cfg), ...cfg }));
  assertUniqueCfgIds(withIds, label);
  return withIds;
}

// --- E1 pilot cfg set (program handoff's LAB-1 scope: prove the harness and the policy
// machinery end-to-end, NOT the full §3.3 geometry x policy cross product — that's Stage A/B,
// explicitly deferred to LAB-2). One fixed geometry (RECESS's current live constants, so the
// pilot's numbers are at least meaningful on their own), crossed with a small but real spread
// across all three policy families, so every §3.4 column (pol/R/L/dt/hp/...) gets exercised. --
const PILOT_GEOMETRY = {
  exp: 'e1',
  restAngleDeg: -50, // RECESS's current value (physics/constants.js FLIPPER.lower.restAngle)
  activeAngleDeg: 32,
  upMs: 14,
  radius: 0.012, // RECESS's default flipper radius (physics/flipper.js createFlipper)
  restitution: 0.85, // physics/constants.js E_FLIPPER
  // omegaProfile intentionally absent from every pilot cfg: the deliverable 10k run is also
  // the §2.2 gate's "10k run with no profile set" byte-identical-to-pre-change comparison.
  // The hook itself is exercised by test/omegaProfile.test.mjs instead.
};

const PILOT_POLICIES = [
  { pol: 'never' },
  { pol: 'fixedDelay', d: 0 },
  { pol: 'fixedDelay', d: 50 },
  { pol: 'fixedDelay', d: 100 },
  { pol: 'fixedDelay', d: 150 },
  { pol: 'fixedDelay', d: 200 },
  { pol: 'proximity', R: 0.07, L: 0 },
  { pol: 'proximity', R: 0.07, L: 40 },
  { pol: 'proximity', R: 0.1, L: 0 },
  { pol: 'proximity', R: 0.1, L: 40 },
  { pol: 'proximity', R: 0.14, L: 0 },
  { pol: 'proximity', R: 0.14, L: 40 },
];

export function buildE1PilotCfgs() {
  return withCfgIds(PILOT_POLICIES.map((p) => ({ ...PILOT_GEOMETRY, ...p })), 'buildE1PilotCfgs');
}

// --- LAB-2: the §3.3 Stage A/B geometry x policy sweep. ---

// §3.3 full geometry grid: 6 x 3 x 6 x 4 x 3 x 3 = 3,888 cfgs.
export const GEOMETRY_GRID = {
  restAngleDeg: [-50, -44, -38, -32, -28, -22],
  activeAngleDeg: [26, 32, 38],
  upMs: [8, 11, 14, 18, 24, 32],
  omegaProfile: ['constant', 'easeOut', 'easeIn', 'sCurve'],
  radius: [0.009, 0.012, 0.015],
  restitution: [0.45, 0.65, 0.85],
};

export function buildGeometryGrid() {
  return expandGrid(GEOMETRY_GRID).map((g) => ({ exp: 'e1', ...g }));
}

// §3.3 Stage A reduced policy set (9): never + fixedDelay at 6 representative values spanning
// the full 0-200ms range (not all 21 — that's Stage B's job) + proximity at R=0.10, L in
// {0,40}. Named STAGE_A_FIXED_DELAYS explicitly so the "which 6" choice is documented, not
// implicit in a slice.
const STAGE_A_FIXED_DELAYS = [0, 40, 80, 120, 160, 200];
export function buildStageAPolicies() {
  return [
    { pol: 'never' },
    ...STAGE_A_FIXED_DELAYS.map((d) => ({ pol: 'fixedDelay', d })),
    { pol: 'proximity', R: 0.10, L: 0 },
    { pol: 'proximity', R: 0.10, L: 40 },
  ];
}

/** Stage A screen cfgs: 3,888 geometries x 9 policies = 34,992 cfgs, run at ~11 trials/cell
 * over 400k total trials (§3.3). */
export function buildE1StageACfgs() {
  const geoms = buildGeometryGrid();
  const policies = buildStageAPolicies();
  const cfgs = [];
  for (const g of geoms) for (const p of policies) cfgs.push({ ...g, ...p });
  return withCfgIds(cfgs, 'buildE1StageACfgs');
}

// §3.2's full mandated policy set: never(1) + fixedDelay d in {0,10,...,200} (21) +
// proximity R in {0.04,0.07,0.10,0.14,0.20} x L in {0,20,40,80} (20) = 42 points. (The
// program handoff's §3.3 arithmetic says "41-point ... ~984 cells"; the itemised §3.2 grid
// this is built from sums to 42 — see the LAB-2 handoff for the discrepancy note. Stage B
// uses the itemised 42-point set since it's the one with an explicit enumeration.)
export function buildStageBPolicies() {
  const fixedDelays = Array.from({ length: 21 }, (_, i) => i * 10); // 0..200 step 10
  const radii = [0.04, 0.07, 0.10, 0.14, 0.20];
  const latencies = [0, 20, 40, 80];
  const policies = [{ pol: 'never' }, ...fixedDelays.map((d) => ({ pol: 'fixedDelay', d }))];
  for (const R of radii) for (const L of latencies) policies.push({ pol: 'proximity', R, L });
  return policies;
}

/** Stage B characterise cfgs: `geometries` (top 24 from Stage A) x the full 42-point policy
 * sweep. `geometries` are plain geometry objects (restAngleDeg/activeAngleDeg/upMs/
 * omegaProfile/radius/restitution), as selected by rankStageA.js. */
export function buildE1StageBCfgs(geometries) {
  const policies = buildStageBPolicies();
  const cfgs = [];
  for (const g of geometries) for (const p of policies) cfgs.push({ exp: 'e1', ...g, ...p });
  return withCfgIds(cfgs, 'buildE1StageBCfgs');
}

/** §3.5 cradle family cfgs: one per selected geometry, `pol: 'heldActive'`, `cradle: true`. */
export function buildE1CradleCfgs(geometries) {
  return withCfgIds(geometries.map((g) => ({ exp: 'e1', ...g, pol: 'heldActive', cradle: true })), 'buildE1CradleCfgs');
}

// --- LAB-3: the §4 EXPERIMENT 2 (bumpers) cfg sets. ---

export const E2_N_VALUES = [1, 2, 3, 5, 10, 50]; // §4 mandated grid
export const E2_LAYOUT_VARIANTS = 3; // §4.2: 2 seeded Poisson-disc + 1 hex-pack (variant 2)

/** §4.2 Series A (mandated): fixed field, N in {1,2,3,5,10,50}, skirt radius
 * min(0.030, r_feasible(N)) so the effective area fraction never exceeds 0.40. 3 layout
 * variants per N. `areaFraction` and `N` are both attached to every cfg per §4.2's "no
 * summary reports N without it". */
export function buildE2SeriesACfgs() {
  const cfgs = [];
  for (const N of E2_N_VALUES) {
    const radius = seriesASkirtRadius(N);
    const areaFraction = effectiveAreaFraction(N, radius, SERIES_A_FIELD_AREA);
    for (let layoutVariant = 0; layoutVariant < E2_LAYOUT_VARIANTS; layoutVariant++) {
      cfgs.push({
        exp: 'e2', series: 'A', N, radius,
        fieldWidth: SERIES_A_FIELD_WIDTH, fieldHeight: SERIES_A_FIELD_HEIGHT,
        areaFraction, layoutVariant,
      });
    }
  }
  return withCfgIds(cfgs, 'buildE2SeriesACfgs');
}

/** §4.2 Series B (opus2 extension): field grows with N to hold area fraction fixed at 0.15,
 * skirt fixed at the nominal 0.030 m — isolates "more bumpers" from "tighter bumpers". */
export function buildE2SeriesBCfgs() {
  const cfgs = [];
  for (const N of E2_N_VALUES) {
    const radius = NOMINAL_SKIRT_RADIUS;
    const { fieldWidth, fieldHeight, fieldArea } = seriesBFieldSize(N, radius, SERIES_B_AREA_FRACTION);
    const areaFraction = effectiveAreaFraction(N, radius, fieldArea);
    for (let layoutVariant = 0; layoutVariant < E2_LAYOUT_VARIANTS; layoutVariant++) {
      cfgs.push({ exp: 'e2', series: 'B', N, radius, fieldWidth, fieldHeight, areaFraction, layoutVariant });
    }
  }
  return withCfgIds(cfgs, 'buildE2SeriesBCfgs');
}

// §4.4's divergence chaos measure: "re-run 5% of trials with the inbound angle perturbed by
// 1e-6 rad". Applied to Series A only (the series that spans area fraction from ~2.6% to 40%
// and is therefore the one the knee is actually located against; Series B holds area fraction
// fixed at 0.15 by construction, so a divergence curve over Series B alone couldn't locate a
// knee — it's a single point). Each divergence cfg carries `baseCfgId` so the report can pair
// it back to its Series A counterpart by (N, layoutVariant) without re-deriving the hash.
export const E2_PERTURB_ANGLE_RAD = 1e-6;
export const E2_DIVERGENCE_FRACTION = 0.05;

export function buildE2DivergenceCfgs(seriesACfgs) {
  return withCfgIds(seriesACfgs.map((c) => {
    const { cfgId: baseCfgId, ...rest } = c;
    return { ...rest, baseCfgId, perturbAngleRad: E2_PERTURB_ANGLE_RAD };
  }), 'buildE2DivergenceCfgs');
}

// --- LAB-6: EXPERIMENT 4 (the pocket) cfg sets, per opus2's design handoff
// (ledger/handoffs/opus2/20260901T134133Z-pinball-lab-e4-design.md), §2/§6. ---

// LAB-2's winning geometry (`dba8027f`, program handoff §3.6): the flipper held fixed for
// every E4 screening stage except where the design explicitly re-sweeps it (Stage B, §6.2).
export const E4_LAB2_WINNER = {
  restAngleDeg: -32, activeAngleDeg: 26, upMs: 8, omegaProfile: 'sCurve', radius: 0.012, restitution: 0.45,
};

function e4Base(overrides = {}) {
  return {
    exp: 'e4', ...E4_LAB2_WINNER, pol: 'heldActive', inj: 'drop',
    guide: null, feed: null, post: null, outlaneW: null, shelf: false, release: false,
    ...overrides,
  };
}

/** Attach the §1.1/§2.5-point-3 two-contact solve to a `guide` param object — both sides
 * (they're mirror images of each other given a symmetric grid, but computed independently
 * rather than assumed, since a future asymmetric cfg could break that assumption silently). */
function withPocketSolve(guide, { activeAngleDeg, radius }) {
  const left = pocketSolve({ ...guide, activeAngleDeg, flipperRadius: radius, side: 1 });
  const right = pocketSolve({ ...guide, activeAngleDeg, flipperRadius: radius, side: -1 });
  return {
    ...guide,
    pocketFeasible: left.feasible && right.feasible,
    pocketPredicted: { left: left.point, right: right.point },
  };
}

/** §6.4 control arms, one geometry (LAB-2's winner unless overridden). C0 reproduces E1's
 * exact 2.0s window (`timeoutS`); C0b is identical but at E4's own 4.0s default — the pairing
 * that decomposes §1.2's "was E1's null a geometry problem or a time-budget problem". C1 is
 * the shelf upper bound. Every cfg carries `arm` so a stage runner/report can find them by name. */
export function buildE4Controls(geom = E4_LAB2_WINNER) {
  return withCfgIds([
    e4Base({ ...geom, arm: 'C0', timeoutS: 2.0 }),
    e4Base({ ...geom, arm: 'C0b' }),
    e4Base({ ...geom, arm: 'C1', shelf: true }),
  ], 'buildE4Controls');
}

/** §9's first slice: one W1 assembly at the design's own worked example (gapX 0.026, tilt 0,
 * endDy 0, guideE 0.45, r_flip 0.012 — i.e. LAB-2's winner unmodified) plus C0/C0b. Exactly
 * the 3 cfgs `node src/stageA.js --exp e4 --cfgs cfgs/e4-slice.json --trials 6000 ...` needs
 * to run at 2,000 trials/cfg. */
export function buildE4SliceCfgs() {
  const guide = withPocketSolve({ gapX: 0.026, tiltDeg: 0, endDy: 0, guideE: 0.45 }, E4_LAB2_WINNER);
  const w1 = e4Base({ guide, arm: 'W1-slice' });
  return [...withCfgIds([w1], 'buildE4SliceCfgs'), ...buildE4Controls()];
}

// §2.1 W1 grid (120 guides) x §6.1's radius crossing (3) = 360 combinations. Not every
// combination is buildable — §2.5 assertion 1 (foul the flipper sweep) is expected to reject
// some (the design's own "one too tight, fouls the cap at r=0.015"); `buildE4StageA1Cfgs`
// validates each by actually building the world and drops (and counts) any that throw, rather
// than shipping an unrunnable cfg into the batch runner.
export const E4_W1_GRID = {
  gapX: [0.016, 0.021, 0.026, 0.031, 0.038],
  tiltDeg: [0, 8, 16, 24],
  endDy: [-0.020, 0, 0.020],
  guideE: [0.20, 0.45],
};
export const E4_RADII = [0.009, 0.012, 0.015];

export function buildE4StageA1Cfgs() {
  const guides = expandGrid(E4_W1_GRID);
  const cfgs = [];
  let excluded = 0;
  for (const radius of E4_RADII) {
    for (const g of guides) {
      const guide = withPocketSolve(g, { ...E4_LAB2_WINNER, radius });
      const base = e4Base({ ...E4_LAB2_WINNER, radius, guide, arm: 'A1' });
      const cfg = { cfgId: cfgId(base), ...base };
      try {
        buildE4World(cfg);
        cfgs.push(cfg);
      } catch {
        excluded += 1;
      }
    }
  }
  assertUniqueCfgIds(cfgs, 'buildE4StageA1Cfgs');
  return { cfgs, excluded, total: E4_RADII.length * guides.length };
}

// §6.1 A2: the other three families, screened on the top 8 pockets from A1. Screen levels per
// §2.2-§2.4. W4's design prose enumerates 3 outlaneW *values* but the arithmetic
// "W2(4)xW3(4)xW4(3)=384" treats W4 as a 3-LEVEL family overall — one short of "off" plus all
// three values (4). Resolved the way LAB-2 documented its own "42 vs 41" discrepancy: take the
// arithmetic (3) as authoritative and drop the tightest value (0.020m, closest to the guide's
// own gapX dimension already swept in W1 and least likely to be independently informative) —
// {off, 0.030, 0.045}. Recorded here rather than silently picked.
export const E4_W2_LEVELS = [
  null,
  { feedAngleDeg: 24, feedHs: 0.35 },
  { feedAngleDeg: 24, feedHs: 0.65 },
  { feedAngleDeg: 24, feedHs: 0.90 },
];
export const E4_W3_LEVELS = [
  null,
  { dx: 0, dy: 0.030, postR: 0.006, postE: 0.45 },
  { dx: 0, dy: 0.030, postR: 0.014, postE: 0.45 },
  { dx: -0.012, dy: 0.026, postR: 0.010, postE: 0.45 },
];
export const E4_W4_LEVELS = [null, 0.030, 0.045];


/** Validate every cfg by actually building the world, dropping (and counting) any that
 * throw §2.5's assertions (a foul or an injection overlap) — the same discipline
 * buildE4StageA1Cfgs applies to the W1 grid, extended to every later stage since W2/W3/W4
 * combinations (and Stage B/C's flipper geometry sweep) can foul or overlap just as easily. */
function filterBuildable(cfgs) {
  const kept = [];
  let excluded = 0;
  for (const cfg of cfgs) {
    try {
      buildE4World(cfg);
      kept.push(cfg);
    } catch {
      excluded += 1;
    }
  }
  return { cfgs: kept, excluded, total: cfgs.length };
}

export function buildE4StageA2Cfgs(topPockets) {
  const cfgs = [];
  for (const pocket of topPockets) {
    const geom = { restAngleDeg: E4_LAB2_WINNER.restAngleDeg, activeAngleDeg: E4_LAB2_WINNER.activeAngleDeg, upMs: E4_LAB2_WINNER.upMs, omegaProfile: E4_LAB2_WINNER.omegaProfile, restitution: E4_LAB2_WINNER.restitution, radius: pocket.radius };
    for (const feed of E4_W2_LEVELS) {
      for (const post of E4_W3_LEVELS) {
        for (const outlaneW of E4_W4_LEVELS) {
          const inj = feed ? 'inlane' : 'drop';
          cfgs.push(e4Base({ ...geom, guide: pocket.guide, feed, post, outlaneW, inj, arm: 'A2', basePocketId: pocket.cfgId }));
        }
      }
    }
  }
  return filterBuildable(withCfgIds(cfgs, 'buildE4StageA2Cfgs'));
}

// §6.2 Stage B: top 10 assemblies (A2 result) x flipper geometry x delivery x policy. upMs and
// omegaProfile are held at the winner's (§6.2: "held flipper's sweep profile barely touches
// whether a ball settles" for held policies; it returns in Stage C). `fireAndHold`'s R/L are
// not in the design's own crossed grid (1,080 cfgs has no room left for a 4th/5th policy
// dimension); fixed at R=0.10/L=0 — E1 Stage A's own "one representative proximity point" —
// documented here rather than silently defaulted.
export const E4_STAGEB_REST = [-50, -38, -32];
export const E4_STAGEB_ACTIVE = [26, 32, 38];
export const E4_STAGEB_EFLIP = [0.20, 0.45, 0.85];
export const E4_STAGEB_INJ = ['drop', 'inlane'];
export const E4_STAGEB_POL = ['heldActive', 'fireAndHold'];
export const E4_FIRE_AND_HOLD_R = 0.10;
export const E4_FIRE_AND_HOLD_L = 0;

export function buildE4StageBCfgs(topAssemblies) {
  const cfgs = [];
  for (const asm of topAssemblies) {
    for (const restAngleDeg of E4_STAGEB_REST) {
      for (const activeAngleDeg of E4_STAGEB_ACTIVE) {
        for (const restitution of E4_STAGEB_EFLIP) {
          for (const inj of E4_STAGEB_INJ) {
            if (inj === 'inlane' && !asm.feed) continue; // no rail to inject onto
            for (const pol of E4_STAGEB_POL) {
              const guide = withPocketSolve(
                { gapX: asm.guide.gapX, tiltDeg: asm.guide.tiltDeg, endDy: asm.guide.endDy, guideE: asm.guide.guideE },
                { activeAngleDeg, radius: asm.radius }
              );
              const base = e4Base({
                restAngleDeg, activeAngleDeg, upMs: E4_LAB2_WINNER.upMs, omegaProfile: E4_LAB2_WINNER.omegaProfile,
                radius: asm.radius, restitution, inj, guide, feed: asm.feed, post: asm.post, outlaneW: asm.outlaneW,
                pol, arm: 'B', baseAssemblyId: asm.cfgId,
              });
              if (pol === 'fireAndHold') { base.R = E4_FIRE_AND_HOLD_R; base.L = E4_FIRE_AND_HOLD_L; }
              cfgs.push(base);
            }
          }
        }
      }
    }
  }
  return filterBuildable(withCfgIds(cfgs, 'buildE4StageBCfgs'));
}

// §6.3 Stage C: top 6 assemblies x 3 best flipper geometries (from B) x upMs x releaseDelayMs,
// policy `holdThenRelease`, `cfg.release=true` (6.0s window per §1.2/instrument.js). `inj`
// fixed at 'drop' — the paired-vs-E1 mode, and Stage B already answers whether inlane changes
// the ranking; Stage C's job is the release protocol, not re-litigating delivery mode.
export const E4_STAGEC_UPMS = [8, 14, 24];
export const E4_STAGEC_RELEASE_DELAY_MS = [60, 150, 350];

export function buildE4StageCCfgs(topAssembliesWithGeoms) {
  const cfgs = [];
  for (const entry of topAssembliesWithGeoms) {
    for (const upMs of E4_STAGEC_UPMS) {
      for (const releaseDelayMs of E4_STAGEC_RELEASE_DELAY_MS) {
        cfgs.push(e4Base({
          restAngleDeg: entry.restAngleDeg, activeAngleDeg: entry.activeAngleDeg, upMs,
          omegaProfile: E4_LAB2_WINNER.omegaProfile, radius: entry.radius, restitution: entry.restitution,
          inj: 'drop', guide: entry.guide, feed: entry.feed, post: entry.post, outlaneW: entry.outlaneW,
          pol: 'holdThenRelease', releaseDelayMs, release: true, arm: 'C', baseAssemblyId: entry.cfgId,
        }));
      }
    }
  }
  return filterBuildable(withCfgIds(cfgs, 'buildE4StageCCfgs'));
}

// --- LAB-10: EXPERIMENT 5a — the release diagnostic (opus2 roadmap §3, E5a). LAB-6's Stage C
// only ever released from its top-cp rows, which the report itself flags as clustering at
// hsS≈0 — so E4's "catch/playability tradeoff" claim was never tested against a ball resting
// further out on the flipper. E5a re-runs the SAME release protocol (holdThenRelease, same
// upMs/releaseDelayMs grids, same 'drop' injection, same 6.0s release window) but chooses its
// assemblies by STRATIFYING ACROSS hsS instead of ranking by cp — deliberately including
// low-cp/high-hsS geometries Stage C never touched. Zero new physics: same arena
// (arenas/e4_pocket.js), same instrument.js release classification; only the assembly-
// selection axis changes.
const E5A_DEG = Math.PI / 180;
const E5A_FLIPPER_LENGTH = 0.075; // physics/constants.js FLIPPER.lower.length — same constant
// Stage C's flipper-geometry crossing narrowed to activeAngleDeg only (Stage B's own grid,
// E4_STAGEB_ACTIVE) — this is the dimension that actually moves hsS at fixed guide geometry
// (pocketSolve's intersection point slides along the flipper as its direction rotates);
// restAngleDeg/restitution held at LAB-2's winner, same as every other E4 stage's "the flipper
// held fixed except where the design explicitly re-sweeps it" convention.
export const E5A_ACTIVE_ANGLES = E4_STAGEB_ACTIVE;
export const E5A_N_BINS = 16;

/** Analytic hsS for a W1 guide + activeAngleDeg + radius, using the SAME two-contact solve
 * (`pocketSolve`) and the SAME clamped-projection definition instrument.js's `classifySettle`
 * uses for the measured `hsS` (0 = pivot, 1 = tip) — this is the predicted rest position along
 * the flipper, not a re-derivation of the physics. `null` when the pair isn't feasible
 * (mirrors `withPocketSolve`'s own feasibility check). Canonical left (`side: 1`) only — hsS is
 * side-symmetric by construction (the whole assembly is built mirrored), so the right side
 * carries no independent information. */
/** LAB-27: the SAME projection, WITHOUT the clamp. `predictHsS` clamps to [0,1] to match the
 * range `classifySettle` reports for the MEASURED hsS — correct for comparing predicted against
 * measured, and wrong for use as an ordering axis, because 62.4% of the 1,080 feasible
 * assemblies project to a negative t and collapse onto exactly 0. Unclamped the same quantity
 * spans [-0.3811, +0.2546] with 450 distinct values. A negative value is meaningful: the
 * two-contact solve puts the rest point BEHIND the pivot, i.e. that assembly cannot cradle on
 * the bat at all, and how far behind is a real geometric ordering. */
export function predictHsSRaw({ gapX, tiltDeg, endDy, activeAngleDeg, radius }) {
  const sol = pocketSolve({ gapX, tiltDeg, endDy, activeAngleDeg, flipperRadius: radius, side: 1 });
  if (!sol.feasible) return null;
  const dir = { x: Math.cos(activeAngleDeg * E5A_DEG), y: Math.sin(activeAngleDeg * E5A_DEG) };
  const t = (sol.point.x - LEFT_PIVOT.x) * dir.x + (sol.point.y - LEFT_PIVOT.y) * dir.y;
  return t / E5A_FLIPPER_LENGTH;
}

function predictHsS(args) {
  const raw = predictHsSRaw(args);
  return raw === null ? null : Math.max(0, Math.min(1, raw));
}

/** The W1 grid (gapX x tiltDeg x endDy x guideE, §2.1 — same 120-guide grid Stage A1
 * screened) crossed with Stage B's activeAngleDeg values, radius held at the winner's, scored
 * by predicted hsS and picked one-per-quantile-bin across the WHOLE feasible range —
 * deliberately unlike Stage C's "rank by cp, take the top 6", which is exactly the selection
 * this diagnostic is testing for confound. Adjacent bins can collide on a sparse tail (few
 * feasible points at the extremes); de-duplicated by (gapX,tiltDeg,endDy,guideE,activeAngleDeg)
 * rather than padded back to E5A_N_BINS, so the sample can legitimately come back thinner than
 * 16 if the feasible hsS range is narrow. */
export function buildE5aAssemblies() {
  const guides = expandGrid(E4_W1_GRID);
  const candidates = [];
  for (const g of guides) {
    // Radius crossed too (A1's own §6.1 dimension, E4_RADII) — fixing it at the winner's alone
    // caps the reachable hsS at ~0.18 (checked); a genuine "whole hsS range" sweep needs the
    // full A1 W1-grid x radius space (1,080 combinations, unclamped hsS spans roughly
    // [-0.38, +0.25] before the classifySettle-matching clamp to [0,1] below).
    for (const radius of E4_RADII) {
      for (const activeAngleDeg of E5A_ACTIVE_ANGLES) {
        const hsSRaw = predictHsSRaw({ ...g, activeAngleDeg, radius });
        if (hsSRaw === null) continue;
        const hsSPredicted = Math.max(0, Math.min(1, hsSRaw));
        candidates.push({ ...g, activeAngleDeg, radius, hsSRaw, hsSPredicted, guide: withPocketSolve(g, { activeAngleDeg, radius }) });
      }
    }
  }
  // LAB-27: bin RANGE-uniformly on the unclamped axis, not by quantile on the clamped one.
  //
  // The old design quantile-binned `hsSPredicted`, which does two harmful things at once: the
  // clamp had already collapsed 62.4% of candidates onto exactly 0, and quantile bins then
  // spend the budget where candidates are DENSE — which is the flat, negative region. The
  // result was 9 of 15 assemblies at hsS 0.0000 and only 2 above 0.10, so the whole verdict
  // rested on two rows and the axis failed gate.js's own population test.
  //
  // Range-uniform is the design the question implies. E5a asks "does shot rate rise WITH hsS",
  // a question about the axis, so the sample should be even along the axis. Quantile binning
  // answers a different question — "what does a typical geometry do" — and starves exactly the
  // band where the behaviour changes.
  candidates.sort((a, b) => a.hsSRaw - b.hsSRaw);
  const n = candidates.length;
  if (n === 0) return [];
  const lo = candidates[0].hsSRaw, hi = candidates[n - 1].hsSRaw;
  const seen = new Set();
  const picked = [];
  for (let i = 0; i < E5A_N_BINS; i++) {
    const target = lo + ((i + 0.5) * (hi - lo)) / E5A_N_BINS;
    // Nearest unused candidate to this bin's centre, so a sparse band still contributes its
    // closest real assembly instead of silently dropping out of the sweep.
    let best = null, bestD = Infinity;
    for (const c of candidates) {
      const key = `${c.gapX}|${c.tiltDeg}|${c.endDy}|${c.guideE}|${c.activeAngleDeg}|${c.radius}`;
      if (seen.has(key)) continue;
      const d = Math.abs(c.hsSRaw - target);
      if (d < bestD) { bestD = d; best = { c, key }; }
    }
    if (!best) break;
    seen.add(best.key);
    picked.push(best.c);
  }
  picked.sort((a, b) => a.hsSRaw - b.hsSRaw);
  return picked;
}

export function buildE5aCfgs() {
  const assemblies = buildE5aAssemblies();
  const cfgs = [];
  for (const asm of assemblies) {
    for (const upMs of E4_STAGEC_UPMS) {
      for (const releaseDelayMs of E4_STAGEC_RELEASE_DELAY_MS) {
        cfgs.push(e4Base({
          restAngleDeg: E4_LAB2_WINNER.restAngleDeg, activeAngleDeg: asm.activeAngleDeg, upMs,
          omegaProfile: E4_LAB2_WINNER.omegaProfile, radius: asm.radius, restitution: E4_LAB2_WINNER.restitution,
          inj: 'drop', guide: asm.guide, feed: null, post: null, outlaneW: null,
          pol: 'holdThenRelease', releaseDelayMs, release: true, arm: 'E5a', hsSPredicted: asm.hsSPredicted, hsSRaw: asm.hsSRaw,
        }));
      }
    }
  }
  const { cfgs: kept, excluded, total } = filterBuildable(withCfgIds(cfgs, 'buildE5aCfgs'));
  return { cfgs: kept, excluded, total, assemblyCount: assemblies.length };
}

// --- LAB-4: the §5 EXPERIMENT 3 (paths) cfg sets, per the program handoff §5.1/§5.3. Each
// family is its own small grid (documented per family below), `withCfgIds`-hashed the same
// way as every other experiment; `splitEvenly(1e6, 5)` gives each family 200,000 trials
// (§5.1's "200k trials per family") regardless of its own cfg count. P2-P4 carry
// `inputPrior`/`shotlineSamplesPath` (§5.3's E1 coupling) on every cfg alike — the coupling
// is a property of the RUN, not of any one geometry point in a family's grid. ---

export const E3_SHOTLINE_SAMPLES_PATH = 'data/summaries/e1-lab2-20260901T073830Z-shotline.json';

function withE1Coupling(cfgs, inputPrior, shotlineSamplesPath) {
  return cfgs.map((c) => ({ ...c, inputPrior, shotlineSamplesPath: inputPrior === 'e1' ? shotlineSamplesPath : null }));
}

// P1 launch lane — LAB-16 redesign, replacing the LAB-15-fixed 288-cfg 4-way factorial.
//
// Why: the operator's cross-check of LAB-15 (`ledger/handoffs/operator/
// 20260903T0540Z-e3-p1-is-degenerate.md`) found `inBandFraction` — the metric the old grid was
// RANKED on — is a pure step function of `plungerSpeed` alone (0.0 at 1.0, 1.0 at every other
// grid value): the 288-cfg factorial spent 200,000 balls sweeping 4 variables to find what was
// really a single 1-D threshold, with `deflectorAngleDeg` and `laneWidth` apparently inert and
// `gateThresholdFrac` real but only sampled at its two range extremes. LAB-16's own gate.js
// `rankingValidityResult` formalises "was inBandFraction ever able to rank this family" (it
// wasn't: 2 distinct values, 83% tied). This redesign switches to `returnRate` (continuous,
// real resolution — see gate.js's audit) and puts the trial budget where the old grid's own
// data said the transition band actually is.
//
// LAB-16's own higher-resolution probe (`ledger/handoffs/sonnet2/<this dispatch>.md` — 7-point
// sweeps at n=3000/point, held at a fixed representative point elsewhere in the grid) checked
// the operator's assumption that `deflectorAngleDeg` AND `laneWidth` were both safe to collapse
// to one representative value:
//   - `deflectorAngleDeg` across its full original [15,55] range: spread 3.3pp, no monotonic
//     trend (values bounce, not decline/rise) — genuinely inert. Collapsed to one representative
//     value (28°, the original grid's own near-median) — see the `deflectorControl` arm below,
//     which re-confirms this at every trial run rather than resting on this comment.
//   - `laneWidth` across [0.0291,0.045]: spread 5.4pp, clearly monotonic, and a tight-n corner
//     check (15,000 trials/end) gave z=7.97 for the difference — NOT inert. The old grid's own
//     "laneWidth spread 0.0032" (LAB-15/the operator's finding) was computed by pooling group
//     means across the WHOLE original factorial, most of which sits in a saturated
//     `returnRate≈0` or `≈1` regime where laneWidth's effect is invisible by construction
//     (ceiling/floor effect swamping a real but localised signal) — an aggregation artifact of
//     the same shape LAB-15 already found once for `inBandFraction` x `laneWidth`, just on a
//     different metric. So `laneWidth` stays a swept axis here, not a fixed value + control arm.
//   - a 4-corner probe of (plungerSpeed x gateThresholdFrac) inside the operator's proposed
//     [1.0,1.8]x[0.35,0.6] window found the relationship is NOT a simple joint threshold surface
//     (e.g. plungerSpeed=1.0 returns 0% at gateThresholdFrac=0.35 but 99% at
//     gateThresholdFrac=0.6 — the "easier" gate position performs far worse at low speed, not
//     better) — a real, non-monotonic interaction the operator's own "bisect each axis
//     independently, holding the other at one representative value" design would have missed
//     entirely (whichever representative value got picked for the other axis, silently, would
//     have determined the located "threshold" without that dependence ever being visible). A
//     joint grid over both axes is the only design that doesn't bake in an unchecked assumption
//     about their independence.
//
// Grid: plungerSpeed(7) x gateThresholdFrac(7) x laneWidth(4), deflectorAngleDeg fixed at 28°
// = 196 cfgs, plus a 7-point deflectorAngleDeg control arm at a representative interior point
// of the other three axes = 7 cfgs. 203 total, vs. the old design's 288 — fewer cfgs, but 7x7
// resolution on the two axes with real structure (old: 6x3, with 3 of the 6 plungerSpeed points
// wasted above the saturation ceiling at 1.8+) inside the narrower range the old grid's own data
// said mattered, plus a laneWidth axis the old ranking accidentally hid.
export const E3_P1_PLUNGER_SPEEDS = [1.0, 1.1333, 1.2667, 1.4, 1.5333, 1.6667, 1.8];
export const E3_P1_GATE_THRESHOLD_FRACS = [0.35, 0.3917, 0.4333, 0.475, 0.5167, 0.5583, 0.6];
export const E3_P1_LANE_WIDTHS = [0.0291, 0.034, 0.040, 0.045]; // 0.0291: see LAB-15's foul-margin derivation, kept verbatim
export const E3_P1_DEFLECTOR_REP_DEG = 28;
export const E3_P1_DEFLECTOR_CONTROL_DEGS = [15, 21.7, 28.3, 35, 41.7, 48.3, 55]; // spans the old grid's full [15,55] range
export function buildE3P1Cfgs() {
  const main = expandGrid({
    plungerSpeed: E3_P1_PLUNGER_SPEEDS,
    gateThresholdFrac: E3_P1_GATE_THRESHOLD_FRACS,
    laneWidth: E3_P1_LANE_WIDTHS,
  }).map((g) => ({ exp: 'e3', family: 'P1', arm: 'main', deflectorAngleDeg: E3_P1_DEFLECTOR_REP_DEG, ...g }));
  const deflectorControl = E3_P1_DEFLECTOR_CONTROL_DEGS.map((deflectorAngleDeg) => ({
    exp: 'e3', family: 'P1', arm: 'deflectorControl',
    plungerSpeed: 1.4, gateThresholdFrac: 0.475, laneWidth: 0.034, deflectorAngleDeg,
  }));
  return withCfgIds([...main, ...deflectorControl], 'buildE3P1Cfgs');
}

// P2 orbit: radius x entryAngleDeg x exitTangentDeg x wallRestitution = 4x5x5x3 = 300.
export const E3_P2_GRID = {
  radius: [0.10, 0.14, 0.18, 0.22],
  entryAngleDeg: [-20, -10, 0, 10, 20],
  exitTangentDeg: [-30, -15, 0, 15, 30],
  wallRestitution: [0.45, 0.65, 0.85],
};
export function buildE3P2Cfgs(inputPrior = 'e1', shotlineSamplesPath = E3_SHOTLINE_SAMPLES_PATH) {
  return withCfgIds(withE1Coupling(expandGrid(E3_P2_GRID).map((g) => ({ exp: 'e3', family: 'P2', ...g })), inputPrior, shotlineSamplesPath), 'buildE3P2Cfgs');
}

// P3 return lanes: guideAngleDeg x laneWidth x postX = 5x4x5 = 100.
//
// LAB-15: `assertPostClearsGuide` (arenas/e3_paths.js, added by LAB-14) fouled on 28/100 cfgs —
// a REAL overlap between the post circle and its own guide segment, not a margin technicality.
// Derivation (relative to a guide's own top end, side=1; the side=-1 guide is the mirror image
// so the same scalar relation holds): the post sits at (postX, -0.02) off the guide's top-end
// origin, and the guide runs from that origin in unit direction
// (-sin(guideAngleDeg), -cos(guideAngleDeg)). Because the post's closest approach always lands
// on the guide's own interior (never past either endpoint, for every postX/angle this grid
// uses — the projection stays inside [0, P3_GUIDE_LEN=0.30] throughout), the perpendicular
// distance from the post centre to the (infinite) guide line collapses to a clean closed form:
//
//     distance(postX, guideAngleDeg) = | postX * cos(guideAngleDeg) + 0.02 * sin(guideAngleDeg) |
//
// (derivation: distance^2 = |post|^2 - (post . dir)^2 = postX^2 + 0.02^2 - t*^2 where
// t* = post . dir; expanding and using sin^2+cos^2=1 collapses it to
// (postX*cos + 0.02*sin)^2 exactly — verified numerically against every cell of the old and
// new grids). The assertion requires `distance - P3_POST_RADIUS(0.008) > FOUL_MARGIN(0.001)`,
// i.e. `distance > 0.009`. Solving for postX at the boundary:
//
//     postX_min(guideAngleDeg) = (0.009 - 0.02*sin(guideAngleDeg)) / cos(guideAngleDeg)
//
// This is angle-dependent, and NOT a fixed offset: at 20deg it's +0.0023 (only positive postX
// clears the guide at all — the shallow angle brings the guide's own line too close to the
// post's nominal offset from either side); by 60deg it's -0.0166 (the whole -0.010..+0.010
// sweep clears with room to spare). Forcing one rectangular postX list across all five angles
// cannot be valid everywhere without either fouling the shallow angles or discarding the
// negative-postX arm everywhere (including angles where it's genuinely fine) — so P3's grid is
// built per-angle below instead of via `expandGrid`. Where an angle's existing valid postX
// values already clear (with real margin, confirmed against the rebuilt corpus — see the
// LAB-15 handoff) they are kept verbatim so their cfgId (and banked trials) survive; only the
// invalid low end of each angle's sweep is replaced, and the sweep is extended upward by the
// same amount removed from the bottom (same 0.005 spacing, same 5-point resolution, same total
// 0.020 span) so no angle loses coverage breadth relative to the original design.
const E3_P3_POSTX_BY_ANGLE = {
  20: [0.005, 0.010, 0.015, 0.020, 0.025], // postX_min=+0.0023: no valid negative postX at all
  30: [0, 0.005, 0.010, 0.015, 0.020], // postX_min=-0.0012: only postX=0 and above clear
  40: [-0.005, 0, 0.005, 0.010, 0.015], // postX_min=-0.0050: -0.005 already clears (barely)
  50: [-0.005, 0, 0.005, 0.010, 0.015], // postX_min=-0.0098: -0.005 already clears comfortably
  60: [-0.010, -0.005, 0, 0.005, 0.010], // postX_min=-0.0166: original range clears everywhere
};
export const E3_P3_GRID = {
  guideAngleDeg: [20, 30, 40, 50, 60],
  laneWidth: [0.026, 0.031, 0.037, 0.042],
};
export function buildE3P3Cfgs(inputPrior = 'e1', shotlineSamplesPath = E3_SHOTLINE_SAMPLES_PATH) {
  const cfgs = [];
  for (const guideAngleDeg of E3_P3_GRID.guideAngleDeg) {
    for (const laneWidth of E3_P3_GRID.laneWidth) {
      for (const postX of E3_P3_POSTX_BY_ANGLE[guideAngleDeg]) {
        cfgs.push({ exp: 'e3', family: 'P3', guideAngleDeg, laneWidth, postX });
      }
    }
  }
  return withCfgIds(withE1Coupling(cfgs, inputPrior, shotlineSamplesPath), 'buildE3P3Cfgs');
}

// P4 ramp mouth: mouthWidth x approachAngleDeg x rampMinSpeed = 4x5x5 = 100.
export const E3_P4_GRID = {
  mouthWidth: [0.030, 0.040, 0.050, 0.060],
  approachAngleDeg: [-25, -12, 0, 12, 25],
  rampMinSpeed: [0.3, 0.525, 0.75, 0.975, 1.2],
};
export function buildE3P4Cfgs(inputPrior = 'e1', shotlineSamplesPath = E3_SHOTLINE_SAMPLES_PATH) {
  return withCfgIds(withE1Coupling(expandGrid(E3_P4_GRID).map((g) => ({ exp: 'e3', family: 'P4', ...g })), inputPrior, shotlineSamplesPath), 'buildE3P4Cfgs');
}

// P5 habitrail drop: dropX x dropY x dropSpeed x dropDirectionDeg = 5x4x5x6 = 600. No E1
// coupling (§5.3 exception — see arenas/e3_paths.js's P5 comment).
export const E3_P5_GRID = {
  dropX: [-0.12, -0.06, 0, 0.06, 0.12],
  dropY: [0.25, 0.35, 0.45, 0.55],
  dropSpeed: [0.5, 1.0, 1.5, 2.0, 2.5],
  dropDirectionDeg: [200, 230, 260, 290, 320, 350],
};
export function buildE3P5Cfgs() {
  return withCfgIds(expandGrid(E3_P5_GRID).map((g) => ({ exp: 'e3', family: 'P5', ...g })), 'buildE3P5Cfgs');
}

/** All five families' cfgs concatenated, tagged with which family each block belongs to via
 * `cfg.family` (already set per-builder) — stageA.js's e3 branch uses this to size each
 * family's share of the 1e6-trial budget independently (§5.1: 200k/family, not 1e6/totalCfgs). */
export function buildE3AllCfgs() {
  const families = {
    P1: buildE3P1Cfgs(), P2: buildE3P2Cfgs(), P3: buildE3P3Cfgs(), P4: buildE3P4Cfgs(), P5: buildE3P5Cfgs(),
  };
  // Each family's own withCfgIds() call already asserts uniqueness within itself; this checks
  // the cross-family case (astronomically unlikely — cfgId hashes over `family` too — but the
  // point of the assertion is not trusting that argument, per P1-3).
  assertUniqueCfgIds(Object.values(families).flat(), 'buildE3AllCfgs');
  return families;
}

// `node src/sweep.js --exp e1 --grid pilot --out cfgs/e1-pilot.json` — writes the committed
// cfg file the CLI contract (§2.9) expects `runner.js --cfgs <path>` to read. Run once; the
// output is deterministic (cfgId is a pure hash), so re-running only matters if PILOT_* above
// changes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync, readFileSync } = await import('node:fs');
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, arr) => {
      if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
      return pairs;
    }, [])
  );
  if (args.exp === 'e1' && args.grid === 'pilot' && args.out) {
    writeFileSync(args.out, JSON.stringify(buildE1PilotCfgs(), null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: buildE1PilotCfgs().length, out: args.out }));
  } else if (args.exp === 'e1' && args.grid === 'stageA' && args.out) {
    const cfgs = buildE1StageACfgs();
    writeFileSync(args.out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, out: args.out }));
  } else if (args.exp === 'e1' && args.grid === 'stageB' && args.geometries && args.out) {
    const geometries = JSON.parse(readFileSync(args.geometries, 'utf8'));
    const cfgs = buildE1StageBCfgs(geometries);
    writeFileSync(args.out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, out: args.out }));
  } else if (args.exp === 'e1' && args.grid === 'cradle' && args.geometries && args.out) {
    const geometries = JSON.parse(readFileSync(args.geometries, 'utf8'));
    const cfgs = buildE1CradleCfgs(geometries);
    writeFileSync(args.out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, out: args.out }));
  } else if (args.exp === 'e2' && args.grid === 'seriesA' && args.out) {
    const cfgs = buildE2SeriesACfgs();
    writeFileSync(args.out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, out: args.out }));
  } else if (args.exp === 'e2' && args.grid === 'seriesB' && args.out) {
    const cfgs = buildE2SeriesBCfgs();
    writeFileSync(args.out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, out: args.out }));
  } else if (args.exp === 'e2' && args.grid === 'divergence' && args.seriesA && args.out) {
    const seriesACfgs = JSON.parse(readFileSync(args.seriesA, 'utf8'));
    const cfgs = buildE2DivergenceCfgs(seriesACfgs);
    writeFileSync(args.out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, out: args.out }));
  } else if (args.exp === 'e4' && args.grid === 'slice') {
    const out = args.out ?? 'cfgs/e4-slice.json';
    const cfgs = buildE4SliceCfgs();
    writeFileSync(out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, out }));
  } else if (args.exp === 'e4' && args.grid === 'stageA1') {
    const out = args.out ?? 'cfgs/e4-stageA1.json';
    const { cfgs, excluded, total } = buildE4StageA1Cfgs();
    writeFileSync(out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, excluded, total, out }));
  } else if (args.exp === 'e4' && args.grid === 'stageA2' && args.top) {
    const out = args.out ?? 'cfgs/e4-stageA2.json';
    const topPockets = JSON.parse(readFileSync(args.top, 'utf8'));
    const { cfgs, excluded, total } = buildE4StageA2Cfgs(topPockets);
    writeFileSync(out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, excluded, total, out }));
  } else if (args.exp === 'e4' && args.grid === 'stageB' && args.top) {
    const out = args.out ?? 'cfgs/e4-stageB.json';
    const topAssemblies = JSON.parse(readFileSync(args.top, 'utf8'));
    const { cfgs, excluded, total } = buildE4StageBCfgs(topAssemblies);
    writeFileSync(out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, excluded, total, out }));
  } else if (args.exp === 'e3' && args.grid === 'all') {
    const out = args.out ?? 'cfgs/e3-all.json';
    const byFamily = buildE3AllCfgs();
    const cfgs = [...byFamily.P1, ...byFamily.P2, ...byFamily.P3, ...byFamily.P4, ...byFamily.P5];
    writeFileSync(out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({
      ok: true, cfgs: cfgs.length,
      byFamily: Object.fromEntries(Object.entries(byFamily).map(([k, v]) => [k, v.length])),
      out,
    }));
  } else if (args.exp === 'e4' && args.grid === 'stageC' && args.top) {
    const out = args.out ?? 'cfgs/e4-stageC.json';
    const topAssembliesWithGeoms = JSON.parse(readFileSync(args.top, 'utf8'));
    const { cfgs, excluded, total } = buildE4StageCCfgs(topAssembliesWithGeoms);
    writeFileSync(out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, excluded, total, out }));
  } else if (args.exp === 'e4' && args.grid === 'e5a') {
    const out = args.out ?? 'cfgs/e4-e5a.json';
    const { cfgs, excluded, total, assemblyCount } = buildE5aCfgs();
    writeFileSync(out, JSON.stringify(cfgs) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: cfgs.length, excluded, total, assemblyCount, out }));
  } else {
    console.error('usage: node src/sweep.js --exp e1 --grid pilot|stageA|stageB|cradle --out <path.json> [--geometries <path.json>]');
    console.error('       node src/sweep.js --exp e2 --grid seriesA|seriesB --out <path.json>');
    console.error('       node src/sweep.js --exp e2 --grid divergence --seriesA <path.json> --out <path.json>');
    console.error('       node src/sweep.js --exp e4 --grid slice|stageA1 [--out <path.json>]');
    console.error('       node src/sweep.js --exp e4 --grid stageA2|stageB|stageC --top <path.json> [--out <path.json>]');
    console.error('       node src/sweep.js --exp e4 --grid e5a [--out <path.json>]');
    process.exit(1);
  }
}
