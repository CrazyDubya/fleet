#!/usr/bin/env node
// `node src/replay.js --exp e1 --cfg <cfgId> --seed <n> [--trace]` (§2.4/§2.9): reproduces
// one trial identically and prints its record; --trace adds one line per substep. This is
// the "any single ball is replayable by seed" requirement, and how a surprising summary row
// gets investigated.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runTrial, runTrialWithMeta } from './instrument.js';

function parseArgs(argv) {
  const args = { trace: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--trace') { args.trace = true; continue; }
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

/** Looks up a cfg by id across every committed `cfgs/<exp>-*.json` file — replay.js is
 * handed only a cfgId (per the CLI contract), never a full cfg, so it has to search the
 * same committed cfg files a summary's `meta.json` traces back to. */
function findCfg(exp, cfgId) {
  const cfgsDir = path.join(import.meta.dirname, '..', 'cfgs');
  const files = readdirSync(cfgsDir).filter((f) => f.startsWith(`${exp}-`) && f.endsWith('.json'));
  for (const file of files) {
    const cfgs = JSON.parse(readFileSync(path.join(cfgsDir, file), 'utf8'));
    const match = cfgs.find((c) => c.cfgId === cfgId);
    if (match) return match;
  }
  throw new Error(`replay.js: no cfg with id '${cfgId}' found under cfgs/${exp}-*.json`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const exp = args.exp;
  const cfgId = args.cfg;
  const seed = Number(args.seed);
  if (!exp || !cfgId || !Number.isFinite(seed)) {
    console.error('usage: node src/replay.js --exp e1 --cfg <cfgId> --seed <n> [--trace]');
    process.exitCode = 1;
    return;
  }

  const cfg = findCfg(exp, cfgId);

  if (args.trace) {
    let stepIdx = 0;
    const { record } = runTrialWithMeta(cfg, seed, {
      onStep: (snap) => {
        console.log(JSON.stringify({ step: stepIdx++, ...snap }));
      },
    });
    console.log(JSON.stringify({ ok: true, record }));
  } else {
    const record = runTrial(cfg, seed);
    console.log(JSON.stringify({ ok: true, record }));
  }
}

main();
