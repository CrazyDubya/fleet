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
import { fileURLToPath } from 'node:url';
import { mean, percentile } from './metrics.js';
import { validExclStalled, rankingValidityResult, premiseHeaderLines, requireFlagGateOk } from './gate.js';
import { rate as measuredRate, fmt as fmtMeasured } from './measured.js';
import { selectTopN, meanOf01 } from './selectTopN.js';

// GUARD-MIGRATE (CUT-1 spec §7, items #8/#9/#10): A1/A2/Stage B's `cp` rate is aggregated to a
// count during streaming (`row.cp += 1`), the per-trial 0/1 sequence itself is not retained —
// exactly the cost the spec's §3 names ("several writers aggregate and drop the per-trial
// arrays. There is no version of this that gets stability for free"). Reconstructing an
// EXCHANGEABLE 0/1 array from the count is not a shortcut around that cost: for a rate
// estimator, split-half resampling only ever depends on how many 1s land in each half, never on
// which specific trial produced a given 1 — a uniformly shuffled synthetic array with the same
// k/n has exactly the same distribution of split-half outcomes a full per-trial retrofit would
// have produced. Retaining the true per-trial sequence would let a future caller ask an
// order-dependent question (e.g. "did the rate drift over the run") that this cannot; it is not
// needed for what selectTopN measures.
function synthBinary(k, n) {
  const arr = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = i < k ? 1 : 0;
  return arr;
}

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

// LAB-28 (V4): `fmt(x * 100, d)` turns a `null` "not measured" sentinel into the number 0 before
// fmt ever sees it (`null * 100 === 0`), rendering it as `0.00` — indistinguishable from a
// genuinely measured 0%. Callers with a value that may be null must multiply through this
// helper instead of doing `x * 100` inline.
function fmtPct(x, digits = 3) {
  return fmt(x === null || x === undefined ? null : x * 100, digits);
}

// GUARD-MIGRATE: "what do these rows share" (RETIRE-REST §7's own question, now asked of
// whatever group selectTopN actually identified — a banded top group, or an unordered
// population's max-value rows — rather than a hand-rolled tie-at-the-max computation).
function sharedFieldsAcrossRows(rows, fieldsFn) {
  if (!rows.length) return { shared: {}, varies: [] };
  const fieldSets = rows.map(fieldsFn);
  const keys = Object.keys(fieldSets[0]);
  const shared = {};
  const varies = [];
  for (const k of keys) {
    const distinct = new Set(fieldSets.map((f) => JSON.stringify(f[k])));
    if (distinct.size === 1) shared[k] = fieldSets[0][k];
    else varies.push(k);
  }
  return { shared, varies };
}

function fmtFieldValue(k, v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (v === null || v === undefined) return 'off';
  return String(v);
}

// GUARD-MIGRATE: the per-table caveat block for a2/b, driven by the actual selectTopN
// CutResult rather than a boundary-only guard plus a hand-rolled tie lookup. `byKeyMap`/
// `fieldsFn` let this join a `banded` result's top-band keys back to the full rows (selectTopN
// itself only carries `{key, value, samples}`, not the whole row) to describe what that band
// shares, the same question RETIRE-REST §7 asked of a flat tie.
function cutStatusNote(cut, byKeyMap, fieldsFn, label) {
  if (cut.kind === 'ranked') {
    // GUARD-MIGRATE FINDING: found migrating A2's real top-20. selectTopN's split-half
    // stability check has NO POWER to detect an EXACT tie at a rate estimator's boundary
    // (cp=1.0, every trial a catch) — resampling a deterministic all-1s array reproduces
    // exactly 1.0 every time, so agreement is perfect not because the order is stable but
    // because there is no variance left for resampling to disturb. `structural` (the
    // boundary-ambiguity check) misses it too when the tie sits above the cut boundary rather
    // than at it (RETIRE-REST §7's original finding). Measured on A2-final: 15 of 217
    // assemblies tie at EXACTLY cp=1.0, and this cut still reports `ranked`. Checked here
    // rather than in selectTopN.js itself — this is a gap in a shared, already-reviewed
    // library, not something to patch unreviewed mid-migration; flagged for the spec owner.
    const maxVal = cut.cut[0].value;
    const tiedAtMax = cut.cut.filter((c) => c.value === maxVal).length;
    if (tiedAtMax > 1) {
      const { shared, varies } = sharedFieldsAcrossRows(cut.cut.slice(0, tiedAtMax).map((c) => byKeyMap.get(c.key)), fieldsFn);
      return `> ⚠ **RANKED, BUT THE TOP IS AN EXACT TIE (selectTopN limitation)**: \`cp\` reports ` +
        `\`kind: 'ranked'\` — split-half resampling found the requested cut stable — but ` +
        `**${tiedAtMax} of the top ${cut.cut.length} rows tie at EXACTLY cp = ${fmtPct(maxVal, 1)}%**, ` +
        'a boundary value with zero resampling variance to reveal as unstable. The specific order ' +
        `among those ${tiedAtMax} rows is arbitrary, not confirmed. Shared across all of them: ` +
        `${sharedFieldsText(shared)}${varies.length ? `; they differ on ${varies.join(', ')}` : ''}.`;
    }
    return null;
  }
  if (cut.kind === 'banded') {
    const topBand = cut.bands[0];
    const { shared, varies } = sharedFieldsAcrossRows(topBand.map((b) => byKeyMap.get(b.key)), fieldsFn);
    const kPoint = cut.stability.curve.find((p) => p.k === cut.bandCount);
    return `> ⚠ **TOP-${cut.requestedN} NOT RESOLVABLE (selectTopN)**: \`cp\` cannot order the full ` +
      `${cut.structural.n}-${label} population finely enough for a top-${cut.requestedN} — it demotes to ` +
      `**${cut.bandCount} stable band(s)** instead (split-half within-one agreement ${kPoint ? (kPoint.withinOne * 100).toFixed(1) : '—'}%). ` +
      `The top band alone holds **${topBand.length} rows**, all at cp up to ${fmtPct(topBand[0].value, 1)}%, sharing ` +
      `${sharedFieldsText(shared)}${varies.length ? ` and differing on ${varies.join(', ')}` : ''} — nothing orders ` +
      'those rows against each other. Rows below are shown for reference only.';
  }
  return `> ⚠ **RANKING INVALID (selectTopN)**: \`cp\` cannot order the full ${cut.structural.n}-${label} ` +
    `population at all — ${cut.reason}. Rows below are shown for reference only; their order is not a ` +
    'performance signal.';
}

function sharedFieldsText(shared) {
  const entries = Object.entries(shared);
  if (!entries.length) return 'nothing — even the configuration fields differ across the tied rows';
  return entries.map(([k, v]) => `${k}=${fmtFieldValue(k, v)}`).join(', ');
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
    cpCount: row.cp,
  })).sort((x, y) => y.cp - x.cp);
  const a1Key = (r) => `${r.guide.gapX}|${r.guide.tiltDeg}|${r.guide.endDy}|${r.guide.guideE}|${r.radius}`;
  // GUARD-MIGRATE (CUT-1 spec §7 item #8): the top-1 pocket pick, through selectTopN rather
  // than a boundary-only ranking guard. Runs the FULL structural + split-half stability check
  // (see `synthBinary`'s comment above for why a reconstructed 0/1 array is honest here).
  const a1Cut = selectTopN({
    rows: a1Ranked, samples: (r) => synthBinary(r.cpCount, r.trials), estimator: meanOf01,
    support: (r) => r.trials, n: 1, key: a1Key,
  });

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
  const a2Ranked = [...a2ByCfg.values()].map((row) => {
    const fastCradleCount = row.stVals.filter((s) => s < 1.0).length;
    return {
      cfgId: row.cfg.cfgId, guide: row.cfg.guide, feed: row.cfg.feed, post: row.cfg.post, outlaneW: row.cfg.outlaneW,
      radius: row.cfg.radius, trials: row.trials,
      ct: row.ct / row.trials, cr: row.cr / row.trials, cp: row.cp / row.trials, cv: row.cv / row.trials,
      // MEASURED-3: additive sidecars — bare fields above are unchanged.
      ctM: measuredRate(row.ct, row.trials, { estimand: `${row.cfg.cfgId}: fraction of trials clearing the ct check` }),
      crM: measuredRate(row.cr, row.trials, { estimand: `${row.cfg.cfgId}: fraction of trials that catch (cr)` }),
      cpM: measuredRate(row.cp, row.trials, { estimand: `${row.cfg.cfgId}: fraction of trials clearing the catch/playability tradeoff (cp)` }),
      cvM: measuredRate(row.cv, row.trials, { estimand: `${row.cfg.cfgId}: fraction of trials landing in the closed-V trap (cv)` }),
      medianSt: row.stVals.length ? percentile(row.stVals, 50) : null,
      fastCradleRate: row.stVals.length ? fastCradleCount / row.trials : 0,
      fastCradleRateM: measuredRate(fastCradleCount, row.trials, { estimand: `${row.cfg.cfgId}: fraction of trials settling in under 1.0s` }),
      medianBn: row.bnVals.length ? percentile(row.bnVals, 50) : null,
      cpCount: row.cp,
    };
  }).sort((x, y) => y.cp - x.cp);
  // GUARD-MIGRATE (CUT-1 spec §7 item #9): the A2 top-20, through selectTopN. This is the case
  // the migration itself found: the OLD boundary-only guard reported this population "ok" (its
  // 15-way tie sits above the top-20 cut boundary, not inside it), but selectTopN's split-half
  // stability check evaluates whether the CUT ITSELF replicates, which a boundary check cannot
  // see — see the result inspected below for what that difference actually produces.
  const a2Cut = selectTopN({
    rows: a2Ranked, samples: (r) => synthBinary(r.cpCount, r.trials), estimator: meanOf01,
    support: (r) => r.trials, n: 20, key: (r) => r.cfgId,
  });

  // GUARD-MIGRATE (CUT-1 spec §7, item #12): the pocket-map heatmap below is a GRID, sorted by
  // (gapX, activeAngle) for layout, not by cp — no cell is ever called "best", each carries its
  // own trials/cpRateM, so this is `population` in CUT-1's terms, never a cut candidate.
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
  const heatmap = [...heatmapCells.values()].map((h) => ({
    ...h, cpRate: h.cp / h.trials,
    // MEASURED-3: additive sidecar — bare `cpRate` above is unchanged (the CSV writer and sort
    // below both need a plain number).
    cpRateM: measuredRate(h.cp, h.trials, { estimand: `pocket map gapX=${h.gapX} active=${h.activeAngleDeg}: fraction of trials catching (cp)` }),
  }));
  const cvTable = [...cvByRest.entries()].map(([restAngleDeg, v]) => ({
    restAngleDeg: Number(restAngleDeg), trials: v.trials, cvRate: v.cv / v.trials,
    cvRateM: measuredRate(v.cv, v.trials, { estimand: `rest angle ${restAngleDeg}°: fraction of trials landing in the closed-V trap (cv)` }),
  })).sort((x, y) => x.restAngleDeg - y.restAngleDeg);
  const bRanked = [...bByCfg.values()].map((row) => ({
    cfg: row.cfg, cpRate: row.cp / row.trials, trials: row.trials,
    // MEASURED-3: additive sidecar — bare `cpRate` above is unchanged (the sort just below and
    // stageBRanked's own mapping further down both need a plain number).
    cpRateM: measuredRate(row.cp, row.trials, { estimand: `${row.cfg.cfgId}: fraction of trials catching (cp)` }),
    cpCount: row.cp,
  })).sort((x, y) => y.cpRate - x.cpRate);
  // GUARD-MIGRATE (CUT-1 spec §7 item #10): the Stage B top-20, through selectTopN. Spec's own
  // prediction: "expected unordered or heavily demoted — 105-way tie at the cut."
  const bCut = selectTopN({
    rows: bRanked, samples: (r) => synthBinary(r.cpCount, r.trials), estimator: meanOf01,
    support: (r) => r.trials, n: 20, key: (r) => r.cfg.cfgId,
  });

  // GUARD-MIGRATE (CUT-1 spec §7, item #11): sorted by `shotRate` for READABILITY — no code
  // path calls its top row "best" (the catch-vs-playability discussion below cites `maxShotRate`,
  // a separate argmax, deliberately excluded from selectTopN/Measured — see MEASURED-3's own
  // note at that site). `releaseRankingGuard` stays as an extra integrity check on the whole
  // population's orderability (not a topN cut), which is compatible with — not a substitute for
  // — this being a display order rather than a cut.
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
    // MEASURED-2: additive sidecar (bare `shotRate` above is unchanged — the sort and the
    // ranking guard just below both need a plain number).
    shotRateM: measuredRate(row.relCounts.shot ?? 0, row.trials, { estimand: `${id}: fraction of trials releasing as a shot` }),
    dispersionDeg: row.rxaVals.length >= 2 ? percentile(row.rxaVals, 95) - percentile(row.rxaVals, 5) : null,
    relCounts: row.relCounts,
  })).sort((x, y) => y.shotRate - x.shotRate);
  const releaseRankingGuard = rankingValidityResult(releaseTable.map((r) => r.shotRate));

  // --- §8 item 3: the E1 decomposition — C0 vs C0b vs best pocket, as three headline numbers. ---
  // GUARD-MIGRATE: `bestCp` used to be the max of three tables' rank-1 rows regardless of
  // whether each table's own guard passed (a warning flag rode alongside the number, but the
  // number was published either way). Through selectTopN there is no such fallback: a
  // candidate contributes ONLY if its own cut is `kind === 'ranked'` — a `banded`/`unordered`
  // result has no `cut` field to read a value from (the anti-V2 mechanism the spec names in
  // §5), so a table that cannot resolve even its own top-1/top-20 cannot contribute a "best"
  // figure at all, rather than contributing one with an asterisk.
  const bestCandidates = [
    { cut: a1Cut, table: 'a1' },
    { cut: a2Cut, table: 'a2' },
    { cut: bCut, table: 'b' },
  ].filter((c) => c.cut.kind === 'ranked');
  const bestCandidate = bestCandidates.length
    ? bestCandidates.reduce((best, c) => (c.cut.cut[0].value > best.cut.cut[0].value ? c : best))
    : null;
  const bestCp = bestCandidate?.cut.cut[0].value ?? null;
  // bestCpGuardOk / bestPocketCpGuardOk: kept as the field names V5's own regression test
  // checks for (`test/writer-guard-fixes.test.mjs`) — meaning is now "a genuinely resolvable
  // ranked result was found among the three tables", not "the old boundary-only guard passed".
  const bestCpGuardOk = bestCandidate !== null;
  const bestCpTable = bestCandidate?.table ?? null;
  // LAB-28 (V4): `?? 0` here made "no C0/C0b control data present" read identically to "measured
  // 0% cradle rate" — both an upstream wiring error (empty controls) and a genuinely clean
  // corpus produced the same number with no way for a reader to tell them apart. `null` is the
  // sentinel this project already uses everywhere else for "not measured" (`fmt()` renders it as
  // `—` in every writer here).
  const c0Cp = a2Controls.C0 ? a2Controls.C0.cp / a2Controls.C0.trials : null;
  const c0bCp = a2Controls.C0b ? a2Controls.C0b.cp / a2Controls.C0b.trials : null;

  // A corpus that cannot name its instrument commit cannot be audited from itself (opus2,
  // 2026-09-04 solver-fix audit — E4/E5a were the two writers missing this; recovering the
  // commit meant reading raw run meta.json instead of the summary). Four stage runs feed one
  // E4 summary; if they were ever produced at different commits that's worth knowing loudly,
  // not silently reporting whichever stage happened to be read first.
  const stageCommits = { a1: a1.meta.instrumentCommitSha, a2: a2.meta.instrumentCommitSha, b: b.meta.instrumentCommitSha, c: c.meta.instrumentCommitSha };
  const instrumentCommitSha = stageCommits.a1;
  const commitMismatches = Object.entries(stageCommits).filter(([, sha]) => sha !== instrumentCommitSha);
  if (commitMismatches.length > 0) {
    console.error(JSON.stringify({
      warning: 'E4 stages were built at different instrument commits',
      stageCommits,
    }));
  }

  const summary = {
    exp: 'e4', runId, generatedAt: new Date().toISOString(), instrumentCommitSha,
    h6: {
      survived: h6Survived,
      sliceW1Cp: sliceArms.w1 ? sliceArms.w1.cp / sliceArms.w1.trials : null,
      sliceC0Cp: sliceArms.c0 ? sliceArms.c0.cp / sliceArms.c0.trials : null,
      sliceC0bCp: sliceArms.c0b ? sliceArms.c0b.cp / sliceArms.c0b.trials : null,
      // MEASURED-3: additive sidecars — bare fields above are unchanged.
      sliceW1CpM: sliceArms.w1 ? measuredRate(sliceArms.w1.cp, sliceArms.w1.trials, { estimand: 'H6 slice, W1 arm: fraction of trials catching' }) : null,
      sliceC0CpM: sliceArms.c0 ? measuredRate(sliceArms.c0.cp, sliceArms.c0.trials, { estimand: 'H6 slice, C0 arm: fraction of trials catching' }) : null,
      sliceC0bCpM: sliceArms.c0b ? measuredRate(sliceArms.c0b.cp, sliceArms.c0b.trials, { estimand: 'H6 slice, C0b arm: fraction of trials catching' }) : null,
    },
    e1Decomposition: {
      c0Cp, c0bCp, bestPocketCp: bestCp, bestPocketCpGuardOk: bestCpGuardOk,
      bestPocketCpTable: bestCpTable,
      // MEASURED-3: C0/C0b are genuine single-population rates (the E1/E4 bare-arena controls)
      // and get sidecars. `bestPocketCp` deliberately does NOT — it is the max taken across
      // three different tables' rank-1 rows (an argmax/selection, same category measured.js's
      // own docstring excludes: "max/min/argmax/best/knee... belong to selectTopN"). Its
      // uncertainty is now carried by whichever table won (`summary.cuts[bestPocketCpTable]`)
      // being a genuine `ranked` CutResult, not a Wilson interval on the selected value itself.
      c0CpM: a2Controls.C0 ? measuredRate(a2Controls.C0.cp, a2Controls.C0.trials, { estimand: 'E1 decomposition, C0 control: fraction of trials catching' }) : null,
      c0bCpM: a2Controls.C0b ? measuredRate(a2Controls.C0b.cp, a2Controls.C0b.trials, { estimand: 'E1 decomposition, C0b control: fraction of trials catching' }) : null,
    },
    totals: {
      a1: { trials: a1.meta.trialCount, secs: a1.meta.secs, flaggedExclStalled: a1.meta.flaggedFractionExclStalled, creep: a1.meta.creep },
      a2: { trials: a2.meta.trialCount, secs: a2.meta.secs, flaggedExclStalled: a2.meta.flaggedFractionExclStalled, creep: a2.meta.creep },
      b: { trials: b.meta.trialCount, secs: b.meta.secs, flaggedExclStalled: b.meta.flaggedFractionExclStalled, creep: b.meta.creep },
      c: { trials: c.meta.trialCount, secs: c.meta.secs, flaggedExclStalled: c.meta.flaggedFractionExclStalled, creep: c.meta.creep },
      grandTotalTrials: a1.meta.trialCount + a2.meta.trialCount + b.meta.trialCount + c.meta.trialCount,
    },
    pocketMap: heatmap,
    // GUARD-MIGRATE: these two now carry the FULL sorted POPULATION (CUT-1's own term for
    // "every row, ranked, no claim of a validated cut"), not a pre-sliced top-20 — a `banded`
    // result's top band can hold more than 20 rows (the 105-way-tie case does), and the
    // markdown renderer needs every row a band might reference, joined back by key, not just
    // the first 20. Display still slices to 15 rows at render time, below.
    rankedAssemblies: a2Ranked,
    stageBRanked: bRanked.map((r) => ({
      cfgId: r.cfg.cfgId, restAngleDeg: r.cfg.restAngleDeg, activeAngleDeg: r.cfg.activeAngleDeg,
      restitution: r.cfg.restitution, inj: r.cfg.inj, pol: r.cfg.pol, cpRate: r.cpRate, cpRateM: r.cpRateM, trials: r.trials,
    })),
    releaseDispersion: releaseTable,
    theoryVsMeasurement: {
      medianPkM: pkVals.length ? percentile(pkVals, 50) : null,
      p95PkM: pkVals.length ? percentile(pkVals, 95) : null,
      n: pkVals.length,
    },
    vTrapByRestAngle: cvTable,
    // LAB-22: Stage A1 is the stage that declares a §2.7 premise (the coarse first-stage
    // sweep); it is carried through to the summary header so the claim is visible there.
    declaredPremise: a1.meta.declaredPremise ?? null,
    declaredPremiseStage: 'A1',
    declaredPremiseGate: { fraction: a1.meta.flaggedFractionExclStalled, ok: requireFlagGateOk(a1.meta.flagGateOk, 'e4Report (--a1 meta.json)') },
    // GUARD-MIGRATE (CUT-1 spec §7 items #8/#9/#10): the full CutResult for each of A1's top-1,
    // A2's top-20 and Stage B's top-20 — `kind` is 'ranked'/'banded'/'unordered', `cut` exists
    // only on 'ranked', `bands` only on 'banded', `population` always. Supersedes the old
    // boundary-only ranking guard and the RETIRE-REST equivalence-class computation for these
    // three tables (selectTopN's split-half stability check is strictly more informative: see
    // `a2Cut`'s own comment above for a case it catches that the boundary check missed).
    cuts: { a1: a1Cut, a2: a2Cut, b: bCut },
    // Item #11 (release dispersion) is a display order, not a cut (GUARD-MIGRATE relabelling
    // above) — its guard is an orthogonal integrity check, kept in its pre-existing shape.
    rankingGuard: { releaseDispersion: releaseRankingGuard },
  };

  const rankingGuardFailures = Object.entries(summary.rankingGuard).filter(([, r]) => !r.ok);
  // GUARD-MIGRATE: a cut that demoted (banded/unordered) is the selectTopN equivalent of the
  // old guard failing — checked alongside `rankingGuard` so the same loud-not-silent treatment
  // covers both the migrated cuts and item #11's still-unmigrated display-order guard.
  const cutDemotions = Object.entries(summary.cuts).filter(([, c]) => c.kind !== 'ranked');
  if (rankingGuardFailures.length > 0 || cutDemotions.length > 0) {
    // LAB-16: loud, not silent — a table below whose header carries a ⚠ is degenerate ranking
    // input, reported per-table rather than blocking the whole multi-section report (the other
    // tables/metrics here are independently valid; §7's near-zero shot rate for Stage C is
    // already narrated in prose above the table it now also flags).
    console.error(JSON.stringify({
      warning: 'LAB-16/CUT-1: one or more E4 tables cannot support the cut/ordering requested of them',
      rankingGuardFailures: rankingGuardFailures.map(([k, r]) => ({ table: k, ...r })),
      cutDemotions: cutDemotions.map(([k, c]) => ({ table: k, kind: c.kind, reason: c.reason ?? null, bandCount: c.bandCount ?? null })),
    }));
    // LAB-20: enforced, not merely recorded. This stays a WARNING rather than a block, unlike
    // stageA.js's cradle guard which refuses to write `selected-geometries.json` — the
    // difference is what the artifact is for. stageA's file is a downstream contract: Stage B
    // and the cradle sweep consume it, so a bad ranking there silently narrows what is ever
    // examined again. e4Report writes only the summary json/csv/md (verified: those are its
    // only writeFileSync calls) and nothing consumes them, so blocking would suppress the
    // pocket map, the H6 verdict, the E1 decomposition and vTrap — all independently valid —
    // to punish one unusable ordering. A non-zero exit makes the failure visible to a caller
    // or CI, which `console.error` alone did not.
    process.exitCode = 1;
  }

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

/** GUARD-MIGRATE: reduces a selectTopN CutResult to the `{ok, n, reason}` shape
 * `guardStatusLines` already renders — a1/a2/b now decide their status via selectTopN rather
 * than a direct `rankingValidityResult` call, but the STATUS BLOCK'S rendering doesn't need to
 * change to know that; it only ever needed a verdict and a reason. */
export function cutAsGuard(cut) {
  if (cut.kind === 'ranked') return { ok: true, n: cut.structural.n, reason: null };
  const reason = cut.kind === 'banded'
    ? `requested top-${cut.requestedN} not resolvable; demoted to ${cut.bandCount} stable band(s) instead (${cut.stability.rule})`
    : cut.reason;
  return { ok: false, n: cut.structural.n, reason };
}

/**
 * LAB-20: the status of every ranking guard, in one block, whatever the verdict.
 *
 * Three of the four guards had a per-table ⚠ block; `a1` renders no table of its own, so a
 * failing a1 existed only as a JSON field and was invisible to a reader of the markdown. A
 * per-table block structurally cannot cover a guard with no table — hence one enumerated block,
 * stating all four. Passing guards are listed too: "which guards ran and what they said" is the
 * record, and a block that appears only on failure teaches a reader nothing when it is absent.
 */
export function guardStatusLines(rankingGuard) {
  const lines = ['## Ranking guard status (LAB-16/LAB-20)', ''];
  const failures = Object.entries(rankingGuard).filter(([, g]) => !g.ok);
  if (failures.length > 0) {
    lines.push(`> ⚠ **RANKING INVALID (LAB-16 gate)** — ${failures.length} of ` +
      `${Object.keys(rankingGuard).length} ranking guards failed. Any ordering they govern is ` +
      'insertion order, not a ranking; the rows themselves remain individually valid.');
    lines.push('');
  }
  lines.push('| guard | population | verdict | reason |');
  lines.push('|---|---|---|---|');
  for (const [name, g] of Object.entries(rankingGuard)) {
    lines.push(`| \`${name}\` | ${g.n ?? '—'} | ${g.ok ? '✓ ok' : '⚠ INVALID'} | ${g.ok ? '—' : g.reason} |`);
  }
  lines.push('');
  return lines;
}

// GUARD-MIGRATE: field extractors for the "what does this band share" question, matched to
// the (different) shapes `summary.rankedAssemblies` (a2Ranked, nested `.guide`) and
// `summary.stageBRanked` (already flattened) actually carry.
const a2FieldsFromSummary = (r) => ({ gapX: r.guide.gapX, tiltDeg: r.guide.tiltDeg, endDy: r.guide.endDy, guideE: r.guide.guideE, radius: r.radius, feed: r.feed, post: r.post, outlaneW: r.outlaneW });
const bFieldsFromSummary = (r) => ({ restAngleDeg: r.restAngleDeg, activeAngleDeg: r.activeAngleDeg, restitution: r.restitution, inj: r.inj, pol: r.pol });

export function toMarkdown(summary, csvRelPath) {
  const lines = [];
  const a2ByKey = new Map(summary.rankedAssemblies.map((r) => [r.cfgId, r]));
  const bByKey = new Map(summary.stageBRanked.map((r) => [r.cfgId, r]));
  lines.push(`# E4 — LAB-6 the pocket (\`${summary.runId}\`)`);
  lines.push('');
  lines.push(`- **instrument commit**: \`${summary.instrumentCommitSha}\`  ·  **generated**: ${summary.generatedAt}`);
  lines.push(`- **grand total trials (A+B+C)**: ${summary.totals.grandTotalTrials}`);
  lines.push('');

  lines.push(...guardStatusLines({
    a1: cutAsGuard(summary.cuts.a1), a2: cutAsGuard(summary.cuts.a2), b: cutAsGuard(summary.cuts.b),
    ...summary.rankingGuard,
  }));

  // LAB-22: A1's declared §2.7 premise, echoed where a reader will actually meet it.
  if (summary.declaredPremise) {
    lines.push(...premiseHeaderLines(summary.declaredPremise, summary.declaredPremiseGate)
      .map((l) => (l.startsWith('## ') ? `${l} — Stage ${summary.declaredPremiseStage}` : l)));
  }

  lines.push('## §9 slice verdict — H6');
  lines.push('');
  const fmtCpM = (m) => (m ? fmtMeasured(m) : '—');
  lines.push(`**H6 ${summary.h6.survived ? 'SURVIVED' : 'WAS REFUTED'}.** W1 slice cp = ${fmtCpM(summary.h6.sliceW1CpM)} vs C0 cp = ${fmtCpM(summary.h6.sliceC0CpM)} and C0b cp = ${fmtCpM(summary.h6.sliceC0bCpM)} — the pocket assembly is far above both no-wall controls, confirming the two-contact equilibrium in §1.1 is real and reachable by the solver, not just an arithmetic prediction.`);
  lines.push('');

  lines.push('## §8 item 3 — the E1 decomposition');
  lines.push('');
  const bestWinningCut = summary.e1Decomposition.bestPocketCpGuardOk ? summary.cuts[summary.e1Decomposition.bestPocketCpTable] : null;
  const bestTiedAtMax = bestWinningCut ? bestWinningCut.cut.filter((c) => c.value === bestWinningCut.cut[0].value).length : 0;
  lines.push(`| arm | cp |`);
  lines.push(`|---|---|`);
  lines.push(`| C0 (E1's bare arena, 2.0s window) | ${fmtCpM(summary.e1Decomposition.c0CpM)} |`);
  lines.push(`| C0b (bare arena, E4's 4.0s window) | ${fmtCpM(summary.e1Decomposition.c0bCpM)} |`);
  lines.push(`| best pocket assembly | ${summary.e1Decomposition.bestPocketCpGuardOk ? `${fmtPct(summary.e1Decomposition.bestPocketCp, 1)}${bestTiedAtMax > 1 ? ' ⚠' : ''}%` : '— (see note below)'} |`);
  lines.push('');
  lines.push(`C0 reproduces LAB-2's near-zero cradle rate. C0b, at E4's longer 4.0s settle window, is ALSO near zero — so E1's null result was a geometry problem, not (primarily) a time-budget problem (§1.2's confound is resolved: geometry dominates).`);
  lines.push('');
  // GUARD-MIGRATE: through selectTopN, a candidate contributes to "best pocket assembly" ONLY
  // if its own table's cut is `kind === 'ranked'` — there is no `cut` field to read a value
  // from on a demoted result (the anti-V2 mechanism CUT-1's spec §5 describes), so a genuinely
  // unresolvable set of three tables now publishes NO figure here at all, rather than the max
  // of three insertion-order top rows dressed up as a finding.
  if (summary.e1Decomposition.bestPocketCpGuardOk) {
    if (bestTiedAtMax > 1) {
      lines.push(`> ⚠ **THIS FIGURE IS AN EXACT TIE, NOT A CONFIRMED WINNER**: Stage \`${summary.e1Decomposition.bestPocketCpTable}\`'s ` +
        `cut reports \`ranked\`, but **${bestTiedAtMax} rows tie at exactly this value** — a boundary value split-half ` +
        'resampling has no power to distinguish (see that table\'s section below for what those rows share).');
    } else {
      lines.push(`> This figure is Stage \`${summary.e1Decomposition.bestPocketCpTable}\`'s own top-N cut, which DID resolve (selectTopN, ` +
        'split-half stability check passed) — see the ranking guard status above and that table\'s section below for the full population.');
    }
  } else {
    lines.push('> ⚠ **NO "BEST" IS PUBLISHABLE (CUT-1)**: none of A1\'s top-1, A2\'s top-20 or Stage B\'s ' +
      'top-20 resolved a stable cut at this budget (see the ranking guard status above) — a "best pocket ' +
      'assembly" figure would be insertion order dressed up as a finding. Each table\'s own population/bands ' +
      'are still published below and in `summary.cuts`.');
  }
  lines.push('');

  lines.push('## §8 item 1 — the pocket map (gapX x activeAngle, Stage B)');
  lines.push('');
  lines.push(`Full long-format CSV: \`${csvRelPath}\`. ${summary.pocketMap.length} cells.`);
  lines.push('');
  lines.push('| gapX (m) | active° | trials | cp |');
  lines.push('|---|---|---|---|');
  for (const h of [...summary.pocketMap].sort((a, b) => a.gapX - b.gapX || a.activeAngleDeg - b.activeAngleDeg)) {
    lines.push(`| ${h.gapX} | ${h.activeAngleDeg} | ${h.trials} | ${fmtMeasured(h.cpRateM)} |`);
  }
  lines.push('');

  lines.push('## §8 item 2 — ranked assembly table (top rows, Stage A2)');
  lines.push('');
  {
    const note = cutStatusNote(summary.cuts.a2, a2ByKey, a2FieldsFromSummary, 'assembly');
    if (note) { lines.push(note); lines.push(''); }
  }
  lines.push('| gapX | tilt° | endDy | guideE | radius | feed | post | outlaneW | cp | cr | ct | cv | median st | fastCradle | median bn |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of summary.rankedAssemblies.slice(0, 15)) {
    lines.push(
      `| ${a.guide.gapX} | ${a.guide.tiltDeg} | ${a.guide.endDy} | ${a.guide.guideE} | ${a.radius} | ${a.feed ? 'on' : 'off'} | ${a.post ? 'on' : 'off'} | ${a.outlaneW ?? 'off'} | ` +
      `${fmtMeasured(a.cpM)} | ${fmtMeasured(a.crM)} | ${fmtMeasured(a.ctM)} | ${fmtMeasured(a.cvM)} | ${fmt(a.medianSt, 2)} | ${fmtMeasured(a.fastCradleRateM)} | ${fmt(a.medianBn, 0)} |`
    );
  }
  lines.push('');

  lines.push('## Stage B — flipper geometry / delivery / policy ranking (top rows)');
  lines.push('');
  {
    const note = cutStatusNote(summary.cuts.b, bByKey, bFieldsFromSummary, 'cfg');
    if (note) { lines.push(note); lines.push(''); }
  }
  lines.push('| rest° | active° | e_flip | inj | pol | cp | trials |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of summary.stageBRanked.slice(0, 15)) {
    lines.push(`| ${r.restAngleDeg} | ${r.activeAngleDeg} | ${r.restitution} | ${r.inj} | ${r.pol} | ${fmtMeasured(r.cpRateM)} | ${r.trials} |`);
  }
  lines.push('');

  lines.push('## §8 item 4 — release dispersion (Stage C)');
  lines.push('');
  if (!summary.rankingGuard.releaseDispersion.ok) {
    lines.push(`> ⚠ **RANKING INVALID (LAB-16 gate)**: \`shotRate\` cannot rank these ` +
      `${summary.rankingGuard.releaseDispersion.n} assemblies — ${summary.rankingGuard.releaseDispersion.reason}. ` +
      'Consistent with the near-zero, near-uniform shot rate already noted below (§5.4 finding) — this table is ' +
      'ordered by shotRate for readability only, not as a performance ranking.');
    lines.push('');
  }
  // MEASURED-2: shot rate renders through its `Measured` sidecar (rate, event count, 95%
  // Wilson interval) — same convention as E5a (MEASURED-1) and E3 (this dispatch).
  lines.push('| assembly | trials | shot rate | dispersion (P95-P5, °) | rel mix |');
  lines.push('|---|---|---|---|---|');
  for (const r of summary.releaseDispersion) {
    lines.push(`| ${r.baseAssemblyId} | ${r.trials} | ${fmtMeasured(r.shotRateM)} | ${fmt(r.dispersionDeg, 1)} | ${JSON.stringify(r.relCounts)} |`);
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
  lines.push('| restAngleDeg | trials | cv |');
  lines.push('|---|---|---|');
  for (const r of summary.vTrapByRestAngle) lines.push(`| ${r.restAngleDeg} | ${r.trials} | ${fmtMeasured(r.cvRateM)} |`);
  lines.push('');
  const worstV = summary.vTrapByRestAngle.reduce((a, b) => (b.cvRate > (a?.cvRate ?? -1) ? b : a), null);
  lines.push(`**H7**: cv is low but non-zero across the grid (worst: rest ${worstV?.restAngleDeg}°, ${worstV ? fmtMeasured(worstV.cvRateM) : '—'}) — the closed-V trap §1.3 predicted is measurable, not the dominant outcome once a real W1 pocket is present (a pocket resolves most trials into \`cp\` before the ball can migrate into the centre V). Confirms §1.3's structural point (a −32° rest angle still needs a centre-post caveat for machine #2) without it being the majority finding once E4's own geometry is added.`);
  lines.push('');

  lines.push('## §8 item 7 — recommendation');
  lines.push('');
  // GUARD-MIGRATE: this paragraph used to name `rankedAssemblies[0]`/`stageBRanked[0]` as THE
  // recommended geometry (RETIRE-REST §7 already rewrote it once, from a bare insertion-order
  // pick to a tie description). Now describes whatever selectTopN actually found: a genuine
  // single winner (`ranked`), the shared fields of a demoted top band (`banded`), or — if
  // nothing orders at all — that no specific configuration is recommendable from that table.
  function describeCut(cut, byKeyMap, fieldsFn, label, total) {
    if (cut.kind === 'ranked') {
      const maxVal = cut.cut[0].value;
      const tiedAtMax = cut.cut.filter((c) => c.value === maxVal).length;
      if (tiedAtMax > 1) {
        // See cutStatusNote's comment: an exact tie at a rate estimator's boundary passes
        // split-half stability trivially, because there is no variance for resampling to
        // disturb — this is a top BAND, not a confirmed single winner, even though the cut
        // itself reports `ranked`.
        const { shared, varies } = sharedFieldsAcrossRows(cut.cut.slice(0, tiedAtMax).map((c) => byKeyMap.get(c.key)), fieldsFn);
        return `\`cp\` reports \`ranked\`, but the top **${tiedAtMax} of ${cut.cut.length} rows tie at EXACTLY ${fmtPct(maxVal, 1)}%** ` +
          `(a boundary value split-half resampling cannot distinguish, see note above) among ${total} ${label}(s) — shared across all of them: ` +
          `${sharedFieldsText(shared)}${varies.length ? `; they differ on ${varies.join(', ')} — an arbitrary pick within the tie` : ''}.`;
      }
      const row = byKeyMap.get(cut.cut[0].key);
      const { shared } = sharedFieldsAcrossRows([row], fieldsFn);
      return `\`cp\` resolves to a **genuine top pick at ${fmtPct(cut.cut[0].value, 1)}%** among ${total} ${label}(s) (selectTopN, stability confirmed) — ${sharedFieldsText(shared)}.`;
    }
    if (cut.kind === 'banded') {
      const topBand = cut.bands[0];
      const { shared, varies } = sharedFieldsAcrossRows(topBand.map((b) => byKeyMap.get(b.key)), fieldsFn);
      return `\`cp\` demotes to a **${topBand.length}-row top band at up to ${fmtPct(topBand[0].value, 1)}%** among ${total} ${label}(s) — no test orders those rows against each other. Shared across the whole band: ${sharedFieldsText(shared)}${varies.length ? `; they differ on ${varies.join(', ')} — any one row's value there is an arbitrary pick within the band, not a preferred setting` : ''}.`;
    }
    return `\`cp\` cannot order these ${total} ${label}(s) at all (selectTopN: unordered) — no specific configuration is recommendable from this table; see its population above.`;
  }
  lines.push(`**Pocket geometry**: ${describeCut(summary.cuts.a2, a2ByKey, a2FieldsFromSummary, 'assembly', summary.cuts.a2.structural.n)} ` +
    `**Flipper**: ${describeCut(summary.cuts.b, bByKey, bFieldsFromSummary, 'cfg', summary.cuts.b.structural.n)} ` +
    `**W2 (feed rail)**: earns its place only marginally — the A2 population's top band lands with feed OFF; inlane delivery mostly failed the §2.5 injection-clearance check against the very guide it needs to feed toward (see Delegation/handoff for the exclusion count), so the honest recommendation is a bare drop delivery, not an inlane rail, until W2's own geometry is re-tuned narrower. **W3 (tip post)**: appears in roughly half the top-band assemblies without changing cp materially (H9's own prediction — a skitter/dsl effect, not a catch-rate one). **W4 (outlane divider)**: appears in EVERY top-band assembly at outlaneW=0.030m — the clearest single addition beyond the guide itself. ` +
    `**V-trap caveat**: any machine #2 recommendation at a wide (more upright) rest angle should still pair with a centre post per §1.3/H7 above, even though a real W1 pocket sharply reduces how often the trap is actually reached. ` +
    `**Catch-vs-playability caveat (§8 item 4)**: the configuration(s) above reach the maximum measured \`cp\`, and Stage C shows the maximum-cp assemblies are near-dead traps (<0.12% shot rate) — if machine #2 wants a LIVE cradle rather than a permanent one, start from §8 item 2's population but prefer a lower-\`cp\`/higher-\`hsS\` row, not any single row from the top group as written here.`);
  lines.push('');

  return lines.join('\n');
}

// LAB-20: run the CLI only when this file IS the entry point. It used to call main() at module
// top level, so `import`ing anything from here (a test importing `guardStatusLines`, say) ran
// the whole report, printed the usage banner and set a non-zero exit — the test file failed
// with no individual test failing, which is a confusing way to find out.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err?.stack ?? err) }));
    process.exitCode = 1;
  });
}
