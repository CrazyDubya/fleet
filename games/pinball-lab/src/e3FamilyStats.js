#!/usr/bin/env node
// SAMPLECAP-1, the additive half. E3's `returnXVariety` and `timeToReturnMedianS` were computed
// from a PREFIX of each worker's cfg slice rather than a sample of the family (see
// src/reservoir.js). Fixing the cap makes future runs right; it does nothing for the corpus
// already on disk.
//
// The shards hold every trial. The cap only bounded what the WRITER retained, not what was
// recorded — so the correct values are recoverable from any existing run without re-simulating
// anything and without regenerating any summary. This tool streams a run directory, recomputes
// both metrics over EVERY reached trial, and writes a companion file beside the original.
//
// It never opens the published summary for writing. That matters: regenerating an E3 summary
// would also pick up two instrument changes since `575fb10` (an E3 arena fix, and a change to
// how IMPACTS_EXHAUSTED is set), so the numbers would move for two reasons at once and the
// published result would stop being reproducible. A companion moves one thing.
//
//   node src/e3FamilyStats.js --run <dir> --out <runId> [--summary <published.json>]
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';
import { percentile, histogram, entropyBits } from './metrics.js';
import { indeterminate, fmt as fmtMeasured } from './measured.js';

// Identical to stageA.js's own call, so the ONLY difference between the published value and
// the corrected one is which trials went in.
export const RETURN_X_BINS = 32;
export const RETURN_X_RANGE = [-0.3, 0.3];

/** Pure: both family metrics over a complete set of reached-trial samples. */
export function familyStats(xx, tt) {
  const xs = xx.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const ts = tt.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  return {
    returnXVariety: xs.length >= 2
      ? entropyBits(histogram(xs, RETURN_X_BINS, RETURN_X_RANGE[0], RETURN_X_RANGE[1]), { normalise: true })
      : null,
    timeToReturnMedianS: ts.length ? percentile(ts, 50) : null,
    xxN: xs.length,
    ttN: ts.length,
  };
}

async function* streamShard(dir, shardPath) {
  const rl = readline.createInterface({ input: createReadStream(path.join(dir, shardPath)).pipe(createGunzip()) });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, arr) => {
      if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
      return pairs;
    }, [])
  );
  const runDir = args.run;
  const runId = args.out;
  if (!runDir || !runId) {
    console.error('usage: node src/e3FamilyStats.js --run <dir> --out <runId> [--summary <published.json>]');
    process.exitCode = 1;
    return;
  }
  const meta = JSON.parse(readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
  const published = args.summary ? JSON.parse(readFileSync(args.summary, 'utf8')).familyMetrics ?? {} : {};

  const byFamily = new Map(); // family -> { xx: [], tt: [] }
  let reached = 0, trials = 0;
  for (const shard of meta.shards) {
    for await (const r of streamShard(runDir, shard.path)) {
      trials += 1;
      if (r.term !== 'reached') continue;
      reached += 1;
      let f = byFamily.get(r.fam);
      if (!f) { f = { xx: [], tt: [] }; byFamily.set(r.fam, f); }
      f.xx.push(r.xx);
      f.tt.push(r.tt);
    }
  }
  if (byFamily.size === 0) {
    throw new Error(`e3FamilyStats: ${runDir} produced no reached trials — an empty corpus carries no statistical power and must not be summarised.`);
  }

  const families = {};
  for (const [family, s] of [...byFamily.entries()].sort()) {
    const full = familyStats(s.xx, s.tt);
    const pub = published[family] ?? {};
    // The published sample size is only recoverable when the summary recorded it; older runs
    // (every run before SAMPLECAP-1) did not, so it is stated as unknown rather than guessed.
    const publishedSampleN = pub.familySampleN ?? null;
    families[family] = {
      reachedTrials: full.xxN,
      returnXVariety: full.returnXVariety,
      timeToReturnMedianS: full.timeToReturnMedianS,
      publishedReturnXVariety: pub.returnXVariety ?? null,
      publishedTimeToReturnMedianS: pub.timeToReturnMedianS ?? null,
      publishedSampleN,
      publishedCoverage: publishedSampleN === null ? null : publishedSampleN / full.xxN,
      // Slice 1 of measured.js has no entropy or median constructor (spec §7, slice 3), so the
      // uncertainty on these two is declared absent rather than left to read as absent.
      returnXVarietyM: indeterminate(full.returnXVariety, 'entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)', { n: full.xxN, estimand: `${family}: normalised 32-bin entropy of return-x over EVERY reached trial` }),
      timeToReturnMedianSM: indeterminate(full.timeToReturnMedianS, 'median interval needs measured.js slice 3 (order-statistic interval)', { n: full.ttN, estimand: `${family}: median time to return over EVERY reached trial` }),
    };
  }

  const out = {
    exp: 'e3', kind: 'family-stats-companion', runId,
    generatedAt: new Date().toISOString(),
    sourceRunDir: runDir,
    sourceSummary: args.summary ?? null,
    // The run's own instrumentation, carried so this companion can never be mistaken for a
    // result produced under current instrumentation.
    instrumentCommitSha: meta.instrumentCommitSha ?? null,
    note: 'Additive companion to the published summary, which is UNCHANGED. Both metrics are recomputed over every reached trial in the run; the published values came from a per-worker prefix (SAMPLECAP-1). No trial was re-simulated.',
    trials, reachedTrials: reached,
    families,
  };
  writeFileSync(path.join('data/summaries', `e3-${runId}-familystats.json`), JSON.stringify(out, null, 2));

  const L = [];
  L.push(`# E3 family stats — corrected sample (companion to \`${args.summary ?? runDir}\`)`);
  L.push('');
  L.push(`- **source run**: \`${runDir}\` · **instrument commit**: \`${out.instrumentCommitSha ?? 'not recorded'}\``);
  L.push(`- **generated**: ${out.generatedAt}`);
  L.push('');
  L.push('> The published summary is **unchanged and not regenerated**. `returnXVariety` and');
  L.push('> `timeToReturnMedianS` were computed there from the first `FAMILY_SAMPLE_CAP` reached');
  L.push('> trials each worker saw — a prefix of that worker\'s contiguous cfg slice, not a sample');
  L.push('> of the family. Every trial is on disk, so the correct values are recoverable without');
  L.push('> re-simulating anything. These are those values, over **every** reached trial.');
  L.push('');
  L.push('| family | reached trials | returnXVariety (published → corrected) | timeToReturnMedianS (published → corrected) | published sample |');
  L.push('|---|---|---|---|---|');
  for (const [family, f] of Object.entries(families)) {
    const v0 = f.publishedReturnXVariety, v1 = f.returnXVariety;
    const t0 = f.publishedTimeToReturnMedianS, t1 = f.timeToReturnMedianS;
    const cov = f.publishedCoverage === null ? 'not recorded' : `${(f.publishedCoverage * 100).toFixed(1)}% of reached`;
    L.push(`| ${family} | ${f.reachedTrials.toLocaleString()} | ${v0 === null ? '—' : v0.toFixed(4)} → **${v1.toFixed(4)}** | ${t0 === null ? '—' : t0.toFixed(4)} s → **${t1.toFixed(4)} s** | ${cov} |`);
  }
  L.push('');
  L.push('## Uncertainty');
  L.push('');
  for (const [family, f] of Object.entries(families)) {
    L.push(`- **${family}** — returnXVariety ${fmtMeasured(f.returnXVarietyM)}; timeToReturnMedianS ${fmtMeasured(f.timeToReturnMedianSM)}`);
  }
  writeFileSync(path.join('data/summaries', `e3-${runId}-familystats.md`), L.join('\n') + '\n');

  console.log(JSON.stringify({ ok: true, runId, families: Object.keys(families).length, reachedTrials: reached }));
}

main();
