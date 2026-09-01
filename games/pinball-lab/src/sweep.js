// Parameter grids -> [{cfgId, ...cfg}], plus the stable cfgId hash every record/summary
// traces back to its parameters by (program handoff §2.4/§2.9). Pure — no I/O; `cfgs/*.json`
// files are written by callers (see the bottom of this file for the pilot generator, run
// once and committed) or by a future LAB-2 script for the full Stage A/B grids.
import { createHash } from 'node:crypto';

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

/** Attach a stable cfgId to every cfg in a list produced by expandGrid (or hand-built). */
export function withCfgIds(cfgs) {
  return cfgs.map((cfg) => ({ cfgId: cfgId(cfg), ...cfg }));
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
  return withCfgIds(PILOT_POLICIES.map((p) => ({ ...PILOT_GEOMETRY, ...p })));
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
  return withCfgIds(cfgs);
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
  return withCfgIds(cfgs);
}

/** §3.5 cradle family cfgs: one per selected geometry, `pol: 'heldActive'`, `cradle: true`. */
export function buildE1CradleCfgs(geometries) {
  return withCfgIds(geometries.map((g) => ({ exp: 'e1', ...g, pol: 'heldActive', cradle: true })));
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
  } else {
    console.error('usage: node src/sweep.js --exp e1 --grid pilot|stageA|stageB|cradle --out <path.json> [--geometries <path.json>]');
    process.exit(1);
  }
}
