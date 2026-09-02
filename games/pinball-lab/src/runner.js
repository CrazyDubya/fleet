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
import { sdFromAcc, uniformSd } from './metrics.js';
import { INJECTION as E1_INJECTION, CRADLE_INJECTION as E1_CRADLE_INJECTION } from './arenas/e1_flippers.js';
import { INJECTION_SPEED as E2_SPEED, INJECTION_ANGLE_DEG as E2_ANGLE } from './arenas/e2_bumpers.js';
import { flagGateResult, FLAG_GATE_FRACTION } from './gate.js';

// §2.4a: "every run computes the sd of the sampled inbound quantities and fails loudly if any
// falls below a floor." The floor is a fraction of the theoretical Uniform(lo,hi) sd for that
// quantity — a sample of ~800+ draws should land close to the population sd; a degenerate
// ensemble (LAB-1's actual bug: every trial the same ball) reads as sd ~1e-4 or less, nowhere
// near half the true spread, so 0.5 catches that failure mode with room to spare without
// false-triggering on ordinary small-sample noise.
const INBOUND_SD_FLOOR_FRACTION = 0.5;
// "> 30%" per §2.4a, checked against the `never` policy cfg specifically.
const NEVER_CONTACT_RATE_FLOOR = 0.3;

// §3.5 cradle cfgs sample from a different, narrower band (arenas/e1_flippers.js's
// CRADLE_INJECTION) than the main E1 family — the §2.4a floor has to be checked against the
// band a cfg actually draws from, not the wider main-family band, or every cradle cfg fails
// this check by construction regardless of how real its ensemble is.
const E2_INJECTION_X_MARGIN = 0.02; // mirrors instrument.js's own constant (kept in sync by the smoke test)
// §2.4a "arena on target": E2 has no `never` policy to gate the check on (no actuation at
// all), so this is checked against EVERY e2 cfg's overall bumper-contact rate instead of just
// one baseline cfg — a config where the ball mostly threads past every bumper untouched would
// be measuring drains, not a bumper field, the same failure mode §2.4a's E1 rule guards
// against. 0.20 is set from a real measured floor, not guessed: N=1 (area fraction 2.6%, a
// single small bumper in a wide-open field) legitimately contacts on only ~34% of trials in a
// 6,000-trial smoke run — that's the sparsest mandated config, and it clears 0.20 with real
// headroom while still catching a genuinely broken arena (near-0% contact).
const E2_CONTACT_RATE_FLOOR = 0.2;

function injectionRangesFor(exp, cfg) {
  if (exp === 'e1') {
    const band = cfg?.cradle ? E1_CRADLE_INJECTION : E1_INJECTION;
    return {
      x0: [band.xMin, band.xMax],
      speed0: [band.speedMin, band.speedMax],
      angle0Deg: [band.angleMinDeg, band.angleMaxDeg],
    };
  }
  if (exp === 'e2') {
    // x0's range depends on cfg.fieldWidth (Series B grows the field per config), so this
    // needs a cfg, unlike e1's fixed bands — meta.json's per-cfg inboundSds still trace back
    // correctly since injectionRangesFor is called once per cfg in the loop below.
    const halfW = (cfg?.fieldWidth ?? 0) / 2;
    return {
      x0: [-halfW + E2_INJECTION_X_MARGIN, halfW - E2_INJECTION_X_MARGIN],
      speed0: [E2_SPEED.min, E2_SPEED.max],
      angle0Deg: [E2_ANGLE.min, E2_ANGLE.max],
    };
  }
  throw new Error(`injectionRangesFor: unknown exp '${exp}'`);
}

function combineAcc(accs) {
  return accs.reduce((a, b) => ({ n: a.n + b.n, sum: a.sum + b.sum, sumSq: a.sumSq + b.sumSq }), { n: 0, sum: 0, sumSq: 0 });
}

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
    const cfgContacts = results.reduce((a, r) => a + r.contactCount, 0);
    const contactRate = cfgTrials > 0 ? cfgContacts / cfgTrials : 0;

    const ranges = injectionRangesFor(exp, cfg);
    const inboundSds = {};
    const degenerate = [];
    for (const key of Object.keys(ranges)) {
      const combined = combineAcc(results.map((r) => r.inboundAcc[key]));
      const measuredSd = sdFromAcc(combined);
      const floor = uniformSd(...ranges[key]) * INBOUND_SD_FLOOR_FRACTION;
      inboundSds[key] = measuredSd;
      if (measuredSd < floor) degenerate.push({ key, measuredSd, floor });
    }

    if (degenerate.length > 0) {
      console.error(JSON.stringify({
        ok: false,
        error: '§2.4a ensemble check failed: sampled inbound sd below floor — this run is not data',
        cfgId: cfg.cfgId, cfg, degenerate,
      }));
      process.exitCode = 1;
      return;
    }

    if (cfg.pol === 'never' && contactRate <= NEVER_CONTACT_RATE_FLOOR) {
      console.error(JSON.stringify({
        ok: false,
        error: `§2.4a arena-on-target check failed: 'never' baseline touched a flipper in only ${(contactRate * 100).toFixed(1)}% of trials (need > ${NEVER_CONTACT_RATE_FLOOR * 100}%) — the injection band or aim needs adjusting, not the trial duration`,
        cfgId: cfg.cfgId, cfg, contactRate,
      }));
      process.exitCode = 1;
      return;
    }

    if (exp === 'e2' && contactRate <= E2_CONTACT_RATE_FLOOR) {
      console.error(JSON.stringify({
        ok: false,
        error: `§2.4a arena-on-target check failed: N=${cfg.N} (af=${cfg.areaFraction?.toFixed(3)}, layout ${cfg.layoutVariant}) touched a bumper in only ${(contactRate * 100).toFixed(1)}% of trials (need > ${E2_CONTACT_RATE_FLOOR * 100}%) — the field measures drains, not bumpers`,
        cfgId: cfg.cfgId, cfg, contactRate,
      }));
      process.exitCode = 1;
      return;
    }

    totalRun += cfgTrials;
    totalFlagged += cfgFlagged;
    cfgMeta.push({
      cfgId: cfg.cfgId, cfg, trials: cfgTrials, flagged: cfgFlagged, contactRate, inboundSds,
      shards: results.map((r) => ({ path: path.relative(out, r.shardPath), seedStart: r.seedStart, count: r.size })),
    });
  }

  const secs = (performance.now() - start) / 1000;

  // §2.4a: "report the inbound sds and the baseline contact rate in every summary header" —
  // averaged across cfgs here (the sampling distribution is identical under every cfg, paired
  // seeds; per-cfg values are still in cfgMeta for anyone who wants them un-averaged).
  const ensembleInboundSds = {};
  for (const key of Object.keys(injectionRangesFor(exp))) {
    ensembleInboundSds[key] = cfgMeta.reduce((a, c) => a + c.inboundSds[key], 0) / cfgMeta.length;
  }
  const neverCfg = cfgMeta.find((c) => c.cfg.pol === 'never');
  // LAB-11/P0-1: §2.7's gate applied here too — this path (direct E1/E2 runs, including Stage
  // B and the cradle family) had no exclusion documented anywhere, so it's the plain any-bit
  // fraction, same as E1 Stage A's screen; only E4 (§7) has a STALLED exception.
  const flagGate = flagGateResult({ trials: totalRun, flagged: totalFlagged });

  const meta = {
    exp, out, instrumentCommitSha: instrumentCommitSha(),
    generatedAt: new Date().toISOString(),
    units: { length: 'm', speed: 'm/s', angle: 'deg (recorded), rad (internal)', time_dt_field: 'ms', time_dw_field: 's' },
    cfgCount: cfgs.length, trialCount: totalRun, flaggedFraction: totalRun > 0 ? totalFlagged / totalRun : 0,
    flagGateOk: flagGate.ok,
    ensembleInboundSds, neverBaselineContactRate: neverCfg?.contactRate ?? null,
    secs, cfgs: cfgMeta,
  };
  writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));

  if (!flagGate.ok) {
    console.error(JSON.stringify({ ok: false, error: `§2.7 gate: flagged fraction ${(flagGate.fraction * 100).toFixed(2)}% exceeds ${(FLAG_GATE_FRACTION * 100).toFixed(0)}%`, out }));
    process.exitCode = 1;
    return;
  }

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
