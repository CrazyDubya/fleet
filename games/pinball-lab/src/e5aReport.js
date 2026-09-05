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
import { rate as measuredRate, fmt as fmtMeasured } from './measured.js';

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

/** RETIRE-ALL §6: the shape a correlation coefficient was the wrong statistic for. Sorts
 * assemblies by shot rate, finds the single largest multiplicative gap between consecutive
 * values (guarding against a zero denominator when the low side is exactly 0), and reports the
 * two groups either side of it — "this is a step, not a trend" as an actual partition, not an
 * adjective. `low`/`high` counts and boundary values are what "publish the step" (RETIRE-ALL-C
 * framing carried over from the operator's own summary of the decision doc) means concretely. */
function computeStep(assemblies) {
  const sorted = [...assemblies].map((a) => a.shotRate).sort((a, b) => a - b);
  // The largest ABSOLUTE gap, not the largest ratio — a ratio blows up trivially at the
  // zero-to-first-nonzero boundary (several assemblies commonly sit at exactly 0), which would
  // always "win" and hide the real, much larger separation further up the distribution. The
  // decision doc's own split (13 assemblies <=2.151%, 3 >=29.264%) is the largest ABSOLUTE gap
  // in this data, not the zero boundary.
  let bestGapIdx = -1, bestGapSize = -Infinity;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1] - sorted[i];
    if (gap > bestGapSize) { bestGapSize = gap; bestGapIdx = i; }
  }
  if (bestGapIdx < 0) return { lowCount: sorted.length, highCount: 0, lowMax: sorted[sorted.length - 1] ?? null, highMin: null, gapRatio: null };
  const lowMax = sorted[bestGapIdx], highMin = sorted[bestGapIdx + 1];
  return {
    lowCount: bestGapIdx + 1, highCount: sorted.length - bestGapIdx - 1,
    lowMax, highMin,
    gapRatio: lowMax > 0 ? highMin / lowMax : null,
  };
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

  // MEASURED-1: each rate keeps its bare fraction (crRate etc. — the Pearson-r math below and
  // JSON consumers need a plain number, and those already existed at these exact names) and
  // gains a `Measured` sidecar (`crRateM` etc. — spec §5.3's additive convention: unchanged key
  // stays a bare number, the new key carries n/k/interval). Only the sidecars are rendered in
  // the markdown table below; the bare fields are what get lost silently if read without them.
  const assemblies = [...byAssembly.values()].map((row) => ({
    ...row,
    crRate: row.trials ? row.cr / row.trials : 0,
    cpRate: row.trials ? row.cp / row.trials : 0,
    shotRate: row.trials ? row.shot / row.trials : 0,
    retrapRate: row.trials ? row.retrap / row.trials : 0,
    drainRate: row.trials ? row.drain / row.trials : 0,
    crRateM: measuredRate(row.cr, row.trials, { estimand: 'fraction of trials that catch (cr)' }),
    cpRateM: measuredRate(row.cp, row.trials, { estimand: 'fraction of trials clearing the catch/playability tradeoff (cp)' }),
    shotRateM: measuredRate(row.shot, row.trials, { estimand: 'fraction of trials releasing as a shot' }),
    retrapRateM: measuredRate(row.retrap, row.trials, { estimand: 'fraction of trials releasing as a retrap' }),
    drainRateM: measuredRate(row.drain, row.trials, { estimand: 'fraction of trials releasing as a drain' }),
    measuredHsSMean: row.measuredHsSVals.length ? mean(row.measuredHsSVals) : null,
  })).sort((a, b) => a.hsSRaw - b.hsSRaw);

  // RETIRE-ALL §6 (ledger/handoffs/opus2/20260905T201139Z-decisions.md): `pearsonR` is RETIRED
  // from the verdict, not merely re-labelled. It was real (survives its null past 200,000
  // shuffles) but misdescribed what it measured: the two marginal distributions here permit a
  // maximum achievable r of 0.6949, and the observed 0.6873 is 98.9% of that ceiling — a
  // near-perfect relationship read as "moderate" against the usual 0-1 intuition. Worse,
  // `STEEP_R_THRESHOLD = 0.5` demanded 71.9% of the ACHIEVABLE maximum, not half of a 0-1 scale,
  // and the doc found this gate fails HARDEST when the effect is most concentrated — a
  // perfectly-separated step confined to one assembly would only permit r=0.4125, flipping the
  // verdict to MODEL on a perfect relationship. And it was the wrong shape to begin with: this
  // is a STEP (13 assemblies at <=2.151%, 3 at >=29.264%, a clean gap), not a trend a
  // correlation coefficient is the right statistic for at all.
  //
  // What replaces it, per the decision doc's own Option C ("rest the verdict on magnitude
  // against Stage C's 0.12% ceiling"): the verdict no longer needs a coefficient. It rests on
  // whether shot rate clears Stage C's own banked ceiling by an order of magnitude ANYWHERE in
  // this sweep, plus a description of the step itself (computeStep below) — the actual shape in
  // the data, not a single number standing in for it.
  const xs = assemblies.map((a) => a.hsSRaw);
  const ys = assemblies.map((a) => a.shotRate);
  const maxShotRate = Math.max(...ys);
  const minShotRate = Math.min(...ys);
  const step = computeStep(assemblies);

  const STEEP_MAX_THRESHOLD = 0.01; // 1% — ~10x Stage C's banked max of 0.12%
  // LAB-25: gate the verdict on whether the AXIS can carry an ordering at all. E5a's assemblies
  // are binned from an analytic hsS prediction, and the feasible set can collapse onto a
  // handful of distinct values — the regenerated run has 9 of 15 assemblies at
  // hsSPredicted = 0.0000 exactly. Kept unchanged by this retirement: this guards the AXIS
  // (hsSRaw), not the retired correlation, and the axis question is unaffected by whether a
  // correlation or a step is what's read off it.
  const axisGuard = rankingValidityResult(xs);
  const verdict = !axisGuard.ok ? 'INDETERMINATE' : (maxShotRate >= STEEP_MAX_THRESHOLD ? 'GEOMETRY' : 'MODEL');

  const out = {
    exp: 'e5a', runId, generatedAt: new Date().toISOString(), instrumentCommitSha: meta.instrumentCommitSha,
    c0Cp: c0, c0OnTarget: c0Ok,
    trialCount: meta.trialCount, secs: meta.secs,
    assemblies,
    curve: { maxShotRate, minShotRate, nAssemblies: assemblies.length, axisGuardOk: axisGuard.ok, step },
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
      `${axisGuard.reason}. The per-assembly table below is ` +
      `real measured data and stands on its own; what does not stand is any curve drawn through it. ` +
      `Fixing this needs a denser feasible hsS sweep, not a re-run of this grid.`);
    lines.push('');
  }
  lines.push('');
  // RETIRE-ALL §6: the verdict narration no longer cites a correlation coefficient — it rests on
  // magnitude against Stage C's own banked ceiling (0.12%) and the step itself (computeStep),
  // per the decision doc's Option C. The step's own two numbers (${step.lowCount} at or under
  // its low boundary, ${step.highCount} clearing it) are the shape a coefficient stood in for
  // and got wrong (opus2's doc: 13 assemblies at <=2.151%, 3 at >=29.264%, perfect separation —
  // a step, not a trend, and no coefficient claim survives being retired better than that
  // sentence does).
  if (verdict === 'GEOMETRY') {
    lines.push(
      `Shot rate clears Stage C's banked ceiling (0.12%) by more than an order of magnitude at its ` +
      `highest hsS assemblies — max shot rate ${fmt(maxShotRate * 100, 2)}% — and does so as a STEP, not a ` +
      `trend: ${step.highCount} of ${assemblies.length} assemblies clear ${fmt((step.highMin ?? 0) * 100, 2)}%, ` +
      `${step.lowCount} sit at or under ${fmt((step.lowMax ?? 0) * 100, 2)}%` +
      (step.gapRatio && Number.isFinite(step.gapRatio) ? `, a ${fmt(step.gapRatio, 1)}x gap between the two groups` : '') +
      `. **E4's catch/playability tradeoff is real geometry, the kinematic-flipper solver is exonerated on this question.** ` +
      `(A Pearson r was computed for this shape in an earlier version of this report and is retired: the two ` +
      `marginal distributions here permit a maximum achievable r of ~0.69, so a near-perfect relationship read as ` +
      `"moderate" against the usual 0-1 intuition, and the coefficient is the wrong statistic for a step in the ` +
      `first place — see RETIRE-ALL §6, ledger/handoffs/opus2/20260905T201139Z-decisions.md.)`
    );
  } else {
    lines.push(`Shot rate stays near zero across the WHOLE \`hsS\` range swept here` +
      ` (max shot rate ${fmt(maxShotRate * 100, 2)}%, min ${fmt(minShotRate * 100, 2)}%) — including assemblies E4's Stage C never released from.` +
      ` **The kinematic, spinless, single-\`MU\` flipper model is the suspect: E4's release finding is provisional, and E5b/E5c (ball spin + rubber friction + dynamic flipper) are justified.**`);
  }
  lines.push('');
  lines.push(`- **arena-on-target**: C0 cp = ${fmt(c0 * 100, 2)}% (gate: <1%) — ${c0Ok ? 'PASS' : 'FAIL'}`);
  lines.push(`- **trials**: ${meta.trialCount} across ${meta.cfgs.length} cfgs (${assemblies.length} assemblies x upMs x releaseDelayMs) in ${fmt(meta.secs, 1)}s`);
  lines.push('');
  lines.push('## Shot rate vs hsS (the deciding curve)');
  lines.push('');
  // MEASURED-1: each rate cell is a `Measured` value's own rendered form — rate, event count,
  // and a 95% Wilson interval together, so a thin count (e.g. one event in ~11,000 trials)
  // reads visibly as one event rather than as an indistinguishable 0.009% next to a row backed
  // by thousands. Table is wider for it; the spec's own §5 names that cost explicitly rather
  // than trading it away for a narrower table.
  lines.push('| hsS (axis, unclamped) | hsS (predicted, clamped) | hsS (measured mean) | n | cr | cp | shot | retrap | drain |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const a of assemblies) {
    lines.push(`| ${fmt(a.hsSRaw, 4)} | ${fmt(a.hsSPredicted, 4)} | ${fmt(a.measuredHsSMean, 4)} | ${a.trials} | ${fmtMeasured(a.crRateM)} | ${fmtMeasured(a.cpRateM)} | ${fmtMeasured(a.shotRateM)} | ${fmtMeasured(a.retrapRateM)} | ${fmtMeasured(a.drainRateM)} |`);
  }
  lines.push('');
  // LAB-28 (V5), still applicable after RETIRE-ALL §6: `maxShotRate`/`step` are computed AFTER
  // `axisGuard` runs, over the same `xs` the guard already found untrustworthy when it fails —
  // the verdict above already accounts for that (INDETERMINATE), but this raw stat line asserts
  // the numbers with its own marker regardless, so a reader skimming past the verdict banner
  // still sees the caveat.
  lines.push(`Step across ${assemblies.length} assemblies: ${step.lowCount} low (<=${fmt((step.lowMax ?? 0) * 100, 2)}%), ` +
    `${step.highCount} high (>=${fmt((step.highMin ?? 0) * 100, 2)}%)` +
    (step.gapRatio && Number.isFinite(step.gapRatio) ? `, gap ${fmt(step.gapRatio, 1)}x` : '') +
    `. Max shot rate ${fmt(maxShotRate * 100, 3)}%, min ${fmt(minShotRate * 100, 3)}%.` +
    (axisGuard.ok ? '' : ' ⚠ computed over an axis the ranking guard above marked invalid.'));
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Assemblies are the W1 guide grid (§2.1, `E4_W1_GRID`) x Stage B\'s activeAngleDeg values x A1\'s radius values (`E4_RADII`), stratified by PREDICTED `hsS` (the `pocketSolve` two-contact analytic, same formula as `classifySettle`\'s clamped projection) into one-per-quantile-bin across the WHOLE feasible range — not ranked by `cp` the way Stage C\'s top-6 were.');
  lines.push('- The achievable `hsS` range for this W1 geometry family is asymmetric: unclamped analytic values across the full 1,080-combination grid (W1 x radius x activeAngleDeg) span roughly [-0.38, +0.25]; clamped to [0,1] (matching `classifySettle`), most feasible pockets land at/near 0 and the reachable positive ceiling is ~0.19-0.25, never near the tip. That ceiling is itself part of the answer to "how much of the hsS range is even geometrically reachable" — reported here, not smoothed over.');
  lines.push('- Same release protocol as Stage C: `holdThenRelease` policy, `release: true` (6.0s window), `upMs` ∈ {8,14,24}, `releaseDelayMs` ∈ {60,150,350}, `inj: drop`. `restAngleDeg`/`restitution` held at LAB-2\'s winner, matching every other E4 stage\'s "flipper held fixed except where the design explicitly re-sweeps it" convention.');

  writeFileSync(path.join('data/summaries', `e5a-${runId}.md`), lines.join('\n') + '\n');
  console.log(JSON.stringify({ ok: true, verdict, step, maxShotRate, nAssemblies: assemblies.length }));
}

main();
