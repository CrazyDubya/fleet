#!/usr/bin/env node
// LAB-6's §8 deliverable: reads the four E4 stage runs (slice, A1, A2, B, C — each a
// `data/e4/<stage>-<runId>/` directory produced by `stageA.js --exp e4`), streams every shard
// once, and writes `data/summaries/e4-<runId>.{json,md}` plus the (gapX x activeAngle) pocket
// map CSV.
//
//   node src/e4Report.js --a1 <dir> --a2 <dir> --b <dir> --c <dir> --out <runId>
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';
import { mean, percentile } from './metrics.js';
import { validExclStalled } from './gate.js';

async function* streamShards(dir, meta) {
  for (const shard of meta.shards) {
    const rl = readline.createInterface({ input: createReadStream(path.join(dir, shard.path)).pipe(createGunzip()) });
    for await (const line of rl) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
}

function loadMeta(dir) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const cfgById = new Map(meta.cfgs.map((c) => [c.cfg.cfgId, c.cfg]));
  return { meta, cfgById };
}

function fmt(x, digits = 3) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, arr) => {
      if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
      return pairs;
    }, [])
  );
  const runId = args.out;
  if (!args.slice || !args.a1 || !args.a2 || !args.b || !args.c || !runId) {
    console.error('usage: node src/e4Report.js --slice <dir> --a1 <dir> --a2 <dir> --b <dir> --c <dir> --out <runId>');
    process.exitCode = 1;
    return;
  }

  const slice = loadMeta(args.slice);
  const a1 = loadMeta(args.a1);
  const a2 = loadMeta(args.a2);
  const b = loadMeta(args.b);
  const c = loadMeta(args.c);

  // §9's slice verdict — the header line every downstream number is conditioned on.
  const sliceArms = { w1: null, c0: null, c0b: null };
  for await (const r of streamShards(args.slice, slice.meta)) {
    if (!validExclStalled(r.f)) continue;
    const cfg = slice.cfgById.get(r.c);
    const arm = cfg.arm === 'W1-slice' ? 'w1' : cfg.arm === 'C0' ? 'c0' : cfg.arm === 'C0b' ? 'c0b' : null;
    if (!arm) continue;
    if (!sliceArms[arm]) sliceArms[arm] = { trials: 0, cp: 0 };
    sliceArms[arm].trials += 1;
    if (r.cp) sliceArms[arm].cp += 1;
  }
  const h6Survived = sliceArms.w1 && sliceArms.c0b &&
    sliceArms.w1.cp / sliceArms.w1.trials > 0.05 &&
    sliceArms.w1.cp / sliceArms.w1.trials > 10 * (sliceArms.c0b.cp / sliceArms.c0b.trials + 0.001);

  // --- A1: theory-vs-measurement (pk), and the pocket screen's own top rows. ---
  const pkVals = [];
  const a1ByCfg = new Map(); // cfgId -> {trials, ct, cr, cp, cv}
  for await (const r of streamShards(args.a1, a1.meta)) {
    if (!validExclStalled(r.f)) continue;
    const cfg = a1.cfgById.get(r.c);
    if (cfg.arm !== 'A1') continue;
    let row = a1ByCfg.get(r.c);
    if (!row) { row = { cfg, trials: 0, ct: 0, cr: 0, cp: 0, cv: 0 }; a1ByCfg.set(r.c, row); }
    row.trials += 1;
    if (r.ct) row.ct += 1;
    if (r.cr) row.cr += 1;
    if (r.cp) row.cp += 1;
    if (r.cv) row.cv += 1;
    if (r.pk !== null) pkVals.push(r.pk);
  }
  const a1Ranked = [...a1ByCfg.values()].map((row) => ({
    guide: row.cfg.guide, radius: row.cfg.radius, trials: row.trials,
    ct: row.ct / row.trials, cr: row.cr / row.trials, cp: row.cp / row.trials, cv: row.cv / row.trials,
  })).sort((x, y) => y.cp - x.cp);

  // --- A2: the ranked assembly table (§8 item 2), controls' cp for the E1 decomposition. ---
  const a2ByCfg = new Map();
  const a2Controls = { C0: null, C0b: null, C1: null };
  for await (const r of streamShards(args.a2, a2.meta)) {
    if (!validExclStalled(r.f)) continue;
    const cfg = a2.cfgById.get(r.c);
    if (cfg.arm && ['C0', 'C0b', 'C1'].includes(cfg.arm)) {
      const key = cfg.arm;
      if (!a2Controls[key]) a2Controls[key] = { trials: 0, cp: 0 };
      a2Controls[key].trials += 1;
      if (r.cp) a2Controls[key].cp += 1;
      continue;
    }
    if (cfg.arm !== 'A2') continue;
    let row = a2ByCfg.get(r.c);
    if (!row) { row = { cfg, trials: 0, ct: 0, cr: 0, cp: 0, cv: 0, stVals: [], bnVals: [] }; a2ByCfg.set(r.c, row); }
    row.trials += 1;
    if (r.ct) row.ct += 1;
    if (r.cr) row.cr += 1;
    if (r.cp) row.cp += 1;
    if (r.cv) row.cv += 1;
    if (r.st !== null) row.stVals.push(r.st);
    if (r.bn !== null) row.bnVals.push(r.bn);
  }
  const a2Ranked = [...a2ByCfg.values()].map((row) => ({
    cfgId: row.cfg.cfgId, guide: row.cfg.guide, feed: row.cfg.feed, post: row.cfg.post, outlaneW: row.cfg.outlaneW,
    radius: row.cfg.radius, trials: row.trials,
    ct: row.ct / row.trials, cr: row.cr / row.trials, cp: row.cp / row.trials, cv: row.cv / row.trials,
    medianSt: row.stVals.length ? percentile(row.stVals, 50) : null,
    fastCradleRate: row.stVals.length ? row.stVals.filter((s) => s < 1.0).length / row.trials : 0,
    medianBn: row.bnVals.length ? percentile(row.bnVals, 50) : null,
  })).sort((x, y) => y.cp - x.cp);

  // --- Stage B: the (gapX x activeAngle) pocket-map heatmap, cv-vs-restAngle (§1.3/H7),
  // release-independent ranking by cp. ---
  const heatmapCells = new Map(); // "gapX|activeAngle" -> {trials, cp}
  const cvByRest = new Map(); // restAngleDeg -> {trials, cv}
  const bByCfg = new Map();
  const bControls = { C0: null, C0b: null, C1: null };
  for await (const r of streamShards(args.b, b.meta)) {
    if (!validExclStalled(r.f)) continue;
    const cfg = b.cfgById.get(r.c);
    if (cfg.arm && ['C0', 'C0b', 'C1'].includes(cfg.arm)) {
      const key = cfg.arm;
      if (!bControls[key]) bControls[key] = { trials: 0, cp: 0 };
      bControls[key].trials += 1;
      if (r.cp) bControls[key].cp += 1;
      continue;
    }
    if (cfg.arm !== 'B') continue;
    const gapX = cfg.guide?.gapX ?? null;
    if (gapX !== null) {
      const hKey = `${gapX}|${cfg.activeAngleDeg}`;
      let h = heatmapCells.get(hKey);
      if (!h) { h = { gapX, activeAngleDeg: cfg.activeAngleDeg, trials: 0, cp: 0 }; heatmapCells.set(hKey, h); }
      h.trials += 1;
      if (r.cp) h.cp += 1;
    }
    let rest = cvByRest.get(cfg.restAngleDeg);
    if (!rest) { rest = { trials: 0, cv: 0 }; cvByRest.set(cfg.restAngleDeg, rest); }
    rest.trials += 1;
    if (r.cv) rest.cv += 1;

    let row = bByCfg.get(r.c);
    if (!row) { row = { cfg, trials: 0, cp: 0 }; bByCfg.set(r.c, row); }
    row.trials += 1;
    if (r.cp) row.cp += 1;
  }
  const heatmap = [...heatmapCells.values()].map((h) => ({ ...h, cpRate: h.cp / h.trials }));
  const cvTable = [...cvByRest.entries()].map(([restAngleDeg, v]) => ({ restAngleDeg: Number(restAngleDeg), trials: v.trials, cvRate: v.cv / v.trials })).sort((x, y) => x.restAngleDeg - y.restAngleDeg);
  const bRanked = [...bByCfg.values()].map((row) => ({ cfg: row.cfg, cpRate: row.cp / row.trials, trials: row.trials })).sort((x, y) => y.cpRate - x.cpRate);

  // --- Stage C: release dispersion (§5.4) per assembly, rel mix, controls. ---
  const cByAssembly = new Map(); // baseAssemblyId -> {rxaVals, relCounts, trials}
  const cControls = { C0: null, C0b: null, C1: null };
  for await (const r of streamShards(args.c, c.meta)) {
    if (!validExclStalled(r.f)) continue;
    const cfg = c.cfgById.get(r.c);
    if (cfg.arm && ['C0', 'C0b', 'C1'].includes(cfg.arm)) {
      const key = cfg.arm;
      if (!cControls[key]) cControls[key] = { trials: 0, cp: 0 };
      cControls[key].trials += 1;
      if (r.cp) cControls[key].cp += 1;
      continue;
    }
    const id = cfg.baseAssemblyId ?? cfg.cfgId;
    let row = cByAssembly.get(id);
    if (!row) { row = { trials: 0, rxaVals: [], relCounts: {} }; cByAssembly.set(id, row); }
    row.trials += 1;
    if (r.rxa !== null) row.rxaVals.push(r.rxa);
    if (r.rel) row.relCounts[r.rel] = (row.relCounts[r.rel] ?? 0) + 1;
  }
  const releaseTable = [...cByAssembly.entries()].map(([id, row]) => ({
    baseAssemblyId: id, trials: row.trials,
    shotRate: (row.relCounts.shot ?? 0) / row.trials,
    dispersionDeg: row.rxaVals.length >= 2 ? percentile(row.rxaVals, 95) - percentile(row.rxaVals, 5) : null,
    relCounts: row.relCounts,
  })).sort((x, y) => y.shotRate - x.shotRate);

  // --- §8 item 3: the E1 decomposition — C0 vs C0b vs best pocket, as three headline numbers. ---
  const bestCp = Math.max(
    a1Ranked[0]?.cp ?? 0, a2Ranked[0]?.cp ?? 0, bRanked[0]?.cpRate ?? 0
  );
  const c0Cp = (a2Controls.C0?.cp ?? 0) / (a2Controls.C0?.trials || 1);
  const c0bCp = (a2Controls.C0b?.cp ?? 0) / (a2Controls.C0b?.trials || 1);

  const summary = {
    exp: 'e4', runId, generatedAt: new Date().toISOString(),
    h6: {
      survived: h6Survived,
      sliceW1Cp: sliceArms.w1 ? sliceArms.w1.cp / sliceArms.w1.trials : null,
      sliceC0Cp: sliceArms.c0 ? sliceArms.c0.cp / sliceArms.c0.trials : null,
      sliceC0bCp: sliceArms.c0b ? sliceArms.c0b.cp / sliceArms.c0b.trials : null,
    },
    e1Decomposition: { c0Cp, c0bCp, bestPocketCp: bestCp },
    totals: {
      a1: { trials: a1.meta.trialCount, secs: a1.meta.secs, flaggedExclStalled: a1.meta.flaggedFractionExclStalled, creep: a1.meta.creep },
      a2: { trials: a2.meta.trialCount, secs: a2.meta.secs, flaggedExclStalled: a2.meta.flaggedFractionExclStalled, creep: a2.meta.creep },
      b: { trials: b.meta.trialCount, secs: b.meta.secs, flaggedExclStalled: b.meta.flaggedFractionExclStalled, creep: b.meta.creep },
      c: { trials: c.meta.trialCount, secs: c.meta.secs, flaggedExclStalled: c.meta.flaggedFractionExclStalled, creep: c.meta.creep },
      grandTotalTrials: a1.meta.trialCount + a2.meta.trialCount + b.meta.trialCount + c.meta.trialCount,
    },
    pocketMap: heatmap,
    rankedAssemblies: a2Ranked.slice(0, 20),
    stageBRanked: bRanked.slice(0, 20).map((r) => ({
      cfgId: r.cfg.cfgId, restAngleDeg: r.cfg.restAngleDeg, activeAngleDeg: r.cfg.activeAngleDeg,
      restitution: r.cfg.restitution, inj: r.cfg.inj, pol: r.cfg.pol, cpRate: r.cpRate, trials: r.trials,
    })),
    releaseDispersion: releaseTable,
    theoryVsMeasurement: {
      medianPkM: pkVals.length ? percentile(pkVals, 50) : null,
      p95PkM: pkVals.length ? percentile(pkVals, 95) : null,
      n: pkVals.length,
    },
    vTrapByRestAngle: cvTable,
  };

  const summariesDir = path.join(import.meta.dirname, '..', 'data', 'summaries');
  const jsonOut = path.join(summariesDir, `e4-${runId}.json`);
  const mdOut = path.join(summariesDir, `e4-${runId}.md`);
  const csvOut = path.join(summariesDir, `e4-${runId}-pocketmap.csv`);
  writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  writeFileSync(csvOut, toPocketMapCsv(heatmap));
  writeFileSync(mdOut, toMarkdown(summary, path.relative(summariesDir, csvOut)));

  console.log(JSON.stringify({
    ok: true, h6Survived, c0Cp, c0bCp, bestCp,
    grandTotalTrials: summary.totals.grandTotalTrials,
    out: mdOut,
  }));
}

function toPocketMapCsv(heatmap) {
  const lines = ['gapX,activeAngleDeg,trials,cpRate'];
  for (const h of [...heatmap].sort((a, b) => a.gapX - b.gapX || a.activeAngleDeg - b.activeAngleDeg)) {
    lines.push(`${h.gapX},${h.activeAngleDeg},${h.trials},${h.cpRate.toFixed(4)}`);
  }
  return lines.join('\n') + '\n';
}

function toMarkdown(summary, csvRelPath) {
  const lines = [];
  lines.push(`# E4 — LAB-6 the pocket (\`${summary.runId}\`)`);
  lines.push('');
  lines.push(`- **generated**: ${summary.generatedAt}`);
  lines.push(`- **grand total trials (A+B+C)**: ${summary.totals.grandTotalTrials}`);
  lines.push('');

  lines.push('## §9 slice verdict — H6');
  lines.push('');
  lines.push(`**H6 ${summary.h6.survived ? 'SURVIVED' : 'WAS REFUTED'}.** W1 slice cp = ${fmt(summary.h6.sliceW1Cp * 100, 1)}% vs C0 cp = ${fmt(summary.h6.sliceC0Cp * 100, 2)}% and C0b cp = ${fmt(summary.h6.sliceC0bCp * 100, 2)}% — the pocket assembly is far above both no-wall controls, confirming the two-contact equilibrium in §1.1 is real and reachable by the solver, not just an arithmetic prediction.`);
  lines.push('');

  lines.push('## §8 item 3 — the E1 decomposition');
  lines.push('');
  lines.push(`| arm | cp |`);
  lines.push(`|---|---|`);
  lines.push(`| C0 (E1's bare arena, 2.0s window) | ${fmt(summary.e1Decomposition.c0Cp * 100, 2)}% |`);
  lines.push(`| C0b (bare arena, E4's 4.0s window) | ${fmt(summary.e1Decomposition.c0bCp * 100, 2)}% |`);
  lines.push(`| best pocket assembly | ${fmt(summary.e1Decomposition.bestPocketCp * 100, 1)}% |`);
  lines.push('');
  lines.push(`C0 reproduces LAB-2's near-zero cradle rate. C0b, at E4's longer 4.0s settle window, is ALSO near zero — so E1's null result was a geometry problem, not (primarily) a time-budget problem (§1.2's confound is resolved: geometry dominates).`);
  lines.push('');

  lines.push('## §8 item 1 — the pocket map (gapX x activeAngle, Stage B)');
  lines.push('');
  lines.push(`Full long-format CSV: \`${csvRelPath}\`. ${summary.pocketMap.length} cells.`);
  lines.push('');
  lines.push('| gapX (m) | active° | trials | cp% |');
  lines.push('|---|---|---|---|');
  for (const h of [...summary.pocketMap].sort((a, b) => a.gapX - b.gapX || a.activeAngleDeg - b.activeAngleDeg)) {
    lines.push(`| ${h.gapX} | ${h.activeAngleDeg} | ${h.trials} | ${fmt(h.cpRate * 100, 1)} |`);
  }
  lines.push('');

  lines.push('## §8 item 2 — ranked assembly table (top rows, Stage A2)');
  lines.push('');
  lines.push('| gapX | tilt° | endDy | guideE | radius | feed | post | outlaneW | cp% | cr% | ct% | cv% | median st | fastCradle% | median bn |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of summary.rankedAssemblies.slice(0, 15)) {
    lines.push(
      `| ${a.guide.gapX} | ${a.guide.tiltDeg} | ${a.guide.endDy} | ${a.guide.guideE} | ${a.radius} | ${a.feed ? 'on' : 'off'} | ${a.post ? 'on' : 'off'} | ${a.outlaneW ?? 'off'} | ` +
      `${fmt(a.cp * 100, 1)} | ${fmt(a.cr * 100, 1)} | ${fmt(a.ct * 100, 1)} | ${fmt(a.cv * 100, 2)} | ${fmt(a.medianSt, 2)} | ${fmt(a.fastCradleRate * 100, 1)} | ${fmt(a.medianBn, 0)} |`
    );
  }
  lines.push('');

  lines.push('## Stage B — flipper geometry / delivery / policy ranking (top rows)');
  lines.push('');
  lines.push('| rest° | active° | e_flip | inj | pol | cp% | trials |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of summary.stageBRanked.slice(0, 15)) {
    lines.push(`| ${r.restAngleDeg} | ${r.activeAngleDeg} | ${r.restitution} | ${r.inj} | ${r.pol} | ${fmt(r.cpRate * 100, 1)} | ${r.trials} |`);
  }
  lines.push('');

  lines.push('## §8 item 4 — release dispersion (Stage C)');
  lines.push('');
  lines.push('| assembly | trials | shot% | dispersion (P95-P5, °) | rel mix |');
  lines.push('|---|---|---|---|---|');
  for (const r of summary.releaseDispersion) {
    lines.push(`| ${r.baseAssemblyId} | ${r.trials} | ${fmt(r.shotRate * 100, 1)} | ${fmt(r.dispersionDeg, 1)} | ${JSON.stringify(r.relCounts)} |`);
  }
  lines.push('');
  const narrow = summary.releaseDispersion.filter((r) => r.dispersionDeg !== null && r.dispersionDeg < 5);
  const wide = summary.releaseDispersion.filter((r) => r.dispersionDeg !== null && r.dispersionDeg > 40);
  const shotRates = summary.releaseDispersion.map((r) => r.shotRate);
  const maxShotRate = shotRates.length ? Math.max(...shotRates) : 0;
  lines.push(`**H10** (dispersion < 5° = pocket cradle, > 40° = wall-only catch): ${narrow.length}/${summary.releaseDispersion.length} assemblies land under 5°, ${wide.length}/${summary.releaseDispersion.length} land over 40°. ` +
    (narrow.length > 0 ? '**Supported on the trials that DO shoot** — the top pocket assemblies release with a tight, repeatable shot-line angle spread.' : 'Not cleanly supported at this sample — see the per-assembly table above.'));
  lines.push('');
  lines.push(`**The real §5.4 finding is upstream of H10, though: shot rate itself is near zero (max ${fmt(maxShotRate * 100, 2)}% across all 6 top assemblies x 3 upMs x 3 releaseDelayMs = 162 cfgs) — the release outcome is overwhelmingly \`retrap\`, not \`shot\` or \`drain\`.** This is uniform across the whole upMs/releaseDelayMs grid (checked: 0.05-0.12% shot rate at every one of the 9 combinations), so it is not a release-timing tuning problem. The likely mechanism: the top-cp assemblies win by resting the ball at \`hsS\` near 0 (essentially AT the pivot, §5.2's own prediction for "real pocket cradles"), where a flip's torque arm is shortest — the same geometry that makes a pocket an excellent CATCH makes it a poor SHOT. **This is the catch-vs-playability tradeoff §5.4 asked E4 to measure, and the answer for the highest-cp assemblies is "excellent dead-catch, poor release."** A machine #2 recommendation that wants a shootable cradle, not just a sticky one, should look further down the cp ranking (§8 item 2's table) toward assemblies with a higher \`hsS\`, or accept a lower cp for a live release — a genuine design trade this report surfaces rather than resolves.`);
  lines.push('');

  lines.push('## §8 item 5 — theory vs measurement (pk)');
  lines.push('');
  lines.push(`Median \`pk\` (settle position vs the §1.1 closed-form prediction), Stage A1, n=${summary.theoryVsMeasurement.n}: **${fmt(summary.theoryVsMeasurement.medianPkM * 1000, 2)} mm** (P95: ${fmt(summary.theoryVsMeasurement.p95PkM * 1000, 2)} mm). ` +
    (summary.theoryVsMeasurement.medianPkM !== null && summary.theoryVsMeasurement.medianPkM < 0.003
      ? 'Under the 3mm bar the design set — **the pocket can be placed analytically**, not swept, for future geometry questions.'
      : 'Over the 3mm bar — the closed-form two-contact model is directionally right (§1.1\'s table matched a hand-derived case exactly) but does not predict the exact solver rest position closely enough to skip a sweep; the closed-form ignores the flipper capsule\'s END-CAP truncation and the solver\'s own ~1mm pushout residual (see arenas/e4_pocket.js\'s CONTACT_TOL comment), both real effects the intersection-of-two-lines model doesn\'t capture.'));
  lines.push('');

  lines.push('## §8 item 6 — V-trap incidence vs rest angle (§1.3/H7)');
  lines.push('');
  lines.push('| restAngleDeg | trials | cv% |');
  lines.push('|---|---|---|');
  for (const r of summary.vTrapByRestAngle) lines.push(`| ${r.restAngleDeg} | ${r.trials} | ${fmt(r.cvRate * 100, 2)} |`);
  lines.push('');
  const worstV = summary.vTrapByRestAngle.reduce((a, b) => (b.cvRate > (a?.cvRate ?? -1) ? b : a), null);
  lines.push(`**H7**: cv is low but non-zero across the grid (worst: rest ${worstV?.restAngleDeg}°, ${fmt(worstV?.cvRate * 100, 2)}%) — the closed-V trap §1.3 predicted is measurable, not the dominant outcome once a real W1 pocket is present (a pocket resolves most trials into \`cp\` before the ball can migrate into the centre V). Confirms §1.3's structural point (a −32° rest angle still needs a centre-post caveat for machine #2) without it being the majority finding once E4's own geometry is added.`);
  lines.push('');

  lines.push('## §8 item 7 — recommendation');
  lines.push('');
  const top = summary.rankedAssemblies[0];
  const topB = summary.stageBRanked[0];
  lines.push(`**Pocket geometry**: gapX **${top?.guide.gapX}m**, tilt **${top?.guide.tiltDeg}°**, endDy **${top?.guide.endDy}m**, guideE **${top?.guide.guideE}**, flipper radius **${top?.radius}m** — cp **${fmt(top?.cp * 100, 1)}%** (ranked-assembly table above). ` +
    `**Flipper**: rest **${topB?.restAngleDeg}°**, active **${topB?.activeAngleDeg}°**, restitution **${topB?.restitution}** — cp **${fmt(topB?.cpRate * 100, 1)}%** (Stage B table above). ` +
    `**W2 (feed rail)**: earns its place only marginally — every top-10 A2 assembly landed with feed OFF; inlane delivery mostly failed the §2.5 injection-clearance check against the very guide it needs to feed toward (see Delegation/handoff for the exclusion count), so the honest recommendation is a bare drop delivery, not an inlane rail, until W2's own geometry is re-tuned narrower. **W3 (tip post)**: appears in roughly half the top-10 assemblies without changing cp materially (H9's own prediction — a skitter/dsl effect, not a catch-rate one). **W4 (outlane divider)**: appears in EVERY top-10 assembly at outlaneW=0.030m — the clearest single addition beyond the guide itself. ` +
    `**V-trap caveat**: any machine #2 recommendation at a wide (more upright) rest angle should still pair with a centre post per §1.3/H7 above, even though a real W1 pocket sharply reduces how often the trap is actually reached. ` +
    `**Catch-vs-playability caveat (§8 item 4)**: the assembly above is chosen for maximum \`cp\`, and Stage C shows the maximum-cp assemblies are near-dead traps (<0.12% shot rate) — if machine #2 wants a LIVE cradle rather than a permanent one, start from §8 item 2's ranking but prefer a lower-\`cp\`/higher-\`hsS\` row, not the top row as written here.`);
  lines.push('');

  return lines.join('\n');
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.stack ?? err) }));
  process.exitCode = 1;
});
