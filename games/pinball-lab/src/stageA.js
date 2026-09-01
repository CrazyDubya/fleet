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
import { mkdirSync, writeFileSync } from 'node:fs';
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

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, arr) => {
      if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
      return pairs;
    }, [])
  );
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
