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
import { sdFromAcc, uniformSd, percentile } from './metrics.js';
import { INJECTION } from './arenas/e1_flippers.js';
import { buildE1StageACfgs, cfgId as hashCfg } from './sweep.js';

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

  const cfgs = JSON.parse(readFileSync(cfgsPath, 'utf8'));
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
  let totalCt = 0, totalCr = 0, totalCp = 0, totalCv = 0, totalCreep = 0;
  const perCfgSummary = [];
  for (const cfg of cfgs) {
    const row = perCfgByIndex.get(cfg.cfgId);
    totalTrials += row.trials;
    totalFlagged += row.flagged;
    totalFlaggedExclStalled += row.flaggedExclStalled;
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
  const c0 = perCfgSummary.find((c) => c.arm === 'C0');
  const c0Ok = !c0 || c0.cp < 0.01;
  const flaggedExclStalledFraction = totalTrials > 0 ? totalFlaggedExclStalled / totalTrials : 0;

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
    secs,
    shards: results.map((r) => ({ path: path.relative(out, r.outPath) })),
    cfgs: cfgs.map((cfg) => ({ cfg, trials: perCfgByIndex.get(cfg.cfgId).trials })),
  };
  writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));

  const ranked = [...perCfgSummary].sort((a, b) => b.cp - a.cp);
  writeFileSync(path.join(out, 'ranking.json'), JSON.stringify({ ranked }, null, 2));

  if (!c0Ok) {
    console.error(JSON.stringify({ ok: false, error: `§7 gate: C0 control cp=${((c0?.cp ?? 0) * 100).toFixed(2)}% >= 1%`, out }));
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

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, arr) => {
      if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
      return pairs;
    }, [])
  );

  if (args.exp === 'e4') return runE4Stage(args);

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
      g = { geometryKey: gKey, geometry: geometryOf(cfg), xaVals: [], trials: 0, flagged: 0, stallWithContact: 0 };
      geomStats.set(gKey, g);
    }
    g.trials += row.trials;
    g.flagged += row.flagged;
    g.stallWithContact += row.stallWithContact;
    if (cfg.pol !== 'never') g.xaVals.push(...row.xaVals);
  }

  const geometries = [...geomStats.values()].map((g) => ({
    geometryKey: g.geometryKey,
    geometry: g.geometry,
    trials: g.trials,
    flaggedFraction: g.trials > 0 ? g.flagged / g.trials : 0,
    fanWidthXa: g.xaVals.length >= 2 ? percentile(g.xaVals, 95) - percentile(g.xaVals, 5) : null,
    cradleProxy: g.trials > 0 ? g.stallWithContact / g.trials : 0,
    shotContacts: g.xaVals.length,
  }));

  const byFanWidth = [...geometries].filter((g) => g.fanWidthXa !== null).sort((a, b) => b.fanWidthXa - a.fanWidthXa).slice(0, TOP_N);
  const byCradle = [...geometries].sort((a, b) => b.cradleProxy - a.cradleProxy).slice(0, TOP_N);
  const selectedKeys = new Set([...byFanWidth.map((g) => g.geometryKey), ...byCradle.map((g) => g.geometryKey)]);
  const selected = geometries.filter((g) => selectedKeys.has(g.geometryKey));

  const secs = (performance.now() - start) / 1000;
  const meta = {
    exp: 'e1', stage: 'A', out, instrumentCommitSha: instrumentCommitSha(),
    generatedAt: new Date().toISOString(),
    cfgCount: cfgs.length, trialCount: totalTrials,
    flaggedFraction: totalTrials > 0 ? totalFlagged / totalTrials : 0,
    inboundSds, neverBaselineContactRate: neverContactRate, neverTrials,
    geometryCount: geometries.length, secs,
    shards: results.map((r, i) => ({ path: path.relative(out, r.outPath) })),
  };
  writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));

  const ranking = {
    topByFanWidth: byFanWidth.map((g) => g.geometryKey),
    topByCradle: byCradle.map((g) => g.geometryKey),
    selectedCount: selected.length,
    geometries: [...geometries].sort((a, b) => (b.fanWidthXa ?? -1) - (a.fanWidthXa ?? -1)),
    selected,
  };
  writeFileSync(path.join(out, 'ranking.json'), JSON.stringify(ranking, null, 2));
  writeFileSync(path.join(out, 'selected-geometries.json'), JSON.stringify(selected.map((g) => g.geometry), null, 2));

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
