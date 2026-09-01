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

// `node src/sweep.js --exp e1 --grid pilot --out cfgs/e1-pilot.json` — writes the committed
// cfg file the CLI contract (§2.9) expects `runner.js --cfgs <path>` to read. Run once; the
// output is deterministic (cfgId is a pure hash), so re-running only matters if PILOT_* above
// changes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync } = await import('node:fs');
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, arr) => {
      if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
      return pairs;
    }, [])
  );
  if (args.exp === 'e1' && args.grid === 'pilot' && args.out) {
    writeFileSync(args.out, JSON.stringify(buildE1PilotCfgs(), null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, cfgs: buildE1PilotCfgs().length, out: args.out }));
  } else {
    console.error('usage: node src/sweep.js --exp e1 --grid pilot --out <path.json>');
    process.exit(1);
  }
}
