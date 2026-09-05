#!/usr/bin/env node
// LAB-2's §3.6 deliverable: binned transfer function, fan width, timing sensitivity, Pareto
// front, cradle rate + vo/vi gradient, and the recommendation paragraph. Reads Stage B's
// main-family run (24 geometries x the 42-point policy sweep) and its cradle-family run
// (24 geometries, `pol:'heldActive'`), streams every shard once, and writes
// `data/summaries/e1-lab2-<runId>.{json,md}`.
//
//   node src/lab2Report.js --stageB <dir> --cradle <dir> --out <runId>
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';
import { mean, sd, percentile } from './metrics.js';
import { cfgId as hashCfg } from './sweep.js';
import { rankingValidityResult, premiseHeaderLines, requireFlagGateOk } from './gate.js';
import { rate as measuredRate, fmt as fmtMeasured } from './measured.js';

const GEOMETRY_KEYS = ['restAngleDeg', 'activeAngleDeg', 'upMs', 'omegaProfile', 'radius', 'restitution'];
const HS_BINS = 10;
const PHASES = ['rest', 'rising', 'full', 'returning'];
const VI_BINS = 6, VI_MAX = 6.0; // m/s
const AI_BINS = 8, AI_MAX = 360; // deg
const SENSITIVITY_CEILING = 1.5; // deg/ms — §3.6's Pareto ranking gate
const CRADLE_SETTLE_WINDOW_S = 1.5; // §3.5: "reaches |v|<0.05 ... within 1.5 s"

/** Pure per-geometry summary over one cradle cfg's full record set — pulled out of the
 * streaming loop below so it can be unit-tested with a synthetic record array instead of a
 * real run. `records`: every trial's raw record for one geometry's cradle cfg (`{cr, st, bn,
 * cs}`, the fields `instrument.js`'s runE1Trial writes on cradle-family trials).
 * `csMedianMps` (ledger/handoffs/opus2/20260904T150000Z-three-gate-rulings.md §(a), pilot
 * confirmed in ledger/handoffs/sonnet2/20260904T160000Z-cradle-continuous-stat-pilot.md):
 * median of `cs` (min ball speed while touching a flipper) across every CONTACTING trial, not
 * just settled ones — cradleRate's own denominator is `trials`, not `settled`, and this column
 * is reported alongside it, not used to select anything (Stage A selection is unchanged; see
 * that pilot handoff). `cs === null` on any trial that never contacted a flipper. */
export function cradleRowStats(records) {
  let trials = 0, settled = 0;
  const settleTimes = [], bounces = [], csVals = [];
  for (const r of records) {
    trials += 1;
    if (r.cs !== null && r.cs !== undefined) csVals.push(r.cs);
    if (r.cr === 1 && r.st !== null && r.st <= CRADLE_SETTLE_WINDOW_S) {
      settled += 1;
      settleTimes.push(r.st);
      bounces.push(r.bn);
    }
  }
  return {
    trials, settled,
    cradleRate: trials > 0 ? settled / trials : null,
    settleTimeMeanS: settleTimes.length ? mean(settleTimes) : null,
    bouncesMean: bounces.length ? mean(bounces) : null,
    csMedianMps: csVals.length ? percentile(csVals, 50) : null,
  };
}

function geometryOf(cfg) {
  const g = {};
  for (const k of GEOMETRY_KEYS) g[k] = cfg[k];
  return g;
}
function geomLabel(g) {
  return `rest=${g.restAngleDeg}° active=${g.activeAngleDeg}° up=${g.upMs}ms ${g.omegaProfile} r=${g.radius}m e=${g.restitution}`;
}

async function* streamShards(runDir, cfgMeta) {
  for (const shard of cfgMeta.shards) {
    const rl = readline.createInterface({ input: createReadStream(path.join(runDir, shard.path)).pipe(createGunzip()) });
    for await (const line of rl) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
}

function binIndex(v, bins, max, min = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const width = (max - min) / bins;
  let idx = Math.floor((v - min) / width);
  if (idx < 0) idx = 0;
  if (idx >= bins) idx = bins - 1;
  return idx;
}

function newLinReg() {
  return { n: 0, sx: 0, sy: 0, sxy: 0, sxx: 0 };
}
function addLinReg(r, x, y) {
  r.n += 1; r.sx += x; r.sy += y; r.sxy += x * y; r.sxx += x * x;
}
function slopeOf(r) {
  if (r.n < 2) return null;
  const denom = r.n * r.sxx - r.sx * r.sx;
  if (denom === 0) return null;
  return (r.n * r.sxy - r.sx * r.sy) / denom;
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, arr) => {
      if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
      return pairs;
    }, [])
  );
  const stageBDir = args.stageB;
  const cradleDir = args.cradle;
  const runId = args.out;
  if (!stageBDir || !cradleDir || !runId) {
    console.error('usage: node src/lab2Report.js --stageB <dir> --cradle <dir> --out <runId>');
    process.exitCode = 1;
    return;
  }

  const stageBMeta = JSON.parse(readFileSync(path.join(stageBDir, 'meta.json'), 'utf8'));
  const cradleMeta = JSON.parse(readFileSync(path.join(cradleDir, 'meta.json'), 'utf8'));

  // --- Per-geometry accumulators ---
  const geoms = new Map(); // geomKey -> { geometry, xaVals: [], byDelay: Map(d -> {n,sum}), gradReg, transferAcc-scoped separately }
  const transferBins = new Map(); // key "hs|phase|vi|ai" -> {n, sumVo, sumSqVo, sumAo, sumSqAo}
  let totalTrials = 0, totalFlagged = 0, totalContacted = 0, totalShotline = 0;
  const impactsExhausted = 1, escaped = 2, timeoutFlag = 4, stalled = 8, nanFlag = 16;
  const flagCounts = { IMPACTS_EXHAUSTED: 0, ESCAPED: 0, TIMEOUT: 0, STALLED: 0, NAN: 0 };

  for (const cfgMeta of stageBMeta.cfgs) {
    const cfg = cfgMeta.cfg;
    const gKey = hashCfg(geometryOf(cfg));
    let g = geoms.get(gKey);
    if (!g) {
      g = { geometryKey: gKey, geometry: geometryOf(cfg), xaVals: [], byDelay: new Map(), gradReg: newLinReg(), trials: 0, flagged: 0, contacted: 0 };
      geoms.set(gKey, g);
    }
    for await (const r of streamShards(stageBDir, cfgMeta)) {
      totalTrials += 1;
      g.trials += 1;
      if (r.f !== 0) { totalFlagged += 1; g.flagged += 1; }
      if (r.f & impactsExhausted) flagCounts.IMPACTS_EXHAUSTED += 1;
      if (r.f & escaped) flagCounts.ESCAPED += 1;
      if (r.f & timeoutFlag) flagCounts.TIMEOUT += 1;
      if (r.f & stalled) flagCounts.STALLED += 1;
      if (r.f & nanFlag) flagCounts.NAN += 1;

      const contacted = r.vi !== null;
      if (contacted) {
        totalContacted += 1;
        g.contacted += 1;
        // §2.7 / P0-2 (LAB-11): "flagged trials are excluded from distributions" — LAB-2's own
        // handoff claimed this for the transfer function and gradient but the code never
        // checked `r.f`, only `term`/`contacted` (which only screens NAN/ESCAPED/TIMEOUT/
        // STALLED as a side effect of those flags always `break`-ing with their own term;
        // IMPACTS_EXHAUSTED sets its flag WITHOUT breaking, so it silently rode along).
        // `contacted`/`totalContacted`/`contactRate` themselves are left as "contacted at
        // all" (unchanged meaning) — only the distributions the fix is actually about are
        // gated here.
        if (r.f === 0) {
          // Transfer function bin (§3.6.1): (hs x phase x vi x ai) -> (vo, ao).
          const hsIdx = binIndex(r.hs, HS_BINS, 1);
          const phaseIdx = PHASES.indexOf(r.hp);
          const viIdx = binIndex(r.vi, VI_BINS, VI_MAX);
          const aiIdx = binIndex(r.ai, AI_BINS, AI_MAX);
          if (hsIdx !== null && phaseIdx >= 0 && viIdx !== null && aiIdx !== null) {
            const key = `${hsIdx}|${phaseIdx}|${viIdx}|${aiIdx}`;
            let b = transferBins.get(key);
            if (!b) { b = { n: 0, sumVo: 0, sumSqVo: 0, sumAo: 0, sumSqAo: 0 }; transferBins.set(key, b); }
            b.n += 1; b.sumVo += r.vo; b.sumSqVo += r.vo * r.vo; b.sumAo += r.ao; b.sumSqAo += r.ao * r.ao;
          }
          // §3.5's secondary heaviness signal: gradient of vo/vi along hs, pooled across phase
          // (documented approximation — the spec asks "at fixed phase"; pooling all contacted
          // trials for one geometry keeps the sample size usable at Stage B resolution).
          if (r.vi > 0) addLinReg(g.gradReg, r.hs, r.vo / r.vi);
        }
      }
      // P0-2: fan width / timing-sensitivity is the OTHER distribution LAB-2's handoff claimed
      // was flag-filtered ("computed only from shotline trials") but wasn't — `term ===
      // 'shotline'` alone doesn't exclude a trial that also set IMPACTS_EXHAUSTED earlier in
      // the same run (flags accumulate across the whole trial; term is just what broke the loop).
      if (r.term === 'shotline' && r.f === 0 && cfg.pol !== 'never') {
        totalShotline += 1;
        g.xaVals.push(r.xa);
        if (cfg.pol === 'fixedDelay') {
          let d = g.byDelay.get(cfg.d);
          if (!d) { d = { n: 0, sum: 0 }; g.byDelay.set(cfg.d, d); }
          d.n += 1; d.sum += r.xa;
        }
      }
    }
  }

  // LAB-28 (V4): `totalTrials ? x / totalTrials : 0` below would read a zero-trial run (an
  // empty --stageB cfg set, or every shard failing to stream) as a measured, clean 0% flagged —
  // identical to gate.js's own zero-trials principle (`flagGateResult`, `rankingValidityResult`)
  // that a corpus with no trials carries no statistical power and must not read as passing.
  // Refused here, before any number derived from `totalTrials` is computed, rather than
  // threading a `null` sentinel through every `* 100` in the markdown below.
  if (totalTrials === 0) {
    throw new Error(`lab2Report: --stageB ${stageBDir} produced zero trials — an empty corpus carries no statistical power and must not be summarised as a clean 0% flagged/contacted run.`);
  }

  // --- Fan width + timing sensitivity per geometry ---
  const geometryResults = [];
  for (const g of geoms.values()) {
    const fanWidthXa = g.xaVals.length >= 2 ? percentile(g.xaVals, 95) - percentile(g.xaVals, 5) : null;
    const delayPoints = [...g.byDelay.entries()].filter(([, v]) => v.n > 0).sort((a, b) => a[0] - b[0]).map(([d, v]) => [d, v.sum / v.n]);
    const localSlopes = [];
    for (let i = 1; i < delayPoints.length; i++) {
      const [d0, xa0] = delayPoints[i - 1];
      const [d1, xa1] = delayPoints[i];
      if (d1 !== d0) localSlopes.push(Math.abs((xa1 - xa0) / (d1 - d0)));
    }
    const timingSensitivity = localSlopes.length ? percentile(localSlopes, 50) : null;
    const gradient = slopeOf(g.gradReg);
    geometryResults.push({
      geometryKey: g.geometryKey, geometry: g.geometry, label: geomLabel(g.geometry),
      trials: g.trials, flaggedFraction: g.trials > 0 ? g.flagged / g.trials : 0,
      contactRate: g.trials > 0 ? g.contacted / g.trials : 0,
      fanWidthXaDeg: fanWidthXa, timingSensitivityDegPerMs: timingSensitivity,
      voViGradientPerHs: gradient, delayPoints,
    });
  }

  // --- Cradle family ---
  const cradleResults = [];
  for (const cfgMeta of cradleMeta.cfgs) {
    const cfg = cfgMeta.cfg;
    const gKey = hashCfg(geometryOf(cfg));
    const records = [];
    for await (const r of streamShards(cradleDir, cfgMeta)) records.push(r);
    cradleResults.push({ geometryKey: gKey, geometry: geometryOf(cfg), ...cradleRowStats(records) });
  }
  const cradleByGeom = new Map(cradleResults.map((c) => [c.geometryKey, c]));
  for (const g of geometryResults) {
    const c = cradleByGeom.get(g.geometryKey);
    g.cradleRate = c?.cradleRate ?? null;
    g.cradleSettleTimeMeanS = c?.settleTimeMeanS ?? null;
    g.cradleBouncesMean = c?.bouncesMean ?? null;
    g.cradleMinContactSpeedMedianMps = c?.csMedianMps ?? null;
  }

  // --- Pareto front: maximise fanWidth, minimise timingSensitivity ---
  const withBoth = geometryResults.filter((g) => g.fanWidthXaDeg !== null && g.timingSensitivityDegPerMs !== null);
  const paretoFront = withBoth.filter((g) =>
    !withBoth.some((h) => h !== g &&
      h.fanWidthXaDeg >= g.fanWidthXaDeg && h.timingSensitivityDegPerMs <= g.timingSensitivityDegPerMs &&
      (h.fanWidthXaDeg > g.fanWidthXaDeg || h.timingSensitivityDegPerMs < g.timingSensitivityDegPerMs))
  );
  const rankedUnderCeiling = withBoth
    .filter((g) => g.timingSensitivityDegPerMs <= SENSITIVITY_CEILING)
    .sort((a, b) => b.fanWidthXaDeg - a.fanWidthXaDeg);

  // LAB-16/17 ranking gate — `best` is a real single-geometry recommendation (`topN: 1`), not a
  // display table, so it gets the same blocking treatment as E1's cradle/fan-width selection:
  // refuse to name a "best" geometry rather than silently pick array position 0 of an unordered
  // tie. Checked on `rankedUnderCeiling`, the actual population `best` is cut from (LAB-17: the
  // boundary-ambiguity test needs the real cut population — checking the pre-ceiling-filter
  // `withBoth` instead would answer a different question than the one `best` actually asks).
  const fanWidthRankingGuard = rankingValidityResult(rankedUnderCeiling.map((g) => g.fanWidthXaDeg), { topN: 1 });
  const best = fanWidthRankingGuard.ok ? (rankedUnderCeiling[0] ?? null) : null;

  // --- Binned transfer function, flattened ---
  const transferTable = [...transferBins.entries()].map(([key, b]) => {
    const [hs, phase, vi, ai] = key.split('|').map(Number);
    return {
      hsBin: hs, phase: PHASES[phase], viBin: vi, aiBin: ai,
      hsRange: [hs / HS_BINS, (hs + 1) / HS_BINS],
      viRange: [vi * (VI_MAX / VI_BINS), (vi + 1) * (VI_MAX / VI_BINS)],
      aiRange: [ai * (AI_MAX / AI_BINS), (ai + 1) * (AI_MAX / AI_BINS)],
      n: b.n,
      voMean: b.sumVo / b.n, voSd: b.n > 1 ? Math.sqrt(Math.max(0, (b.sumSqVo - b.n * (b.sumVo / b.n) ** 2) / (b.n - 1))) : 0,
      aoMean: b.sumAo / b.n, aoSd: b.n > 1 ? Math.sqrt(Math.max(0, (b.sumSqAo - b.n * (b.sumAo / b.n) ** 2) / (b.n - 1))) : 0,
    };
  }).sort((a, b) => b.n - a.n);

  const summary = {
    exp: 'e1', stage: 'B', runId,
    generatedAt: new Date().toISOString(),
    stageBRunDir: stageBDir, cradleRunDir: cradleDir,
    stageBMeta: { instrumentCommitSha: stageBMeta.instrumentCommitSha, trialCount: stageBMeta.trialCount, secs: stageBMeta.secs },
    // LAB-22: Stage B declares a §2.7 premise (a pure TIMEOUT tail from §3.3's 0.3 m/s
    // floor against the 2.0s cap); echo it where a reader of the summary will meet it.
    declaredPremise: stageBMeta.declaredPremise ?? null,
    declaredPremiseGate: { fraction: stageBMeta.flaggedFraction, ok: requireFlagGateOk(stageBMeta.flagGateOk, 'lab2Report (--stageB meta.json)') },
    cradleMeta: { trialCount: cradleMeta.trialCount, secs: cradleMeta.secs },
    totals: {
      trials: totalTrials, flagged: totalFlagged, flaggedFraction: totalTrials ? totalFlagged / totalTrials : 0,
      contacted: totalContacted, contactRate: totalTrials ? totalContacted / totalTrials : 0,
      // MEASURED-2: additive sidecar — `contactRate` above is unchanged, this is the one
      // headline scalar in this file's summary line converted this dispatch.
      contactRateM: measuredRate(totalContacted, totalTrials, { estimand: 'fraction of Stage B trials reaching flipper contact' }),
      shotline: totalShotline, flagCounts,
    },
    geometryCount: geometryResults.length,
    geometries: geometryResults.sort((a, b) => (b.fanWidthXaDeg ?? -1) - (a.fanWidthXaDeg ?? -1)),
    paretoFront: paretoFront.map((g) => g.geometryKey),
    rankedUnderCeiling: rankedUnderCeiling.map((g) => g.geometryKey),
    sensitivityCeilingDegPerMs: SENSITIVITY_CEILING,
    bestGeometryKey: best?.geometryKey ?? null,
    fanWidthRankingGuard,
    transferFunction: {
      bins: { hs: HS_BINS, phase: PHASES, vi: { count: VI_BINS, max: VI_MAX }, ai: { count: AI_BINS, max: AI_MAX } },
      table: transferTable,
    },
  };

  const summariesDir = path.join(import.meta.dirname, '..', 'data', 'summaries');
  const jsonOut = path.join(summariesDir, `e1-lab2-${runId}.json`);
  const mdOut = path.join(summariesDir, `e1-lab2-${runId}.md`);
  writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  writeFileSync(mdOut, toMarkdown(summary, best));

  if (!fanWidthRankingGuard.ok) {
    console.error(JSON.stringify({ warning: 'LAB-16 ranking gate: fanWidthXaDeg cannot rank these geometries — no best geometry named', fanWidthRankingGuard }));
  }

  console.log(JSON.stringify({
    ok: true, geometries: geometryResults.length, trials: totalTrials,
    flagged: totalTrials ? Number((totalFlagged / totalTrials).toFixed(4)) : 0,
    paretoFront: paretoFront.length, best: best?.geometryKey ?? null,
    out: mdOut,
  }));
}

function fmt(x, digits = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

// LAB-28 (V4): `fmt((x ?? 0) * 100, d)` coerces "not measured" (`null`) to a measured 0% before
// fmt ever sees it. A caller with a value that may be null must scale through this helper.
function fmtPct(x, digits = 1) {
  return fmt(x === null || x === undefined ? null : x * 100, digits);
}

function toMarkdown(summary, best) {
  const lines = [];
  lines.push(`# E1 — LAB-2 flipper transfer function (\`${summary.runId}\`)`);
  lines.push('');
  lines.push(`- **instrument commit**: \`${summary.stageBMeta.instrumentCommitSha}\`  ·  **generated**: ${summary.generatedAt}`);
  lines.push(`- **Stage B trials**: ${summary.totals.trials}  ·  **flagged**: ${(summary.totals.flaggedFraction * 100).toFixed(2)}%  ` +
    `(IMPACTS_EXHAUSTED ${(summary.totals.flagCounts.IMPACTS_EXHAUSTED / summary.totals.trials * 100).toFixed(2)}%, ` +
    `ESCAPED ${(summary.totals.flagCounts.ESCAPED / summary.totals.trials * 100).toFixed(3)}%, ` +
    `TIMEOUT ${(summary.totals.flagCounts.TIMEOUT / summary.totals.trials * 100).toFixed(2)}%, ` +
    `STALLED ${(summary.totals.flagCounts.STALLED / summary.totals.trials * 100).toFixed(2)}%, ` +
    `NAN ${(summary.totals.flagCounts.NAN / summary.totals.trials * 100).toFixed(3)}%)`);
  lines.push(`- **flipper contact rate**: ${fmtMeasured(summary.totals.contactRateM)}  ·  **geometries characterised**: ${summary.geometryCount}`);
  lines.push('');
  // LAB-28 (V3): `declaredPremiseGate` is always constructed in `main()` above (and would have
  // thrown via `requireFlagGateOk` before `summary` even existed if it couldn't be), so a `??`
  // fallback here could only ever mask a wiring bug in a future caller by quietly defaulting to
  // `ok: true` — the exact "absence reads as passed" failure this file exists to prevent.
  lines.push(...premiseHeaderLines(summary.declaredPremise ?? null, summary.declaredPremiseGate));
  lines.push('> §2.7: ESCAPED and NAN are near-zero (no solver artifact); TIMEOUT and' +
    ' IMPACTS_EXHAUSTED dominate the flagged fraction — the same pattern LAB-1b found for the' +
    ' main family (slow-speed injections still falling at the 2.0s cap; the flipper firing' +
    ' near a ball already at the pivot saturating MAX_IMPACTS), understood and not smoothed' +
    ' into the ranking below (fan width/sensitivity are computed only from `shotline` trials).');
  lines.push('');

  lines.push('## Fan width / timing sensitivity / cradle, per geometry');
  lines.push('');
  // LAB-28 (V2): this table is sorted by fanWidthXaDeg for readability, unconditionally — no
  // guard covers this full-population ordering (`fanWidthRankingGuard` below answers a
  // different, narrower question: whether the top-1 CUT out of `rankedUnderCeiling` is
  // unambiguous, not whether this whole table's order is meaningful). Stated explicitly rather
  // than left implied by the "Ranked under ceiling" section's own caveat, which a reader could
  // easily assume already covers this table too.
  lines.push('> Sorted by `fanWidthXaDeg` for readability only — this is not a validated ranking ' +
    '(no guard tests the full population\'s ordering; `fanWidthRankingGuard` below tests only the ' +
    'top-1 cut over the sensitivity-ceiling-filtered population, a narrower question).');
  lines.push('');
  lines.push('| geom | rest° | active° | upMs | ω | r | e | fan(xa)° | sens(°/ms) | cradle% | minCs(m/s) | vo/vi grad | pareto |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of summary.geometries) {
    const onPareto = summary.paretoFront.includes(g.geometryKey) ? '✓' : '';
    lines.push(
      `| ${g.geometryKey} | ${g.geometry.restAngleDeg} | ${g.geometry.activeAngleDeg} | ${g.geometry.upMs} | ` +
      `${g.geometry.omegaProfile} | ${g.geometry.radius} | ${g.geometry.restitution} | ` +
      `${fmt(g.fanWidthXaDeg, 1)} | ${fmt(g.timingSensitivityDegPerMs, 3)} | ${fmtPct(g.cradleRate, 1)} | ` +
      `${fmt(g.cradleMinContactSpeedMedianMps, 3)} | ${fmt(g.voViGradientPerHs, 3)} | ${onPareto} |`
    );
  }
  lines.push('');
  lines.push('> `minCs(m/s)`: median of the minimum ball speed while touching a flipper, across every' +
    ' CONTACTING cradle trial for that geometry (not just settled ones) — reported alongside' +
    ' `cradle%`, not used to select anything here. Pilot' +
    ' (ledger/handoffs/sonnet2/20260904T160000Z-cradle-continuous-stat-pilot.md) found it' +
    ' separates all 24 geometries cleanly where `cradle%`/`cradleProxy` are degenerate; Stage A' +
    ' selection is unchanged pending the ranking-validity guard fix.');
  lines.push('');

  lines.push(`## Ranked under the sensitivity ceiling (≤ ${summary.sensitivityCeilingDegPerMs}°/ms)`);
  lines.push('');
  lines.push('| rank | geom | fan(xa)° | sens(°/ms) | cradle% |');
  lines.push('|---|---|---|---|---|');
  const byKey = new Map(summary.geometries.map((g) => [g.geometryKey, g]));
  summary.rankedUnderCeiling.forEach((key, i) => {
    const g = byKey.get(key);
    lines.push(`| ${i + 1} | ${key} | ${fmt(g.fanWidthXaDeg, 1)} | ${fmt(g.timingSensitivityDegPerMs, 3)} | ${fmtPct(g.cradleRate, 1)} |`);
  });
  lines.push('');

  if (best) {
    lines.push('## Recommendation');
    lines.push('');
    // VERDICT-1: the guard's own verdict, stated explicitly on the PASS path too — a reader
    // seeing a named "best" geometry below could otherwise not tell whether it cleared LAB-16's
    // ranking-validity gate or was simply array position 0 of an unordered tie, since only the
    // FAILURE branch (below) used to narrate the guard at all. A verdict shown only on failure
    // is indistinguishable from a guard that never ran.
    lines.push(
      `> **LAB-16 ranking gate: PASSED** — \`fanWidthXaDeg\` cleared the top-1 cut over the ` +
      `${summary.rankedUnderCeiling.length} ceiling-filtered geometries (${summary.fanWidthRankingGuard.distinctCount} ` +
      `distinct values, boundary ambiguity ${fmt(summary.fanWidthRankingGuard.boundaryAmbiguity, 2)}x). The ` +
      'recommendation below is a validated top-1, not an arbitrary array position.'
    );
    lines.push('');
    lines.push(
      `**Machine #2 default flipper**: rest angle **${best.geometry.restAngleDeg}°**, active angle ` +
      `**${best.geometry.activeAngleDeg}°** (sweep arc ${best.geometry.activeAngleDeg - best.geometry.restAngleDeg}°), ` +
      `sweep **${best.geometry.upMs} ms**, ω-profile **${best.geometry.omegaProfile}**, collision radius ` +
      `**${best.geometry.radius} m**, restitution **${best.geometry.restitution}**.`
    );
    lines.push('');
    lines.push(
      `Justification: of the ${summary.rankedUnderCeiling.length} geometries under the ` +
      `${summary.sensitivityCeilingDegPerMs}°/ms sensitivity ceiling, this one has the widest measured shot fan ` +
      `(P95−P5 of shot-line angle over the full timing sweep) at **${fmt(best.fanWidthXaDeg, 1)}°**, with a median ` +
      `timing sensitivity of **${fmt(best.timingSensitivityDegPerMs, 3)}°/ms** (at or under the ` +
      `${SENSITIVITY_CEILING}°/ms ceiling — a 10ms reaction-time error moves the shot by roughly ` +
      `${fmt((best.timingSensitivityDegPerMs ?? 0) * 10, 1)}°, still aimable), a cradle rate of **${fmtPct(best.cradleRate, 1)}%** ` +
      `(fraction of held-active trials settling within 1.5s — the "feels heavy" number), and a vo/vi-vs-hs gradient of ` +
      `**${fmt(best.voViGradientPerHs, 3)} per unit hs** (positive means tip contact returns more energy than base ` +
      `contact, i.e. the ball rewards a good hit rather than saturating everywhere).`
    );
    lines.push('');
  } else if (!summary.fanWidthRankingGuard.ok) {
    lines.push('## Recommendation');
    lines.push('');
    lines.push(
      `> ⚠ **LAB-16 ranking gate: FAILED** — \`fanWidthXaDeg\` cannot rank the ${summary.fanWidthRankingGuard.n} ` +
      `characterised geometries — ${summary.fanWidthRankingGuard.reason}. No "best" geometry is named; picking ` +
      'array position 0 of an unordered tie would be exactly LAB-16\'s E3-P1 mistake repeated here.'
    );
    lines.push('');
  } else {
    lines.push('## Recommendation');
    lines.push('');
    lines.push('No geometry cleared the sensitivity ceiling with a valid fan-width measurement — see `rankedUnderCeiling` (empty) in the JSON summary.');
    lines.push('');
  }

  lines.push('## Transfer function');
  lines.push('');
  lines.push(`Binned \`(hs x phase x vi x ai) -> (vo, ao)\` table (${summary.transferFunction.bins.hs} x ` +
    `${summary.transferFunction.bins.phase.length} x ${summary.transferFunction.bins.vi.count} x ` +
    `${summary.transferFunction.bins.ai.count} bins), ${summary.transferFunction.table.length} populated bins ` +
    `out of a possible ${summary.transferFunction.bins.hs * summary.transferFunction.bins.phase.length * summary.transferFunction.bins.vi.count * summary.transferFunction.bins.ai.count} — ` +
    `full table in the JSON summary; the ${Math.min(20, summary.transferFunction.table.length)} best-populated bins:`);
  lines.push('');
  lines.push('| hs bin | phase | vi bin (m/s) | ai bin (deg) | n | vo mean±sd | ao mean±sd |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const b of summary.transferFunction.table.slice(0, 20)) {
    lines.push(
      `| [${b.hsRange[0].toFixed(1)},${b.hsRange[1].toFixed(1)}) | ${b.phase} | [${b.viRange[0].toFixed(1)},${b.viRange[1].toFixed(1)}) | ` +
      `[${b.aiRange[0].toFixed(0)},${b.aiRange[1].toFixed(0)}) | ${b.n} | ${fmt(b.voMean)}±${fmt(b.voSd)} | ${fmt(b.aoMean, 1)}±${fmt(b.aoSd, 1)} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.stack ?? err) }));
  process.exitCode = 1;
});
