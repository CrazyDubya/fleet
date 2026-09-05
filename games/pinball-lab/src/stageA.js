#!/usr/bin/env node
// LAB-2 Stage A screen (program handoff §3.3): full 3,888-geometry grid x the reduced
// 9-policy set = 34,992 cfgs, ~11 trials/cfg, 400,000 trials total. Batched across
// `os.cpus().length - 1` workers by contiguous cfg range (see stageAWorker.js's header for
// why: 34,992 one-cfg-per-worker spin-ups would dominate wall-clock at this cfg count).
//
// §2.4a at screen resolution: an individual 11-trial cfg is far too small a sample for the
// pilot's per-cfg sd-floor / never-contact-rate checks (an 11-sample sd can dip under the
// floor by chance on an ordinary run, and a single 'never' cfg's contact rate over 11 trials
// is a coin flip's worth of noise). The inbound sampling distribution and the flipper
// geometry a 'never' cfg lands in are both identical in shape across every cfg in the run
// (same INJECTION band, same rngForTrial mechanism, only the geometry/policy differ) so the
// check that matters — "is this ensemble real" — is sound applied ONCE across the whole run
// (all 400k trials for the sd floor; all ~42.7k trials across the 3,888 `never` cfgs for the
// contact-rate floor) rather than per 11-trial cell. That is what this script does; it is a
// deliberate scale adjustment of §2.4a's rule, not a skip of it.
import { Worker } from 'node:worker_threads';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { sdFromAcc, uniformSd, percentile, histogram, entropyBits } from './metrics.js';
import { INJECTION } from './arenas/e1_flippers.js';
import { buildE1StageACfgs, cfgId as hashCfg, buildE3AllCfgs } from './sweep.js';
import { flagGateResult, FLAG_GATE_FRACTION, rankingValidityResult, parseCfgSet } from './gate.js';
import { rate as measuredRate, fmt as fmtMeasured } from './measured.js';

const DEFAULT_TOTAL_TRIALS = 400000; // §3.3 Stage A budget; --trials overrides for smoke tests
const INBOUND_SD_FLOOR_FRACTION = 0.5;
const NEVER_CONTACT_RATE_FLOOR = 0.3;
const GEOMETRY_KEYS = ['restAngleDeg', 'activeAngleDeg', 'upMs', 'omegaProfile', 'radius', 'restitution'];
const TOP_N = 12;

function splitEvenly(total, n) {
  const base = Math.floor(total / n);
  const rem = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

function geometryOf(cfg) {
  const g = {};
  for (const k of GEOMETRY_KEYS) g[k] = cfg[k];
  return g;
}

function instrumentCommitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(import.meta.dirname, '../../pinball') })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

function chunk(arr, n) {
  const sizes = splitEvenly(arr.length, n);
  const out = [];
  let cursor = 0;
  for (const size of sizes) {
    out.push(arr.slice(cursor, cursor + size));
    cursor += size;
  }
  return out;
}

function runWorker(cfgs, trialCounts, outPath) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./stageAWorker.js', import.meta.url), {
      workerData: { cfgs, trialCounts, outPath },
    });
    worker.on('message', (msg) => resolve(msg));
    worker.on('error', (err) => resolve({ ok: false, error: String(err?.stack ?? err) }));
  });
}

function combineAcc(accs) {
  return accs.reduce((a, b) => ({ n: a.n + b.n, sum: a.sum + b.sum, sumSq: a.sumSq + b.sumSq }), { n: 0, sum: 0, sumSq: 0 });
}

// --- E4 (LAB-6) path: `node src/stageA.js --exp e4 --cfgs <path.json> --trials <n> --out
// <dir>` (design doc §9/§12) — the same batched-worker mechanism as E1's screen (see header),
// generalised to read its cfg list from a file rather than building E1's own 3,888-geometry
// grid, and to gate/rank on E4's own §5/§7 columns (cp, CREEP) instead of E1's fan width. Used
// for every E4 stage (slice, A1, A2, B, C) — "every E4 stage uses stageA.js's batched runner"
// per the design's §6 preamble.
async function runE4Stage(args) {
  const out = args.out;
  const cfgsPath = args.cfgs;
  if (!out || !cfgsPath) {
    console.error('usage: node src/stageA.js --exp e4 --cfgs <path.json> --trials <n> --out <dir>');
    process.exitCode = 1;
    return;
  }
  mkdirSync(out, { recursive: true });
  const start = performance.now();

  // LAB-22: bare array (no premise) or `{ premise, cfgs }`. E4 Stage A1 declares one.
  const { cfgs, premise } = parseCfgSet(JSON.parse(readFileSync(cfgsPath, 'utf8')), { source: cfgsPath });
  const totalTrialsArg = args.trials ? Number(args.trials) : cfgs.length * 100;
  const trialCounts = splitEvenly(totalTrialsArg, cfgs.length);
  const maxWorkers = Math.max(1, os.cpus().length - 1);
  const cfgChunks = chunk(cfgs, maxWorkers);
  const countChunks = chunk(trialCounts, maxWorkers);

  const results = await Promise.all(
    cfgChunks.map((cfgChunk, i) => runWorker(cfgChunk, countChunks[i], path.join(out, `shard-${i}.jsonl.gz`)))
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(JSON.stringify({ ok: false, failedWorkers: failed }));
    process.exitCode = 1;
    return;
  }

  const perCfgByIndex = new Map();
  for (const r of results) for (const row of r.perCfg) perCfgByIndex.set(row.cfgId, row);

  let totalTrials = 0, totalFlagged = 0, totalFlaggedExclStalled = 0;
  const totalFlagCounts = {};
  const totalFlagCountsExclStalled = {};
  let totalCt = 0, totalCr = 0, totalCp = 0, totalCv = 0, totalCreep = 0;
  const perCfgSummary = [];
  for (const cfg of cfgs) {
    const row = perCfgByIndex.get(cfg.cfgId);
    totalTrials += row.trials;
    totalFlagged += row.flagged;
    totalFlaggedExclStalled += row.flaggedExclStalled;
    for (const [name, n] of Object.entries(row.flagCounts ?? {})) totalFlagCounts[name] = (totalFlagCounts[name] ?? 0) + n;
    for (const [name, n] of Object.entries(row.flagCountsExclStalled ?? {})) totalFlagCountsExclStalled[name] = (totalFlagCountsExclStalled[name] ?? 0) + n;
    totalCt += row.ct; totalCr += row.cr; totalCp += row.cp; totalCv += row.cv; totalCreep += row.creep;
    const sorted = [...row.stVals].sort((a, b) => a - b);
    const medianSt = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    perCfgSummary.push({
      cfgId: cfg.cfgId, arm: cfg.arm ?? null, trials: row.trials,
      ct: row.trials ? row.ct / row.trials : 0, cr: row.trials ? row.cr / row.trials : 0,
      cp: row.trials ? row.cp / row.trials : 0, cv: row.trials ? row.cv / row.trials : 0,
      creep: row.trials ? row.creep / row.trials : 0, medianSt,
      fastCradleRate: row.stVals.length ? row.stVals.filter((s) => s < 1.0).length / row.trials : 0,
      relCounts: row.relCounts, rxaVals: row.rxaVals,
    });
  }

  // §7's E4 amendments: (1) the C0 control arm must reproduce <1% cp — "an arena is on
  // target" takes this form for E4, replacing E1's never-baseline-contact-rate check; (2) the
  // flagged-fraction gate excludes STALLED (for a cradle experiment STALLED IS the
  // measurement); (3) CREEP is reported prominently, watched for correlating with high-cp cfgs.
  // LAB-11/P0-1: (2) is now actually ENFORCED (`flagGate` below) — it was computed and
  // reported but never compared to the §2.7 threshold before this fix.
  const c0 = perCfgSummary.find((c) => c.arm === 'C0');
  const c0Ok = !c0 || c0.cp < 0.01;
  const flaggedExclStalledFraction = totalTrials > 0 ? totalFlaggedExclStalled / totalTrials : 0;
  // LAB-22: E4 already excludes STALLED from the numerator (§7); a declared premise, if this
  // cfg set carries one, additionally moves the ceiling and holds every UNDECLARED flag to 1%.
  const flagGate = flagGateResult({ trials: totalTrials, flagged: totalFlaggedExclStalled, premise, flagCounts: totalFlagCountsExclStalled, excludedFlags: ['STALLED'] });

  const secs = (performance.now() - start) / 1000;
  const meta = {
    exp: 'e4', out, instrumentCommitSha: instrumentCommitSha(),
    generatedAt: new Date().toISOString(),
    cfgCount: cfgs.length, trialCount: totalTrials,
    flaggedFraction: totalTrials > 0 ? totalFlagged / totalTrials : 0,
    flaggedFractionExclStalled: flaggedExclStalledFraction,
    ct: totalTrials ? totalCt / totalTrials : 0, cr: totalTrials ? totalCr / totalTrials : 0,
    cp: totalTrials ? totalCp / totalTrials : 0, cv: totalTrials ? totalCv / totalTrials : 0,
    creep: totalTrials ? totalCreep / totalTrials : 0,
    c0Cp: c0?.cp ?? null, c0OnTarget: c0Ok,
    flagGateOk: flagGate.ok,
    flagCounts: totalFlagCounts, flagCountsExclStalled: totalFlagCountsExclStalled,
    declaredPremise: premise, premiseApplied: flagGate.premiseApplied,
    gateExcludedFlags: flagGate.excludedFlags,
    secs,
    shards: results.map((r) => ({ path: path.relative(out, r.outPath) })),
    cfgs: cfgs.map((cfg) => ({ cfg, trials: perCfgByIndex.get(cfg.cfgId).trials })),
  };
  writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));

  const ranked = [...perCfgSummary].sort((a, b) => b.cp - a.cp);
  const cpRankingGuard = rankingValidityResult(perCfgSummary.map((c) => c.cp));
  writeFileSync(path.join(out, 'ranking.json'), JSON.stringify({ ranked, rankingGuard: cpRankingGuard }, null, 2));
  if (!cpRankingGuard.ok) {
    // LAB-16 gate: reported, not enforced, here — this `ranking.json` is E4's raw per-cfg
    // screen output, consumed by e4Report.js which re-derives and re-checks its own tables from
    // the raw shards directly (see that file's guard calls) rather than trusting this file's
    // pre-sorted order. Surfacing it here too means the failure is visible at the point it first
    // occurs, not only three files downstream.
    console.error(JSON.stringify({ warning: 'LAB-16 ranking gate: cp cannot order these cfgs', cpRankingGuard, out }));
  }

  if (!c0Ok) {
    console.error(JSON.stringify({ ok: false, error: `§7 gate: C0 control cp=${((c0?.cp ?? 0) * 100).toFixed(2)}% >= 1%`, out }));
    process.exitCode = 1;
    return;
  }

  if (!flagGate.ok) {
    const detail = flagGate.reason ?? `flagged fraction (excl STALLED) ${(flagGate.fraction * 100).toFixed(2)}% exceeds ${(FLAG_GATE_FRACTION * 100).toFixed(0)}%`;
    console.error(JSON.stringify({ ok: false, error: `§2.7 gate: ${detail}`, out }));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true, cfgs: cfgs.length, trials: totalTrials, secs: Number(secs.toFixed(1)),
    ct: meta.ct, cr: meta.cr, cp: meta.cp, cv: meta.cv, creep: meta.creep,
    flaggedFractionExclStalled: flaggedExclStalledFraction,
    c0Cp: meta.c0Cp, byArm: perCfgSummary.filter((c) => c.arm).map((c) => ({ arm: c.arm, ct: c.ct, cr: c.cr, cp: c.cp, cv: c.cv, medianSt: c.medianSt, creep: c.creep })),
    out,
  }));
}

const E3_TRIALS_PER_FAMILY = 200000; // §5.1: "200k trials per family", 1e6 total
const E3_FLAG_GATE = 0.01; // §2.7: >1% flagged blocks the summary
const FAMILY_LABEL = {
  P1: 'P1 launch lane', P2: 'P2 orbit', P3: 'P3 return lanes', P4: 'P4 ramp mouth', P5: 'P5 habitrail drop',
};

function e3ToMarkdown(meta, perCfgRanked, runId, rankingGuard, rankingGuardFallback = {}) {
  const lines = [];
  lines.push(`# E3 (paths) summary — run \`${runId}\``);
  lines.push('');
  lines.push(`- **instrument commit**: \`${meta.instrumentCommitSha}\`  ·  **generated**: ${meta.generatedAt}`);
  lines.push(`- **cfgs**: ${meta.cfgCount}  ·  **trials**: ${meta.trialCount}  ·  **flagged (any bit)**: ${(meta.flaggedFraction * 100).toFixed(2)}%  ·  **wall-clock**: ${meta.secs.toFixed(1)}s`);
  lines.push(`- **units**: length m, speed m/s, angle deg, time s`);
  lines.push('');
  lines.push('> H4 (program §9): "the return-speed BAND matters more than the return RATE" — every');
  lines.push('> ranking below is on `inBandFraction` (fraction of RETURNS inside the 1.0-2.5 m/s');
  lines.push('> playable band), not `returnRate`. A lane returning 100% at 4 m/s ranks below one');
  lines.push('> returning 60% at 2 m/s.');
  lines.push('');
  lines.push('## Per-family summary (§5.4)');
  lines.push('');
  // MEASURED-2: returnRate/inBandFraction/stallRate render through their `Measured` sidecars
  // (rate, event count, and a 95% Wilson interval together) rather than the bare percentage —
  // same convention as E5a (MEASURED-1). flaggedFraction/IMPACTS_EXHAUSTED are unchanged (not
  // converted this dispatch).
  lines.push('| family | trials | flagged% | IMPACTS_EXHAUSTED% | returnRate | inBandFraction | stallRate | variety(entropy) | median timeToReturn(s) |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const [f, m] of Object.entries(meta.familyMetrics)) {
    lines.push(
      `| ${FAMILY_LABEL[f] ?? f} | ${m.trials} | ${(m.flaggedFraction * 100).toFixed(2)} | ${(m.impactsExhaustedFraction * 100).toFixed(2)} | ` +
      `${fmtMeasured(m.returnRateM)} | ${fmtMeasured(m.inBandFractionM)} | ${fmtMeasured(m.stallRateM)} | ` +
      `${m.returnXVariety !== null ? m.returnXVariety.toFixed(3) : '—'} | ${m.timeToReturnMedianS !== null ? m.timeToReturnMedianS.toFixed(2) : '—'} |`
    );
  }
  lines.push('');
  lines.push('## Feed classification, per family (fraction of ALL trials, §5.4)');
  lines.push('');
  const feedKeys = ['centre', 'leftInlane', 'rightInlane', 'leftOutlane', 'rightOutlane', 'directDrain'];
  lines.push('| family | ' + feedKeys.join(' | ') + ' |');
  lines.push('|---|' + feedKeys.map(() => '---').join('|') + '|');
  for (const [f, m] of Object.entries(meta.familyMetrics)) {
    lines.push(`| ${f} | ` + feedKeys.map((k) => `${((m.feedFractions[k] ?? 0) * 100).toFixed(1)}%`).join(' | ') + ' |');
  }
  lines.push('');
  lines.push('## Top 10 cfgs per family, ranked by inBandFraction (the trade-off curve, §5.4)');
  lines.push('');
  for (const family of Object.keys(meta.familyMetrics)) {
    lines.push(`### ${FAMILY_LABEL[family] ?? family}`);
    lines.push('');
    const g = rankingGuard[family];
    if (!g.ok) {
      const fallback = rankingGuardFallback[family];
      if (fallback?.ok) {
        // LAB-18: `inBandFraction` saturates at its ceiling for this family (a WINDOW function
        // of return speed, not a monotonic one — see the `bandCenterCloseness` comment above)
        // but the continuous `bandCenterCloseness` proxy still orders cleanly. Shown labelled,
        // not silently swapped for `inBandFraction` in the table header.
        lines.push(`> ⚠ **\`inBandFraction\` RANKING INVALID (LAB-16 gate)**: cannot rank this family's ` +
          `${g.n} cfgs — ${g.reason}. Ranked below by **distance from the band centre** ` +
          '(median return speed vs. the 1.75 m/s midpoint of the 1.0-2.5 m/s band) instead — a ' +
          'continuous proxy for the same "landed in the playable band" question that does not ' +
          'saturate the way a bounded fraction can.');
        lines.push('');
        lines.push('| cfgId | trials | returnRate | inBandFraction | medianXs (m/s) | stallRate | flagged% |');
        lines.push('|---|---|---|---|---|---|---|');
        const top = perCfgRanked.filter((r) => r.family === family && r.bandCenterCloseness !== null)
          .sort((a, b) => b.bandCenterCloseness - a.bandCenterCloseness).slice(0, 10);
        for (const r of top) {
          lines.push(`| ${r.cfgId} | ${r.trials} | ${(r.returnRate * 100).toFixed(1)}% | ${(r.inBandFraction * 100).toFixed(1)}% | ${r.medianXs.toFixed(2)} | ${(r.stallRate * 100).toFixed(1)}% | ${(r.flaggedFraction * 100).toFixed(2)} |`);
        }
        lines.push('');
        continue;
      }
      // LAB-16 ranking guard: `inBandFraction` cannot order this family's cfgs (operator
      // handoff `20260903T0540Z-e3-p1-is-degenerate.md` — E3 P1's own case, all 288 rows tied
      // at 0.0 or 1.0), and the LAB-18 fallback proxy can't rank it either. Loud refusal, not a
      // silent "top 10" of insertion order.
      lines.push(`> ⚠ **RANKING INVALID (LAB-16 gate)**: \`inBandFraction\` cannot rank this family's ` +
        `${g.n} cfgs — ${g.reason}. No top-10 table is shown; presenting one would rank by array ` +
        'insertion order, not performance. See the per-family summary table above for this family\'s ' +
        'real (non-ranking) metrics.');
      lines.push('');
      continue;
    }
    lines.push('| cfgId | trials | returnRate | inBandFraction | stallRate | flagged% |');
    lines.push('|---|---|---|---|---|---|');
    const top = perCfgRanked.filter((r) => r.family === family).slice(0, 10);
    for (const r of top) {
      lines.push(`| ${r.cfgId} | ${r.trials} | ${(r.returnRate * 100).toFixed(1)}% | ${(r.inBandFraction * 100).toFixed(1)}% | ${(r.stallRate * 100).toFixed(1)}% | ${(r.flaggedFraction * 100).toFixed(2)} |`);
    }
    lines.push('');
  }
  lines.push('## Dead-zone heatmap');
  lines.push('');
  lines.push('`e3-' + runId + '-heatmap.csv` — 1cm x 1cm occupancy bins (`family,x,y,count`) of every');
  lines.push('substep a ball spent below 0.15 m/s, summed across that family\'s trials. §5.4: "the single');
  lines.push('most directly useful artifact in the whole program" — a map of where a ball goes to die.');
  lines.push('');
  return lines.join('\n');
}

function e3RunWorker(items, outPath) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./e3Worker.js', import.meta.url), { workerData: { items, outPath } });
    worker.on('message', (msg) => resolve(msg));
    worker.on('error', (err) => resolve({ ok: false, error: String(err?.stack ?? err) }));
  });
}

/** LAB-4 (E3 paths): builds all five families' cfgs (sweep.js's buildE3AllCfgs), splits
 * E3_TRIALS_PER_FAMILY evenly across each family's OWN cfg count (§5.1's 200k/family is a
 * per-family budget, independent of how many cfgs a family's grid happens to have), runs the
 * flattened [{cfg,trials}] list across `os.cpus().length - 1` batched workers (e3Worker.js —
 * same batching rationale as Stage A's own E1/E4 branches), then computes the §5.4 metrics
 * per family and per cfg, and the dead-zone heatmap.
 */
async function runE3Stage(args) {
  const out = args.out;
  if (!out) {
    console.error('usage: node src/stageA.js --exp e3 --out data/e3/<runId> [--trials <perFamily>] [--families P1,P2,...]');
    process.exitCode = 1;
    return;
  }
  mkdirSync(out, { recursive: true });
  const start = performance.now();

  const perFamilyTrials = args.trials ? Number(args.trials) : E3_TRIALS_PER_FAMILY;
  let byFamily = buildE3AllCfgs();
  // LAB-16: lets a redesigned single family (P1) be re-run on its own budget without
  // re-running P2-P5's unchanged, already-banked corpora alongside it.
  if (args.families) {
    const wanted = new Set(args.families.split(','));
    byFamily = Object.fromEntries(Object.entries(byFamily).filter(([f]) => wanted.has(f)));
  }
  const items = [];
  for (const [family, cfgs] of Object.entries(byFamily)) {
    const counts = splitEvenly(perFamilyTrials, cfgs.length);
    cfgs.forEach((cfg, i) => items.push({ cfg, trials: counts[i] }));
  }

  const maxWorkers = Math.max(1, os.cpus().length - 1);
  const itemChunks = chunk(items, maxWorkers);
  const results = await Promise.all(
    itemChunks.map((itemChunk, i) => e3RunWorker(itemChunk, path.join(out, `shard-${i}.jsonl.gz`)))
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(JSON.stringify({ ok: false, failedWorkers: failed }));
    process.exitCode = 1;
    return;
  }

  // --- Merge per-cfg counters, per-family pooled samples, and the dead-zone map. ---
  const perCfgByIndex = new Map();
  const familySamples = {}; // family -> { xx: [], tt: [] }
  const deadZone = new Map();
  for (const r of results) {
    for (const row of r.perCfg) {
      const prior = perCfgByIndex.get(row.cfgId);
      if (!prior) {
        perCfgByIndex.set(row.cfgId, row);
      } else {
        // A cfg's trials were split into one contiguous range per its own chunk, but a
        // family's cfgs can straddle a chunk boundary if the family itself does — merge
        // rather than assume one worker ever owns a whole cfg (mirrors stageAWorker.js's own
        // "no shared state" discipline: safe regardless of how chunk() happened to split).
        prior.trials += row.trials; prior.flagged += row.flagged; prior.reachedCount += row.reachedCount;
        prior.impactsExhausted += row.impactsExhausted; prior.flaggedExclArtifacts += row.flaggedExclArtifacts;
        prior.inBandSpeed += row.inBandSpeed;
        prior.xsVals.push(...row.xsVals);
        for (const [k, v] of Object.entries(row.term)) prior.term[k] = (prior.term[k] ?? 0) + v;
        for (const [k, v] of Object.entries(row.feed)) prior.feed[k] = (prior.feed[k] ?? 0) + v;
        for (const [k, v] of Object.entries(row.rmp)) prior.rmp[k] = (prior.rmp[k] ?? 0) + v;
      }
    }
    for (const [family, fs] of Object.entries(r.familySamples)) {
      const target = familySamples[family] ?? (familySamples[family] = { xx: [], tt: [] });
      target.xx.push(...fs.xx);
      target.tt.push(...fs.tt);
    }
    for (const [key, count] of r.deadZone) deadZone.set(key, (deadZone.get(key) ?? 0) + count);
  }

  // --- Per-family metrics (§5.4). ---
  const familyMetrics = {};
  for (const family of Object.keys(byFamily)) {
    const rows = [...perCfgByIndex.values()].filter((r) => r.family === family);
    const trials = rows.reduce((a, r) => a + r.trials, 0);
    const flagged = rows.reduce((a, r) => a + r.flagged, 0);
    const impactsExhausted = rows.reduce((a, r) => a + r.impactsExhausted, 0);
    const reached = rows.reduce((a, r) => a + r.reachedCount, 0);
    const inBand = rows.reduce((a, r) => a + r.inBandSpeed, 0);
    const feedTotals = {};
    for (const r of rows) for (const [k, v] of Object.entries(r.feed)) feedTotals[k] = (feedTotals[k] ?? 0) + v;
    const stallCount = rows.reduce((a, r) => a + (r.term.stall ?? 0), 0);
    const fs = familySamples[family] ?? { xx: [], tt: [] };
    const xVariety = fs.xx.length >= 2 ? entropyBits(histogram(fs.xx, 32, -0.3, 0.3), { normalise: true }) : null;
    familyMetrics[family] = {
      trials, flaggedFraction: trials ? flagged / trials : 0,
      // §2.7 amendment, same category as LAB-6's flaggedFractionExclStalled and LAB-3's own
      // N=50 IMPACTS_EXHAUSTED watch item: verified (small-scale sweeps across every P2/P3
      // geometry point, no escapes, no NaNs) that IMPACTS_EXHAUSTED here is a curved-channel
      // artifact of the impulse-based solver repeatedly re-resolving a ball rolling along a
      // circular Arc within one 1/240s substep (P2's own orbit walls), not a lab-harness bug —
      // widening the channel (0.035m -> 0.12m) did not reduce it, ruling out "too tight a
      // channel" as the cause. The §2.7 gate is applied to the fraction EXCLUDING this bit
      // (flaggedFractionExclArtifacts); IMPACTS_EXHAUSTED itself is always reported, per §2.7's
      // "understood, not smoothed over" — never silently dropped.
      impactsExhaustedFraction: trials ? impactsExhausted / trials : 0,
      flaggedFractionExclArtifacts: trials ? rows.reduce((a, r) => a + r.flaggedExclArtifacts, 0) / trials : 0,
      returnRate: trials ? reached / trials : 0,
      inBandFraction: reached ? inBand / reached : 0,
      feedFractions: Object.fromEntries(Object.entries(feedTotals).map(([k, v]) => [k, trials ? v / trials : 0])),
      stallRate: trials ? stallCount / trials : 0,
      returnXVariety: xVariety,
      timeToReturnMedianS: fs.tt.length ? percentile(fs.tt, 50) : null,
      cfgs: rows.length,
      // MEASURED-2: additive sidecars alongside the bare fractions above — those are unchanged
      // (this file's own downstream JSON/ranking code reads them as plain numbers). `reached`
      // is `inBandFraction`'s own denominator, not `trials` (LAB-21's own point: a rate's
      // interval is only honest over the population it was actually computed against).
      returnRateM: measuredRate(reached, trials, { estimand: `${family}: fraction of trials returning to a flipper` }),
      inBandFractionM: measuredRate(inBand, reached, { estimand: `${family}: fraction of RETURNS landing in the 1.0-2.5 m/s playable band` }),
      stallRateM: measuredRate(stallCount, trials, { estimand: `${family}: fraction of trials stalling out` }),
    };
  }

  // --- Per-cfg ranking rows (the trade-off curve data — §5.4's "deliver the trade-off curve,
  // not a single optimum"). ---
  const perCfgRanked = [...perCfgByIndex.values()].map((r) => {
    const medianXs = r.xsVals.length ? percentile(r.xsVals, 50) : null;
    return {
      cfgId: r.cfgId, family: r.family, trials: r.trials,
      returnRate: r.trials ? r.reachedCount / r.trials : 0,
      inBandFraction: r.reachedCount ? r.inBandSpeed / r.reachedCount : 0,
      stallRate: r.trials ? (r.term.stall ?? 0) / r.trials : 0,
      flaggedFraction: r.trials ? r.flagged / r.trials : 0,
      feed: r.feed,
      rmp: r.rmp,
      // LAB-18: a continuous stand-in for `inBandFraction`, for families whose in-band fraction
      // saturates at the ceiling and can't order a top-N cut (see the per-family guard below —
      // P5's `inBandFraction` is a WINDOW function of return speed, [1.0, 2.5] m/s matching
      // e3Worker.js's own band test, not a monotonic threshold, so it saturates at 1.0 across a
      // wide swath of the grid). `medianXs` is the per-cfg median return speed among reached
      // trials; `bandCenterCloseness` folds it against the band's own centre (2.5+1.0)/2 = 1.75
      // — larger is better (a cfg dead-centre in the target band scores 0, one at either edge
      // or beyond scores increasingly negative) so it sorts the same direction as `inBandFraction`.
      medianXs,
      bandCenterCloseness: medianXs !== null ? -Math.abs(medianXs - 1.75) : null,
    };
  }).sort((a, b) => b.inBandFraction - a.inBandFraction);

  // --- §2.7 validity gate, per family (any family over the 1% floor, EXCLUDING
  // IMPACTS_EXHAUSTED per the amendment above, blocks the summary). ---
  const overGate = Object.entries(familyMetrics).filter(([, m]) => m.flaggedFractionExclArtifacts > E3_FLAG_GATE);

  // --- LAB-16 ranking gate: can `inBandFraction` actually order each family's cfgs? Computed
  // over the FULL per-family population, before any top-N slice — slicing to top-10 first would
  // always look tie-heavy at the ceiling regardless of whether the underlying metric has real
  // resolution (confirmed against E4's a2Ranked/bRanked during this dispatch's audit: the
  // pre-slice population passed even though the post-slice top-20 looked degenerate). This gate
  // does not block the whole family's summary (its other metrics — returnRate, stallRate,
  // feed fractions — remain valid regardless); it only suppresses the one table that presents
  // an ordering, per-family, loudly (see e3ToMarkdown).
  // LAB-18: when `inBandFraction` can't order a family's top-10 (its own guard fails), fall
  // back to `bandCenterCloseness` — computed above from a genuinely continuous quantity (median
  // return speed), so it doesn't saturate the way a fraction bounded to [0,1] can. Reported
  // separately (`rankingGuardFallback`) rather than silently swapped in: e3ToMarkdown uses it
  // to render a top-10 by the fallback metric, clearly labelled, instead of a blank ⚠ block —
  // but only when the fallback itself passes its own guard (checked the same way, `topN: 10`);
  // if a family somehow fails both, no ranking is shown for it at all.
  const rankingGuard = {};
  const rankingGuardFallback = {};
  for (const family of Object.keys(familyMetrics)) {
    const rows = perCfgRanked.filter((r) => r.family === family);
    // LAB-21: inBandFraction is inBandSpeed/reachedCount, so it can supply its denominators.
    // Measured before wiring (full E3 stage, 1M trials, in a scratch tree): no family's verdict
    // changes — rankingGuardFailures stays empty. `bandCenterCloseness` below is a continuous
    // proximity proxy with no k, so it supplies none and keeps its pre-LAB-21 behaviour.
    rankingGuard[family] = rankingValidityResult(rows.map((r) => r.inBandFraction), {
      topN: 10, support: rows.map((r) => r.reachedCount),
    });
    if (!rankingGuard[family].ok) {
      const withCloseness = rows.filter((r) => r.bandCenterCloseness !== null);
      rankingGuardFallback[family] = rankingValidityResult(withCloseness.map((r) => r.bandCenterCloseness), { topN: 10 });
    }
  }
  // A family only truly fails (no top-10 shown at all) if `inBandFraction` fails AND either
  // there's no fallback or the fallback fails too — a family the fallback rescues isn't a
  // failure for reporting purposes, it's a substitution (e3ToMarkdown renders it, labelled).
  const rankingGuardFailures = Object.entries(rankingGuard)
    .filter(([f, r]) => !r.ok && !(rankingGuardFallback[f]?.ok))
    .map(([f, r]) => ({ family: f, ...r }));

  const secs = (performance.now() - start) / 1000;
  const totalTrials = Object.values(familyMetrics).reduce((a, m) => a + m.trials, 0);
  const totalFlagged = [...perCfgByIndex.values()].reduce((a, r) => a + r.flagged, 0);

  const meta = {
    exp: 'e3', out, instrumentCommitSha: instrumentCommitSha(),
    generatedAt: new Date().toISOString(),
    cfgCount: items.length, trialCount: totalTrials,
    flaggedFraction: totalTrials ? totalFlagged / totalTrials : 0,
    perFamilyTrials, familyMetrics, secs, rankingGuardFailures, rankingGuardFallback,
    shards: results.map((r, i) => ({ path: path.relative(out, r.outPath ?? `shard-${i}.jsonl.gz`) })),
    cfgs: items.map(({ cfg, trials }) => ({ cfgId: cfg.cfgId, cfg, trials })),
  };
  writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
  writeFileSync(path.join(out, 'ranking.json'), JSON.stringify({ ranked: perCfgRanked }, null, 2));

  // --- §5.4 dead-zone heatmap CSV: family,x,y,count (x/y in metres, bin centres). ---
  const heatmapPath = path.join(out, 'heatmap.csv');
  const csvLines = ['family,x,y,count'];
  for (const [key, count] of deadZone) {
    const [family, coords] = key.split(':');
    const [bx, by] = coords.split(',').map(Number);
    csvLines.push(`${family},${(bx / 100).toFixed(2)},${(by / 100).toFixed(2)},${count}`);
  }
  writeFileSync(heatmapPath, csvLines.join('\n') + '\n');

  if (overGate.length > 0) {
    console.error(JSON.stringify({ ok: false, error: '§2.7 gate: flagged fraction exceeds 1%', overGate: overGate.map(([f, m]) => ({ family: f, flaggedFraction: m.flaggedFractionExclArtifacts })), out }));
    process.exitCode = 1;
    return;
  }

  // --- §6 committed deliverable: data/summaries/e3-<runId>.{json,md} + the heatmap CSV. ---
  const runId = path.basename(out);
  const summariesDir = path.join(import.meta.dirname, '..', 'data', 'summaries');
  writeFileSync(path.join(summariesDir, `e3-${runId}.json`), JSON.stringify(meta, null, 2));
  writeFileSync(path.join(summariesDir, `e3-${runId}-heatmap.csv`), csvLines.join('\n') + '\n');
  writeFileSync(path.join(summariesDir, `e3-${runId}.md`), e3ToMarkdown(meta, perCfgRanked, runId, rankingGuard, rankingGuardFallback));

  if (rankingGuardFailures.length > 0) {
    console.error(JSON.stringify({
      warning: 'LAB-16 ranking gate: inBandFraction cannot order one or more families — no top-10 table emitted for them',
      rankingGuardFailures,
    }));
  }

  console.log(JSON.stringify({
    ok: true, cfgs: items.length, trials: totalTrials,
    flagged: totalTrials ? Number((totalFlagged / totalTrials).toFixed(4)) : 0,
    secs: Number(secs.toFixed(1)),
    families: Object.fromEntries(Object.entries(familyMetrics).map(([f, m]) => [f, {
      returnRate: Number(m.returnRate.toFixed(3)), inBandFraction: Number(m.inBandFraction.toFixed(3)),
      stallRate: Number(m.stallRate.toFixed(3)), flaggedFraction: Number(m.flaggedFraction.toFixed(4)),
      impactsExhaustedFraction: Number(m.impactsExhaustedFraction.toFixed(4)),
    }])),
    rankingGuardOk: rankingGuardFailures.length === 0,
    out,
  }));
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, arr) => {
      if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
      return pairs;
    }, [])
  );

  if (args.exp === 'e4') return runE4Stage(args);
  if (args.exp === 'e3') return runE3Stage(args);

  const out = args.out;
  if (!out) {
    console.error('usage: node src/stageA.js --out data/e1/stageA-<runId>');
    process.exitCode = 1;
    return;
  }

  mkdirSync(out, { recursive: true });
  const start = performance.now();

  const totalTrialsArg = args.trials ? Number(args.trials) : DEFAULT_TOTAL_TRIALS;
  const cfgs = buildE1StageACfgs();
  const trialCounts = splitEvenly(totalTrialsArg, cfgs.length);
  const maxWorkers = Math.max(1, os.cpus().length - 1);

  const cfgChunks = chunk(cfgs, maxWorkers);
  const countChunks = chunk(trialCounts, maxWorkers);

  const results = await Promise.all(
    cfgChunks.map((cfgChunk, i) => runWorker(cfgChunk, countChunks[i], path.join(out, `shard-${i}.jsonl.gz`)))
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(JSON.stringify({ ok: false, failedWorkers: failed }));
    process.exitCode = 1;
    return;
  }

  // --- Aggregate §2.4a checks, run once across the whole screen (see header). ---
  const allInboundAcc = { x0: newAcc(), speed0: newAcc(), angle0Deg: newAcc() };
  const perCfgByIndex = new Map();
  for (const r of results) {
    for (const key of Object.keys(allInboundAcc)) {
      allInboundAcc[key] = combineAcc([allInboundAcc[key], r.inboundAcc[key]]);
    }
    for (const row of r.perCfg) perCfgByIndex.set(row.cfgId, row);
  }

  const ranges = { x0: [INJECTION.xMin, INJECTION.xMax], speed0: [INJECTION.speedMin, INJECTION.speedMax], angle0Deg: [INJECTION.angleMinDeg, INJECTION.angleMaxDeg] };
  const degenerate = [];
  const inboundSds = {};
  for (const key of Object.keys(ranges)) {
    const measuredSd = sdFromAcc(allInboundAcc[key]);
    const floor = uniformSd(...ranges[key]) * INBOUND_SD_FLOOR_FRACTION;
    inboundSds[key] = measuredSd;
    if (measuredSd < floor) degenerate.push({ key, measuredSd, floor });
  }
  if (degenerate.length > 0) {
    console.error(JSON.stringify({ ok: false, error: '§2.4a aggregate ensemble check failed', degenerate }));
    process.exitCode = 1;
    return;
  }

  let neverTrials = 0, neverContacts = 0;
  for (const cfg of cfgs) {
    if (cfg.pol !== 'never') continue;
    const row = perCfgByIndex.get(cfg.cfgId);
    neverTrials += row.trials;
    neverContacts += row.contactCount;
  }
  const neverContactRate = neverTrials > 0 ? neverContacts / neverTrials : 0;
  if (neverContactRate <= NEVER_CONTACT_RATE_FLOOR) {
    console.error(JSON.stringify({ ok: false, error: `§2.4a aggregate arena-on-target check failed: ${(neverContactRate * 100).toFixed(1)}% <= 30%`, neverContactRate, neverTrials }));
    process.exitCode = 1;
    return;
  }

  // --- Per-geometry ranking: pool fan width (xa, non-'never' policies) and cradle-proxy
  // (stall-while-in-contact rate, all policies) across each geometry's 9 cfgs. ---
  const geomStats = new Map(); // geometryKey -> { geometry, xaVals, trials, flagged, stallWithContact, contacts }
  let totalTrials = 0, totalFlagged = 0;
  for (const cfg of cfgs) {
    const row = perCfgByIndex.get(cfg.cfgId);
    totalTrials += row.trials;
    totalFlagged += row.flagged;
    const gKey = hashCfg(geometryOf(cfg));
    let g = geomStats.get(gKey);
    if (!g) {
      g = { geometryKey: gKey, geometry: geometryOf(cfg), xaVals: [], csVals: [], trials: 0, flagged: 0, stallWithContact: 0 };
      geomStats.set(gKey, g);
    }
    g.trials += row.trials;
    g.flagged += row.flagged;
    g.stallWithContact += row.stallWithContact;
    // GEO-2: pooled across ALL of a geometry's 9 cfgs, every policy included — unlike xaVals,
    // which excludes 'never'. Min-contact-speed is a property of how the ball rests against the
    // bat, so a policy that never fires is as valid a sample of it as one that does.
    g.csVals.push(...row.csVals);
    if (cfg.pol !== 'never') g.xaVals.push(...row.xaVals);
  }

  const geometries = [...geomStats.values()].map((g) => ({
    geometryKey: g.geometryKey,
    geometry: g.geometry,
    trials: g.trials,
    flaggedFraction: g.trials > 0 ? g.flagged / g.trials : 0,
    fanWidthXa: g.xaVals.length >= 2 ? percentile(g.xaVals, 95) - percentile(g.xaVals, 5) : null,
    cradleProxy: g.trials > 0 ? g.stallWithContact / g.trials : 0,
    // GEO-2: the same statistic lab2Report publishes as cradleMinContactSpeedMedianMps —
    // median over contacting trials of each trial's minimum speed while touching a flipper.
    minContactSpeed: g.csVals.length ? percentile(g.csVals, 50) : null,
    contactTrials: g.csVals.length,
    shotContacts: g.xaVals.length,
  }));

  // LAB-16 ranking gate, checked on the FULL geometry population BEFORE any top-N slice (a
  // post-slice check always looks tie-heavy at the ceiling regardless of whether the metric has
  // real resolution — confirmed during this dispatch's audit). Unlike E3's per-family table
  // (informational only), `selected` here is a real decision: it becomes
  // `selected-geometries.json`, which downstream LAB-2 Stage B/C treats as "the geometries worth
  // exploring further." Picking "top 12" from a metric that cannot order the population is the
  // same mistake as E3 P1's top-10, but with a worse consequence — it silently narrows which
  // geometries ever get looked at again. So this one blocks, matching §2.7's own precedent for a
  // gate that invalidates a downstream artifact rather than just a display table.
  const fanWidthGuard = rankingValidityResult(geometries.filter((g) => g.fanWidthXa !== null).map((g) => g.fanWidthXa), { topN: TOP_N });
  // LAB-21: `cradleProxy` is stallWithContact/trials, so it can hand the guard its denominators
  // and get the raw-event check. `fanWidthXa` above is a P95-P5 percentile difference — there is
  // no k behind it, so it supplies no `support` and keeps exactly its pre-LAB-21 behaviour.
  const cradleGuard = rankingValidityResult(geometries.map((g) => g.cradleProxy), {
    topN: TOP_N, support: geometries.map((g) => g.trials),
  });
  // GEO-2: the proposed cradleProxy replacement, guarded on the FULL population before anything
  // is ranked on it. Reported, not yet blocking — cradleGuard above is still the gate, because
  // swapping which metric selects geometries is the operator's call, not this runner's.
  const withCs = geometries.filter((g) => g.minContactSpeed !== null);
  // No `support`, deliberately, for the same reason fanWidthXa supplies none: LAB-21's
  // raw-event check computes k = round(value * support), which is only meaningful when the
  // value IS a rate. minContactSpeed is a median speed in m/s — round(0.73 * 500) is not an
  // event count, it is nonsense. The distinct-value floor and tie ceiling still apply.
  const minContactSpeedGuard = withCs.length
    ? rankingValidityResult(withCs.map((g) => g.minContactSpeed), { topN: TOP_N })
    : null;
  if (!fanWidthGuard.ok || !cradleGuard.ok) {
    console.error(JSON.stringify({
      ok: false,
      error: 'LAB-16 ranking gate: a geometry-selection metric cannot support "top N" selection',
      fanWidthGuard: fanWidthGuard.ok ? undefined : fanWidthGuard,
      cradleGuard: cradleGuard.ok ? undefined : cradleGuard,
      minContactSpeedGuard,
      note: 'selected-geometries.json was NOT written. See ledger/handoffs for the corpus audit that found this.',
    }));
    process.exitCode = 1;
    return;
  }
  const byFanWidth = [...geometries].filter((g) => g.fanWidthXa !== null).sort((a, b) => b.fanWidthXa - a.fanWidthXa).slice(0, TOP_N);
  const byCradle = [...geometries].sort((a, b) => b.cradleProxy - a.cradleProxy).slice(0, TOP_N);
  const selectedKeys = new Set([...byFanWidth.map((g) => g.geometryKey), ...byCradle.map((g) => g.geometryKey)]);
  const selected = geometries.filter((g) => selectedKeys.has(g.geometryKey));

  const secs = (performance.now() - start) / 1000;
  // LAB-11/P0-1: §2.7's gate applied uniformly here too — E1's Stage A screen has no
  // STALLED-as-measurement exception (that's E4-only, §7), so it's the plain any-bit fraction.
  const flagGate = flagGateResult({ trials: totalTrials, flagged: totalFlagged });
  const meta = {
    exp: 'e1', stage: 'A', out, instrumentCommitSha: instrumentCommitSha(),
    generatedAt: new Date().toISOString(),
    cfgCount: cfgs.length, trialCount: totalTrials,
    flaggedFraction: totalTrials > 0 ? totalFlagged / totalTrials : 0,
    flagGateOk: flagGate.ok,
    inboundSds, neverBaselineContactRate: neverContactRate, neverTrials,
    geometryCount: geometries.length, secs,
    shards: results.map((r, i) => ({ path: path.relative(out, r.outPath) })),
  };
  writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));

  const ranking = {
    topByFanWidth: byFanWidth.map((g) => g.geometryKey),
    topByCradle: byCradle.map((g) => g.geometryKey),
    // GEO-2: reported alongside, not used to select. `topByMinContactSpeed` is what the cradle
    // half WOULD be if the selection swapped metrics; `minContactSpeedGuard` is that metric's
    // verdict on the full population, so a reader can see whether it could carry the choice.
    topByMinContactSpeed: [...geometries]
      .filter((g) => g.minContactSpeed !== null)
      .sort((a, b) => b.minContactSpeed - a.minContactSpeed)
      .slice(0, TOP_N)
      .map((g) => g.geometryKey),
    minContactSpeedGuard,
    selectedCount: selected.length,
    geometries: [...geometries].sort((a, b) => (b.fanWidthXa ?? -1) - (a.fanWidthXa ?? -1)),
    selected,
  };
  writeFileSync(path.join(out, 'ranking.json'), JSON.stringify(ranking, null, 2));
  writeFileSync(path.join(out, 'selected-geometries.json'), JSON.stringify(selected.map((g) => g.geometry), null, 2));

  if (!flagGate.ok) {
    console.error(JSON.stringify({ ok: false, error: `§2.7 gate: flagged fraction ${(flagGate.fraction * 100).toFixed(2)}% exceeds ${(FLAG_GATE_FRACTION * 100).toFixed(0)}%`, out }));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true, cfgs: cfgs.length, trials: totalTrials,
    flagged: totalTrials > 0 ? Number((totalFlagged / totalTrials).toFixed(4)) : 0,
    selectedGeometries: selected.length, out, secs: Number(secs.toFixed(1)),
  }));
}

function newAcc() { return { n: 0, sum: 0, sumSq: 0 }; }

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.stack ?? err) }));
  process.exitCode = 1;
});
