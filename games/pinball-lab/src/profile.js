#!/usr/bin/env node
// `node src/profile.js --exp <e> --trials 2000` (§2.8/§2.9): measures µs/step, trials/s,
// bytes/trial and projects the 1e6-trial wall-clock, single-core and across workers. Run
// before every full sweep — this is the tool the program handoff's cost table (§2.8) was
// itself produced with. `performance.now()` is used here ONLY for throughput reporting, per
// §2.4 — it never reaches a trial (instrument.js never imports it).
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { runTrialWithMeta } from './instrument.js';
import { buildE1PilotCfgs, buildE2SeriesACfgs, buildE2SeriesBCfgs, buildE4SliceCfgs, buildE4StageA1Cfgs, buildE3AllCfgs } from './sweep.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1];
      args[key] = val;
      i++;
    }
  }
  return args;
}

// `--n <N>` restricts an e2 profile to one N's cfgs (all layout variants) — §2.8: "N=50 is the
// expensive cell ... profile it specifically", not just averaged into the whole grid.
function cfgsFor(exp, args) {
  if (exp === 'e1') return buildE1PilotCfgs();
  if (exp === 'e2') {
    const series = args.series === 'B' ? buildE2SeriesBCfgs() : buildE2SeriesACfgs();
    if (args.n === undefined) return series;
    const n = Number(args.n);
    const filtered = series.filter((c) => c.N === n);
    if (filtered.length === 0) throw new Error(`profile.js: no e2 cfgs with N=${n}`);
    return filtered;
  }
  if (exp === 'e4') {
    // A round-robin mix of slice/controls + a sample of the Stage A1 pocket grid — representative
    // of both the cheap (heldActive/drop) and the more expensive (release-phase-capable) trials.
    const sample = buildE4StageA1Cfgs().cfgs.filter((_, i) => i % 20 === 0);
    return [...buildE4SliceCfgs(), ...sample];
  }
  if (exp === 'e3') {
    // A round-robin mix across all five families — representative of the real run, which
    // spends its budget across all of them, not any one family's own cost profile.
    const byFamily = buildE3AllCfgs();
    return [...byFamily.P1, ...byFamily.P2, ...byFamily.P3, ...byFamily.P4, ...byFamily.P5];
  }
  throw new Error(`profile.js: unknown --exp '${exp}'`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const exp = args.exp;
  const trials = Number(args.trials);
  if (!exp || !Number.isFinite(trials) || trials <= 0) {
    console.error('usage: node src/profile.js --exp e1 --trials 2000');
    process.exitCode = 1;
    return;
  }

  const cfgs = cfgsFor(exp, args);
  let totalSteps = 0;
  let totalBytes = 0;

  const start = performance.now();
  for (let i = 0; i < trials; i++) {
    const cfg = cfgs[i % cfgs.length]; // round-robin across the pilot's cfg spread — a
                                        // representative mixture, not one cherry-picked cell.
    const { record, steps } = runTrialWithMeta(cfg, i);
    totalSteps += steps;
    totalBytes += Buffer.byteLength(JSON.stringify(record));
  }
  const elapsedMs = performance.now() - start;

  const secs = elapsedMs / 1000;
  const trialsPerSec = trials / secs;
  const usPerStep = (elapsedMs * 1000) / totalSteps;
  const msPerTrial = elapsedMs / trials;
  const bytesPerTrial = totalBytes / trials;
  const stepsPerTrial = totalSteps / trials;

  const workers = Math.max(1, os.cpus().length - 1);
  const projected1e6SingleCoreSec = 1e6 / trialsPerSec;
  const projected1e6WorkersSec = projected1e6SingleCoreSec / workers;

  console.log(
    `${usPerStep.toFixed(3)} µs/step · ${stepsPerTrial.toFixed(1)} steps/trial · ` +
    `${msPerTrial.toFixed(3)} ms/trial · ${trialsPerSec.toFixed(0)} trials/s (single core) · ` +
    `${bytesPerTrial.toFixed(0)} bytes/trial`
  );
  console.log(
    `projected 1e6 ${exp} trials: ${projected1e6SingleCoreSec.toFixed(1)}s single-core, ` +
    `${projected1e6WorkersSec.toFixed(1)}s across ${workers} workers`
  );

  console.log(JSON.stringify({
    ok: true,
    exp,
    trials,
    usPerStep: Number(usPerStep.toFixed(4)),
    stepsPerTrial: Number(stepsPerTrial.toFixed(2)),
    trialsPerSec: Number(trialsPerSec.toFixed(1)),
    bytesPerTrial: Number(bytesPerTrial.toFixed(1)),
    projected1e6SingleCoreSec: Number(projected1e6SingleCoreSec.toFixed(1)),
    projected1e6WorkersSec: Number(projected1e6WorkersSec.toFixed(1)),
    workers,
    secs: Number(secs.toFixed(3)),
  }));
}

main();
