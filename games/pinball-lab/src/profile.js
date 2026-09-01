#!/usr/bin/env node
// `node src/profile.js --exp <e> --trials 2000` (§2.8/§2.9): measures µs/step, trials/s,
// bytes/trial and projects the 1e6-trial wall-clock, single-core and across workers. Run
// before every full sweep — this is the tool the program handoff's cost table (§2.8) was
// itself produced with. `performance.now()` is used here ONLY for throughput reporting, per
// §2.4 — it never reaches a trial (instrument.js never imports it).
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { runTrialWithMeta } from './instrument.js';
import { buildE1PilotCfgs } from './sweep.js';

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

function cfgsFor(exp) {
  if (exp === 'e1') return buildE1PilotCfgs();
  throw new Error(`profile.js: unknown --exp '${exp}' (only 'e1' exists in LAB-1)`);
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

  const cfgs = cfgsFor(exp);
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
