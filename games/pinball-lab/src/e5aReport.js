#!/usr/bin/env node
// LAB-10's deliverable: EXPERIMENT 5a, the release diagnostic (opus2 roadmap §3, E5a). Reads
// one E5a stage run (`data/e4/e5a-<runId>/`, produced by `stageA.js --exp e4`), streams every
// shard once, groups trials by ASSEMBLY (guide geometry x activeAngleDeg x radius — the thing
// E4 attributed the retrap finding to) rather than by cfgId (which also varies upMs and
// releaseDelayMs, orthogonal to the hsS question), and reports shot rate vs the assembly's
// predicted hsS. This is the single number the roadmap's §3/E5a asks for: does shot rate rise
// with hsS (geometry, solver exonerated) or stay ~0 everywhere (model is the suspect)?
//
//   node src/e5aReport.js --run <dir> --out <runId>
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';
import { mean } from './metrics.js';
import { validExclStalled, rankingValidityResult } from './gate.js';

async function* streamShards(dir, meta) {
  for (const shard of meta.shards) {
    const rl = readline.createInterface({ input: createReadStream(path.join(dir, shard.path)).pipe(createGunzip()) });
    for await (const line of rl) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
}

function fmt(x, digits = 4) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

function assemblyKey(cfg) {
  return `${JSON.stringify(cfg.guide)}|${cfg.activeAngleDeg}|${cfg.radius}`;
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
    console.error('usage: node src/e5aReport.js --run <dir> --out <runId>');
    process.exitCode = 1;
    return;
  }

  const meta = JSON.parse(readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
  const cfgById = new Map(meta.cfgs.map((c) => [c.cfg.cfgId, c.cfg]));

  const c0 = meta.c0Cp;
  const c0Ok = meta.c0OnTarget;

  // Group by ASSEMBLY (the geometry that fixes hsS), pooling across the upMs x
  // releaseDelayMs grid — the protocol Stage C already showed is uniform (§8 of LAB-6: 0.05-
  // 0.12% shot rate at every one of 9 combinations), so pooling here answers "does hsS move
  // the needle" without the timing grid diluting the n per bin.
  const byAssembly = new Map();
  for await (const r of streamShards(runDir, meta)) {
    if (!validExclStalled(r.f)) continue;
    const cfg = cfgById.get(r.c);
    if (!cfg || cfg.arm !== 'E5a') continue;
    const key = assemblyKey(cfg);
    let row = byAssembly.get(key);
    if (!row) {
      row = {
        key, hsSPredicted: cfg.hsSPredicted, hsSRaw: cfg.hsSRaw ?? cfg.hsSPredicted, guide: cfg.guide, activeAngleDeg: cfg.activeAngleDeg,
        radius: cfg.radius, trials: 0, cr: 0, cp: 0, shot: 0, retrap: 0, drain: 0,
        measuredHsSVals: [],
      };
      byAssembly.set(key, row);
    }
    row.trials += 1;
    if (r.cr) row.cr += 1;
    if (r.cp) row.cp += 1;
    if (r.rel === 'shot') row.shot += 1;
    else if (r.rel === 'retrap') row.retrap += 1;
    else if (r.rel === 'drain') row.drain += 1;
    if (r.hsS !== null && r.hsS !== undefined) row.measuredHsSVals.push(r.hsS);
  }

  const assemblies = [...byAssembly.values()].map((row) => ({
    ...row,
    crRate: row.trials ? row.cr / row.trials : 0,
    cpRate: row.trials ? row.cp / row.trials : 0,
    shotRate: row.trials ? row.shot / row.trials : 0,
    retrapRate: row.trials ? row.retrap / row.trials : 0,
    drainRate: row.trials ? row.drain / row.trials : 0,
    measuredHsSMean: row.measuredHsSVals.length ? mean(row.measuredHsSVals) : null,
  })).sort((a, b) => a.hsSRaw - b.hsSRaw);

  // The verdict: does shotRate rise with hsSPredicted? Pearson correlation across assemblies
  // (n=15-16, one point per assembly, pooled trials) — simple and matches "does the curve rise
  // steeply" without over-claiming a functional form.
  // LAB-27: correlate against the UNCLAMPED projection. `hsSPredicted` clamps at 0 to match
  // classifySettle's measured range, which collapses 62.4% of the feasible space onto one value
  // and cannot carry an ordering. Both are reported; only the unclamped one is analysed.
  const xs = assemblies.map((a) => a.hsSRaw);
  const ys = assemblies.map((a) => a.shotRate);
  const mx = mean(xs), my = mean(ys);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  const pearsonR = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
  const maxShotRate = Math.max(...ys);
  const minShotRate = Math.min(...ys);

  // §3/E5a's own stated decision rule: "if shot rate rises steeply with hsS -> geometry,
  // solver exonerated. If shot rate stays ~0 at every hsS -> model is the suspect." Applied as
  // a concrete threshold: "rises steeply" requires BOTH a strong positive correlation AND the
  // top-hsS assemblies clearing a shot rate an order of magnitude above Stage C's banked
  // ceiling (0.12%, LAB-6 §5.4) — a curve that's merely "less than uniformly zero" isn't a
  // steep rise.
  const STEEP_R_THRESHOLD = 0.5;
  const STEEP_MAX_THRESHOLD = 0.01; // 1% — ~10x Stage C's banked max of 0.12%
  // LAB-25: gate the verdict on whether the AXIS can carry a correlation at all. E5a's
  // assemblies are binned from an analytic hsS prediction, and the feasible set can collapse
  // onto a handful of distinct values — the regenerated run has 9 of 15 assemblies at
  // hsSPredicted = 0.0000 exactly. A Pearson r over that is decided by the few rows that are
  // not tied, which is the LAB-16 family of mistake arriving in a correlation instead of a
  // ranking. No new threshold: this is gate.js's existing population test (distinct-value
  // floor and tie-block ceiling), the same one every other table in the lab already answers to.
  const axisGuard = rankingValidityResult(xs);
  const curveIsReadable = pearsonR !== null && pearsonR >= STEEP_R_THRESHOLD && maxShotRate >= STEEP_MAX_THRESHOLD;
  const verdict = !axisGuard.ok ? 'INDETERMINATE' : (curveIsReadable ? 'GEOMETRY' : 'MODEL');

  const out = {
    exp: 'e5a', runId, generatedAt: new Date().toISOString(), instrumentCommitSha: meta.instrumentCommitSha,
    c0Cp: c0, c0OnTarget: c0Ok,
    trialCount: meta.trialCount, secs: meta.secs,
    assemblies,
    curve: { pearsonR, maxShotRate, minShotRate, nAssemblies: assemblies.length, axisGuardOk: axisGuard.ok },
    axisGuard,
    verdict,
  };
  writeFileSync(path.join('data/summaries', `e5a-${runId}.json`), JSON.stringify(out, null, 2));

  const lines = [];
  lines.push(`# E5a — the release diagnostic (LAB-10)`);
  lines.push('');
  lines.push(`- **instrument commit**: \`${meta.instrumentCommitSha}\`  ·  **generated**: ${out.generatedAt}`);
  lines.push('');
  lines.push(`## VERDICT: **${verdict}**`);
  lines.push('');
  if (!axisGuard.ok) {
    lines.push(`> ⚠ **The verdict is INDETERMINATE because the axis cannot carry it.** ` +
      `the hsS axis has ${axisGuard.distinctCount} distinct values across ${axisGuard.n} assemblies ` +
      `and ${(axisGuard.maxTieFraction * 100).toFixed(0)}% of them are tied at a single value — ` +
      `${axisGuard.reason}. A Pearson r computed over that is decided by the handful of rows that are ` +
      `not tied, so neither GEOMETRY nor MODEL can be read off it. The per-assembly table below is ` +
      `real measured data and stands on its own; what does not stand is the curve drawn through it. ` +
      `Fixing this needs a denser feasible hsS sweep, not a re-run of this grid.`);
    lines.push('');
  }
  lines.push('');
  if (verdict === 'GEOMETRY') {
    lines.push(`Shot rate rises with \`hsS\` (Pearson r = ${fmt(pearsonR, 3)}, max shot rate ${fmt(maxShotRate * 100, 2)}%` +
      ` vs Stage C's banked ceiling of 0.12%) — **E4's catch/playability tradeoff is real geometry, the kinematic-flipper solver is exonerated on this question.**`);
  } else {
    lines.push(`Shot rate stays near zero across the WHOLE \`hsS\` range swept here (Pearson r = ${fmt(pearsonR, 3)},` +
      ` max shot rate ${fmt(maxShotRate * 100, 2)}%, min ${fmt(minShotRate * 100, 2)}%) — including assemblies E4's Stage C never released from.` +
      ` **The kinematic, spinless, single-\`MU\` flipper model is the suspect: E4's release finding is provisional, and E5b/E5c (ball spin + rubber friction + dynamic flipper) are justified.**`);
  }
  lines.push('');
  lines.push(`- **arena-on-target**: C0 cp = ${fmt(c0 * 100, 2)}% (gate: <1%) — ${c0Ok ? 'PASS' : 'FAIL'}`);
  lines.push(`- **trials**: ${meta.trialCount} across ${meta.cfgs.length} cfgs (${assemblies.length} assemblies x upMs x releaseDelayMs) in ${fmt(meta.secs, 1)}s`);
  lines.push('');
  lines.push('## Shot rate vs hsS (the deciding curve)');
  lines.push('');
  lines.push('| hsS (axis, unclamped) | hsS (predicted, clamped) | hsS (measured mean) | n | cr% | cp% | shot% | retrap% | drain% |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const a of assemblies) {
    lines.push(`| ${fmt(a.hsSRaw, 4)} | ${fmt(a.hsSPredicted, 4)} | ${fmt(a.measuredHsSMean, 4)} | ${a.trials} | ${fmt(a.crRate * 100, 2)} | ${fmt(a.cpRate * 100, 2)} | ${fmt(a.shotRate * 100, 3)} | ${fmt(a.retrapRate * 100, 2)} | ${fmt(a.drainRate * 100, 2)} |`);
  }
  lines.push('');
  // LAB-28 (V5): `pearsonR`/`maxShotRate` are computed AFTER `axisGuard` runs, over the same
  // `xs` the guard already found untrustworthy when it fails — the verdict above already
  // accounts for that (INDETERMINATE), but this raw stat line used to assert the numbers with
  // no marker of its own, so a reader skimming past the verdict banner could still quote
  // "Pearson r = 0.83" as a fact the guard never actually cleared.
  lines.push(`Pearson r(hsS, shotRate) = ${fmt(pearsonR, 3)} across ${assemblies.length} assemblies. Max shot rate ${fmt(maxShotRate * 100, 3)}%, min ${fmt(minShotRate * 100, 3)}%.` +
    (axisGuard.ok ? '' : ' ⚠ computed over an axis the ranking guard above marked invalid — not a validated correlation.'));
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Assemblies are the W1 guide grid (§2.1, `E4_W1_GRID`) x Stage B\'s activeAngleDeg values x A1\'s radius values (`E4_RADII`), stratified by PREDICTED `hsS` (the `pocketSolve` two-contact analytic, same formula as `classifySettle`\'s clamped projection) into one-per-quantile-bin across the WHOLE feasible range — not ranked by `cp` the way Stage C\'s top-6 were.');
  lines.push('- The achievable `hsS` range for this W1 geometry family is asymmetric: unclamped analytic values across the full 1,080-combination grid (W1 x radius x activeAngleDeg) span roughly [-0.38, +0.25]; clamped to [0,1] (matching `classifySettle`), most feasible pockets land at/near 0 and the reachable positive ceiling is ~0.19-0.25, never near the tip. That ceiling is itself part of the answer to "how much of the hsS range is even geometrically reachable" — reported here, not smoothed over.');
  lines.push('- Same release protocol as Stage C: `holdThenRelease` policy, `release: true` (6.0s window), `upMs` ∈ {8,14,24}, `releaseDelayMs` ∈ {60,150,350}, `inj: drop`. `restAngleDeg`/`restitution` held at LAB-2\'s winner, matching every other E4 stage\'s "flipper held fixed except where the design explicitly re-sweeps it" convention.');

  writeFileSync(path.join('data/summaries', `e5a-${runId}.md`), lines.join('\n') + '\n');
  console.log(JSON.stringify({ ok: true, verdict, pearsonR, maxShotRate, nAssemblies: assemblies.length }));
}

main();
