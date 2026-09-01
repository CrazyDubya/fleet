#!/usr/bin/env node
// CLI + worker_threads pool (§2.8/§2.9):
//   node src/runner.js --exp e1 --cfgs cfgs/e1-full.json --trials 1e6 --out data/e1/<runId>
//   node src/runner.js --exp e1 --cfg-index 12 --trials 1e6 --out data/e1/<runId>
// `--trials` is the TOTAL across the cfg list when used with --cfgs (split evenly per cfg,
// remainder to the first cfgs), or the trial count for that one cfg when used with
// --cfg-index. Each cfg's trials are sharded by contiguous seed range across
// `os.cpus().length - 1` workers; a crashed worker costs one shard, re-run by seed range.
// No shared state between workers, no locks.
import { Worker } from 'node:worker_threads';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

function instrumentCommitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(import.meta.dirname, '../../pinball') })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

function splitEvenly(total, n) {
  const base = Math.floor(total / n);
  const remainder = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

function runShard(cfg, seedStart, seedCount, outPath) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { cfg, seedStart, seedCount, outPath },
    });
    worker.on('message', (msg) => resolve(msg));
    worker.on('error', (err) => resolve({ ok: false, error: String(err?.stack ?? err) }));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exp = args.exp;
  const out = args.out;
  if (!exp || !out) {
    console.error('usage: node src/runner.js --exp e1 [--cfgs <path.json> | --cfg-index N --cfgs <path.json>] --trials <n> --out <dir>');
    process.exitCode = 1;
    return;
  }
  if (!args.cfgs) {
    console.error('runner.js: --cfgs <path.json> is required (a cfg list; combine with --cfg-index to run just one)');
    process.exitCode = 1;
    return;
  }

  const allCfgs = JSON.parse(readFileSync(args.cfgs, 'utf8'));
  const totalTrials = Number(args.trials);
  if (!Number.isFinite(totalTrials) || totalTrials <= 0) {
    console.error('runner.js: --trials must be a positive number');
    process.exitCode = 1;
    return;
  }

  let cfgs, trialsPerCfg;
  if (args['cfg-index'] !== undefined) {
    const idx = Number(args['cfg-index']);
    cfgs = [allCfgs[idx]];
    trialsPerCfg = [totalTrials];
  } else {
    cfgs = allCfgs;
    trialsPerCfg = splitEvenly(totalTrials, cfgs.length);
  }

  mkdirSync(out, { recursive: true });
  const maxWorkers = Math.max(1, os.cpus().length - 1);
  const start = performance.now();

  let totalRun = 0;
  let totalFlagged = 0;
  const cfgMeta = [];

  for (let i = 0; i < cfgs.length; i++) {
    const cfg = cfgs[i];
    const trials = trialsPerCfg[i];
    // Don't spin up more workers than trials-per-shard would make worthwhile — a 12-cfg,
    // 10k-trial pilot has ~833 trials/cfg, and 11 near-empty shards per cfg is pure overhead.
    const workers = Math.max(1, Math.min(maxWorkers, Math.floor(trials / 100) || 1));
    const shardSizes = splitEvenly(trials, workers);

    const cfgDir = path.join(out, cfg.cfgId);
    mkdirSync(cfgDir, { recursive: true });

    let seedCursor = 0;
    const shardPromises = shardSizes.map((size, shardIdx) => {
      const seedStart = seedCursor;
      seedCursor += size;
      const shardPath = path.join(cfgDir, `shard-${shardIdx}.jsonl.gz`);
      return runShard(cfg, seedStart, size, shardPath).then((result) => ({ ...result, seedStart, size, shardPath }));
    });

    const results = await Promise.all(shardPromises);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error(JSON.stringify({ ok: false, cfgId: cfg.cfgId, failedShards: failed }));
      process.exitCode = 1;
      return;
    }

    const cfgTrials = results.reduce((a, r) => a + r.trials, 0);
    const cfgFlagged = results.reduce((a, r) => a + r.flagged, 0);
    totalRun += cfgTrials;
    totalFlagged += cfgFlagged;
    cfgMeta.push({
      cfgId: cfg.cfgId, cfg, trials: cfgTrials, flagged: cfgFlagged,
      shards: results.map((r) => ({ path: path.relative(out, r.shardPath), seedStart: r.seedStart, count: r.size })),
    });
  }

  const secs = (performance.now() - start) / 1000;

  const meta = {
    exp, out, instrumentCommitSha: instrumentCommitSha(),
    generatedAt: new Date().toISOString(),
    units: { length: 'm', speed: 'm/s', angle: 'deg (recorded), rad (internal)', time_dt_field: 'ms', time_dw_field: 's' },
    cfgCount: cfgs.length, trialCount: totalRun, flaggedFraction: totalRun > 0 ? totalFlagged / totalRun : 0,
    secs, cfgs: cfgMeta,
  };
  writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));

  console.log(JSON.stringify({
    ok: true, cfgs: cfgs.length, trials: totalRun,
    flagged: totalRun > 0 ? Number((totalFlagged / totalRun).toFixed(4)) : 0,
    out, secs: Number(secs.toFixed(1)),
  }));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.stack ?? err) }));
  process.exitCode = 1;
});
