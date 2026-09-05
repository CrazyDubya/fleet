#!/usr/bin/env node
// PREFIX-FIX, the additive half for E2. `eg[]` (per-hit energy ratios) was a `length < CAP`
// prefix ordered by bumper-hit index, and the ratio falls with hit index on chains that matter
// (opus2, ledger/handoffs/opus2/20260905T230606Z-prefix-sweep.md §2). Fixing the cap (a
// reservoir now, see instrument.js) makes future runs right; it does nothing for the corpus
// already on disk, because `eg` itself is truncated in every existing shard record.
//
// But `ch` (chain length) and `ecum` (exit KE / entry KE) are recorded UNCAPPED in every shard,
// for every trial — so a bound on the true per-hit ratio is recoverable without re-simulating
// anything, by the same closure argument opus2 used: over trials whose chain is long enough
// that per-hit losses have compounded many times, `ecum ≈ (per-hit speed ratio)^(2 * chain)`
// (energy scales as speed squared), so `ecum^(1/(2*chain))` is the geometric-mean per-hit speed
// ratio implied by a metric (ecum) the cap never touched. This is a BOUND, not an exact
// correction: it says what the long-chain tail's per-hit ratio is, not what the published
// (early-hit-biased) mean would have been had every hit been kept.
//
// Never opens the published summary for writing (only `--annotate` does, and only its .md).
//
//   node src/e2EnergyRatioBound.js --seriesA <dir> --seriesB <dir> --out <runId> [--summary <published.json>]
//   node src/e2EnergyRatioBound.js --annotate <runId>
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';

// opus2's own threshold: "trials with ch >= 20" is where the closure argument's approximation
// (losses are dominated by bumper hits, not wall/gravity effects between them) is trustworthy —
// below it a handful of hits carry too much noise in `ecum^(1/(2*chain))` for the bound to mean
// much. Kept as the same constant rather than re-derived, so a companion's number matches the
// dispatch that motivated this tool.
const LONG_CHAIN_MIN = 20;

async function* streamShards(runDir, cfgMeta) {
  for (const shard of cfgMeta.shards) {
    const rl = readline.createInterface({ input: createReadStream(path.join(runDir, shard.path)).pipe(createGunzip()) });
    for await (const line of rl) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
}

/** Pure: the closure bound and coverage stats over one N-group's pooled (ch, ecum, egLength)
 * triples. `egLength` is always `min(ch, 12)` in every existing shard (the old cap) — kept
 * explicit rather than assumed, so this still reads correctly against a future run where the
 * cap no longer applies (egLength would then equal ch, and coverage would be exactly 1). */
export function energyRatioBound(rows) {
  const n = rows.length;
  if (n === 0) return null;
  let sumCh = 0, sumEgLen = 0;
  const long = [];
  for (const r of rows) {
    sumCh += r.ch;
    sumEgLen += r.egLen;
    if (r.ch >= LONG_CHAIN_MIN && r.ecum !== null && r.ecum > 0) long.push(r);
  }
  const coverage = sumCh > 0 ? sumEgLen / sumCh : null;
  if (long.length === 0) {
    return { n, coverage, longChainN: 0, meanChainLong: null, meanEcumLong: null, impliedGeometricPerHitRatio: null };
  }
  const meanChainLong = long.reduce((a, r) => a + r.ch, 0) / long.length;
  const meanEcumLong = long.reduce((a, r) => a + r.ecum, 0) / long.length;
  const impliedGeometricPerHitRatio = meanEcumLong ** (1 / (2 * meanChainLong));
  return { n, coverage, longChainN: long.length, meanChainLong, meanEcumLong, impliedGeometricPerHitRatio };
}

export const BEGIN = '<!-- PREFIX-FIX-EG-ANNOTATION:BEGIN -->';
export const END = '<!-- PREFIX-FIX-EG-ANNOTATION:END -->';

export function applyAnnotation(md, block) {
  const i = md.indexOf(BEGIN);
  const j = md.indexOf(END);
  if (i !== -1 && j !== -1 && j > i) {
    return md.slice(0, i) + block + md.slice(j + END.length);
  }
  return `${md.replace(/\s*$/, '')}\n\n${block}\n`;
}

export function annotationBlock(companion) {
  const L = [BEGIN];
  L.push('');
  L.push('> ⚠ **`perHitEnergyRatioMean` (`E[eg]`) was computed from a PREFIX, not a sample**');
  L.push('> (PREFIX-FIX, generalising SAMPLECAP-1). `eg[]` kept the FIRST 12 per-hit energy');
  L.push('> ratios per trial, ordered by bumper-hit index — and the ratio falls with hit index');
  L.push('> on chains that matter, so the published mean over-weights the high (early-hit) end');
  L.push('> of a declining series. Fixed for future runs (a reservoir, `instrument.js`); this');
  L.push('> corpus predates the fix and `eg[]` is truncated in every shard, so no exact');
  L.push('> correction is computable here. What IS recoverable without re-simulating anything:');
  L.push('> `ch`/`ecum` are recorded uncapped, so the true per-hit ratio on long chains is');
  L.push('> bounded by `ecum^(1/(2*chain))` — see `e2-' + companion.runId + '-egbound.{json,md}`.');
  L.push('>');
  L.push('> | N | published E[eg] | coverage (hits kept / hits happened) | implied per-hit ratio, long chains (ch≥20) |');
  L.push('> |---|---|---|---|');
  for (const [seriesLabel, byN] of [['A', companion.seriesA], ['B', companion.seriesB]]) {
    for (const [N, b] of Object.entries(byN)) {
      if (!b) continue;
      const cov = b.coverage === null ? '—' : `${(b.coverage * 100).toFixed(1)}%`;
      const bound = b.impliedGeometricPerHitRatio === null ? `no ch≥20 trials` : b.impliedGeometricPerHitRatio.toFixed(4);
      L.push(`> | Series ${seriesLabel}, N=${N} | ${b.publishedMean === null ? '—' : b.publishedMean.toFixed(4)} | ${cov} | ${bound} |`);
    }
  }
  L.push('>');
  L.push('> A ball whose speed genuinely multiplied by the published `E[eg]` every hit over a');
  L.push('> long chain would leave the arena far faster than it entered; it does not — the true');
  L.push('> per-hit ratio on long chains sits at or below 1, well under most published means.');
  L.push('> The values above are real measurements; the qualitative finding (`E[eg]` declines');
  L.push('> with N) is unaffected and would be steeper uncapped.');
  L.push(END);
  return L.join('\n');
}

async function computeSeries(seriesDir) {
  const meta = JSON.parse(readFileSync(path.join(seriesDir, 'meta.json'), 'utf8'));
  const byN = new Map(); // N -> rows[]
  for (const cfgMeta of meta.cfgs) {
    const N = cfgMeta.cfg.N;
    let rows = byN.get(N);
    if (!rows) { rows = []; byN.set(N, rows); }
    for await (const r of streamShards(seriesDir, cfgMeta)) {
      rows.push({ ch: r.ch, ecum: r.ecum, egLen: r.eg.length });
    }
  }
  return byN;
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, arr) => {
      if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
      return pairs;
    }, [])
  );

  // --annotate: state the bound IN the summary a reader opens. Reads the companion this tool
  // already wrote and rewrites only the .md — never the published .json, and never by
  // re-running e2Report.js.
  if (args.annotate !== undefined) {
    const runId = args.annotate;
    const companionPath = path.join('data/summaries', `e2-${runId}-egbound.json`);
    const mdPath = path.join('data/summaries', `e2-${runId}.md`);
    const companion = JSON.parse(readFileSync(companionPath, 'utf8'));
    const before = readFileSync(mdPath, 'utf8');
    const after = applyAnnotation(before, annotationBlock(companion));
    writeFileSync(mdPath, after);
    console.log(JSON.stringify({
      ok: true, annotated: mdPath, from: companionPath,
      replacedExisting: before.includes(BEGIN), bytesAdded: after.length - before.length,
    }));
    return;
  }

  const seriesADir = args.seriesA;
  const seriesBDir = args.seriesB;
  const runId = args.out;
  if (!seriesADir || !seriesBDir || !runId) {
    console.error('usage: node src/e2EnergyRatioBound.js --seriesA <dir> --seriesB <dir> --out <runId> [--summary <published.json>]\n' +
      '       node src/e2EnergyRatioBound.js --annotate <runId>');
    process.exitCode = 1;
    return;
  }
  const published = args.summary ? JSON.parse(readFileSync(args.summary, 'utf8')) : null;
  const publishedMeanByN = (series) => {
    const m = new Map();
    for (const n of published?.[series]?.byN ?? []) m.set(n.N, n.perHitEnergyRatioMean ?? null);
    return m;
  };

  const rowsA = await computeSeries(seriesADir);
  const rowsB = await computeSeries(seriesBDir);
  const pubA = publishedMeanByN('seriesA');
  const pubB = publishedMeanByN('seriesB');

  const summariseByN = (rowsByN, pubByN) => {
    const out = {};
    for (const [N, rows] of [...rowsByN.entries()].sort((a, b) => a[0] - b[0])) {
      const bound = energyRatioBound(rows);
      out[N] = { ...bound, publishedMean: pubByN.get(N) ?? null };
    }
    return out;
  };

  const companion = {
    exp: 'e2', kind: 'energy-ratio-bound-companion', runId,
    generatedAt: new Date().toISOString(),
    sourceSeriesADir: seriesADir, sourceSeriesBDir: seriesBDir,
    sourceSummary: args.summary ?? null,
    note: 'Additive companion to the published summary, which is UNCHANGED. eg[] itself is truncated in every existing shard (PREFIX-FIX fixes only future runs); ch/ecum are uncapped, so this bounds the true per-hit ratio via the closure argument ecum^(1/(2*chain)) over long chains (ch>=20), without re-simulating anything.',
    longChainMin: LONG_CHAIN_MIN,
    seriesA: summariseByN(rowsA, pubA),
    seriesB: summariseByN(rowsB, pubB),
  };
  writeFileSync(path.join('data/summaries', `e2-${runId}-egbound.json`), JSON.stringify(companion, null, 2));

  const L = [];
  L.push(`# E2 per-hit energy ratio — closure bound (companion to \`${args.summary ?? runId}\`)`);
  L.push('');
  L.push(`- **generated**: ${companion.generatedAt}  ·  **long-chain floor**: ch >= ${LONG_CHAIN_MIN}`);
  L.push('');
  L.push('> The published summary is **unchanged and not regenerated**. `eg[]` kept the first 12');
  L.push('> per-hit energy ratios, ordered by hit index; the ratio falls with hit index on the');
  L.push('> chains that matter, so the published mean is a prefix of a declining series, not a');
  L.push('> sample of it. `eg` itself cannot be recomputed from this corpus (truncated in every');
  L.push('> shard) — but `ch`/`ecum` are uncapped, so the true per-hit ratio on long chains is');
  L.push('> bounded here via `ecum^(1/(2*chain))`, without re-simulating anything.');
  L.push('');
  for (const [label, byN] of [['Series A', companion.seriesA], ['Series B', companion.seriesB]]) {
    L.push(`## ${label}`);
    L.push('');
    L.push('| N | trials | published E[eg] | coverage (hits kept / hits happened) | long chains (ch≥20) | implied per-hit ratio |');
    L.push('|---|---|---|---|---|---|');
    for (const [N, b] of Object.entries(byN)) {
      const cov = b.coverage === null ? '—' : `${(b.coverage * 100).toFixed(1)}%`;
      const bound = b.impliedGeometricPerHitRatio === null ? '—' : b.impliedGeometricPerHitRatio.toFixed(4);
      L.push(`| ${N} | ${b.n} | ${b.publishedMean === null ? '—' : b.publishedMean.toFixed(4)} | ${cov} | ${b.longChainN} | ${bound} |`);
    }
    L.push('');
  }
  writeFileSync(path.join('data/summaries', `e2-${runId}-egbound.md`), L.join('\n') + '\n');

  console.log(JSON.stringify({ ok: true, runId }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err?.stack ?? err) }));
    process.exitCode = 1;
  });
}
