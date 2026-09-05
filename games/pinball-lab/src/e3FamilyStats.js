#!/usr/bin/env node
// SAMPLECAP-1, the additive half. E3's `returnXVariety` and `timeToReturnMedianS` were computed
// from a PREFIX of each worker's cfg slice rather than a sample of the family (see
// src/reservoir.js). Fixing the cap makes future runs right; it does nothing for the corpus
// already on disk.
//
// The shards hold every trial. The cap only bounded what the WRITER retained, not what was
// recorded — so the correct values are recoverable from any existing run without re-simulating
// anything and without regenerating any summary. This tool streams a run directory, recomputes
// both metrics over EVERY reached trial, and writes a companion file beside the original.
//
// It never opens the published summary for writing. That matters: regenerating an E3 summary
// would also pick up two instrument changes since `575fb10` (an E3 arena fix, and a change to
// how IMPACTS_EXHAUSTED is set), so the numbers would move for two reasons at once and the
// published result would stop being reproducible. A companion moves one thing.
//
//   node src/e3FamilyStats.js --run <dir> --out <runId> [--summary <published.json>]
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile, histogram, entropyBits } from './metrics.js';
import { indeterminate, fmt as fmtMeasured } from './measured.js';

// Identical to stageA.js's own call, so the ONLY difference between the published value and
// the corrected one is which trials went in.
export const RETURN_X_BINS = 32;
export const RETURN_X_RANGE = [-0.3, 0.3];

/** Pure: both family metrics over a complete set of reached-trial samples. */
export function familyStats(xx, tt) {
  const xs = xx.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const ts = tt.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  return {
    returnXVariety: xs.length >= 2
      ? entropyBits(histogram(xs, RETURN_X_BINS, RETURN_X_RANGE[0], RETURN_X_RANGE[1]), { normalise: true })
      : null,
    timeToReturnMedianS: ts.length ? percentile(ts, 50) : null,
    xxN: xs.length,
    ttN: ts.length,
  };
}

export const BEGIN = '<!-- SAMPLECAP-1-ANNOTATION:BEGIN -->';
export const END = '<!-- SAMPLECAP-1-ANNOTATION:END -->';

// A published value this far from the corrected one changes how the row reads, rather than
// moving it in the last digit. Used only to decide which families the prose calls out.
const VARIETY_NOTABLE = 0.05;
const MEDIAN_NOTABLE_RATIO = 1.2;

function ordering(fams, pick) {
  return [...fams].sort((a, b) => pick(a[1]) - pick(b[1])).map(([k]) => k).join(' < ');
}

/** The corrected characterisation, as prose plus a table. Pure, so the wording is testable and
 * so it can be regenerated from a companion without re-reading any shard. */
export function annotationBlock(companion) {
  const fams = Object.entries(companion.families);
  const cv = fams.map(([, f]) => f.returnXVariety);
  const pv = fams.map(([, f]) => f.publishedReturnXVariety).filter((v) => v !== null && v !== undefined);
  const cSpread = Math.max(...cv) - Math.min(...cv);
  const pSpread = pv.length === fams.length ? Math.max(...pv) - Math.min(...pv) : null;

  const L = [];
  L.push(BEGIN);
  L.push('');
  L.push('## Corrected family characterisation (SAMPLECAP-1)');
  L.push('');
  L.push('`returnXVariety` and `timeToReturnMedianS` in the table above were computed from a');
  L.push('per-worker **prefix** of each family\'s reached trials — workers own contiguous cfg');
  L.push('slices, so the retained trials came from one end of each slice — not from a sample of');
  L.push('the family. Every trial is on disk, so both have been recomputed over **every** reached');
  L.push('trial. Nothing was re-simulated and this summary was not regenerated; no other metric');
  L.push(`here is affected. Source: \`e3-${companion.runId}-familystats.json\`.`);
  L.push('');
  L.push('**These are the values this run supports:**');
  L.push('');
  L.push('| family | reached trials | return-x variety | median time to return |');
  L.push('|---|---|---|---|');
  for (const [k, f] of fams) {
    L.push(`| ${k} | ${f.reachedTrials.toLocaleString()} | **${f.returnXVariety.toFixed(4)}** | **${f.timeToReturnMedianS.toFixed(4)} s** |`);
  }
  L.push('');

  // --- return-x variety ---
  const movedV = fams.filter(([, f]) => f.publishedReturnXVariety !== null
    && Math.abs(f.publishedReturnXVariety - f.returnXVariety) >= VARIETY_NOTABLE);
  L.push(`**Return-x variety.** ${Math.min(...cv).toFixed(3)}–${Math.max(...cv).toFixed(3)} across the ` +
    `${fams.length} ${fams.length === 1 ? 'family' : 'families'}, a spread of ${cSpread.toFixed(3)}. ` +
    (fams.length > 1
      ? 'All of them spread their returns comparably; none concentrates them into a narrow band. '
      : ''));
  if (pSpread !== null && cSpread > 0 && pSpread > 2 * cSpread) {
    L.push(`The table above shows a spread of ${pSpread.toFixed(3)} — an apparent separation ` +
      `${(pSpread / cSpread).toFixed(0)}× wider than the data supports. That separation is an artifact of ` +
      'which trials were retained.');
  }
  for (const [k, f] of movedV) {
    L.push(`- **${k}** reads ${f.publishedReturnXVariety.toFixed(4)} above; it is **${f.returnXVariety.toFixed(4)}**. ` +
      `Any reading that treats ${k} as ${f.publishedReturnXVariety < f.returnXVariety ? 'less' : 'more'} various than the ` +
      'other families does not survive the correction.');
  }
  L.push('');

  // --- time to return ---
  const cOrd = ordering(fams, (f) => f.timeToReturnMedianS);
  const havePub = fams.every(([, f]) => f.publishedTimeToReturnMedianS !== null && f.publishedTimeToReturnMedianS !== undefined);
  const pOrd = havePub ? ordering(fams, (f) => f.publishedTimeToReturnMedianS) : null;
  L.push(`**Median time to return.** ${fams.length > 1 ? `${cOrd} — ` : ''}` +
    fams.map(([k, f]) => `${k} ${f.timeToReturnMedianS.toFixed(3)} s`).join(', ') + '.');
  if (pOrd !== null && fams.length > 1) {
    L.push(pOrd === cOrd
      ? '- The **ordering is unchanged** from the table above; the magnitudes are not.'
      : `- The **ordering changes**: the table above gives ${pOrd}.`);
  }
  for (const [k, f] of fams) {
    if (!havePub || !f.publishedTimeToReturnMedianS) continue;
    const r = f.timeToReturnMedianS / f.publishedTimeToReturnMedianS;
    if (r >= MEDIAN_NOTABLE_RATIO || r <= 1 / MEDIAN_NOTABLE_RATIO) {
      L.push(`- **${k}** reads ${f.publishedTimeToReturnMedianS.toFixed(4)} s above; it is ` +
        `**${f.timeToReturnMedianS.toFixed(4)} s** (${r.toFixed(2)}×).`);
    }
  }
  L.push('');
  L.push(END);
  return L.join('\n');
}

/** Insert or REPLACE the annotation block. Idempotent: applying twice leaves one block, and a
 * revised block supersedes rather than stacks beside its predecessor. */
export function applyAnnotation(md, block) {
  const i = md.indexOf(BEGIN);
  const j = md.indexOf(END);
  if (i !== -1 && j !== -1 && j > i) {
    return md.slice(0, i) + block + md.slice(j + END.length);
  }
  return `${md.replace(/\s*$/, '')}\n\n${block}\n`;
}

async function* streamShard(dir, shardPath) {
  const rl = readline.createInterface({ input: createReadStream(path.join(dir, shardPath)).pipe(createGunzip()) });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, arg, i, arr) => {
      if (arg.startsWith('--')) pairs.push([arg.slice(2), arr[i + 1]]);
      return pairs;
    }, [])
  );
  // --annotate: state the corrected characterisation IN the summary a reader opens. Reads the
  // companion this tool already wrote and rewrites only the .md — never the published .json,
  // whose numbers stay exactly as published, and never by re-running any writer.
  if (args.annotate !== undefined) {
    const runId = args.annotate === true || args.annotate?.startsWith?.('--') ? args.out : args.annotate;
    if (!runId) {
      console.error('usage: node src/e3FamilyStats.js --annotate <runId>');
      process.exitCode = 1;
      return;
    }
    const companionPath = path.join('data/summaries', `e3-${runId}-familystats.json`);
    const mdPath = path.join('data/summaries', `e3-${runId}.md`);
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

  const runDir = args.run;
  const runId = args.out;
  if (!runDir || !runId) {
    console.error('usage: node src/e3FamilyStats.js --run <dir> --out <runId> [--summary <published.json>]\n' +
      '       node src/e3FamilyStats.js --annotate <runId>');
    process.exitCode = 1;
    return;
  }
  const meta = JSON.parse(readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
  const published = args.summary ? JSON.parse(readFileSync(args.summary, 'utf8')).familyMetrics ?? {} : {};

  const byFamily = new Map(); // family -> { xx: [], tt: [] }
  let reached = 0, trials = 0;
  for (const shard of meta.shards) {
    for await (const r of streamShard(runDir, shard.path)) {
      trials += 1;
      if (r.term !== 'reached') continue;
      reached += 1;
      let f = byFamily.get(r.fam);
      if (!f) { f = { xx: [], tt: [] }; byFamily.set(r.fam, f); }
      f.xx.push(r.xx);
      f.tt.push(r.tt);
    }
  }
  if (byFamily.size === 0) {
    throw new Error(`e3FamilyStats: ${runDir} produced no reached trials — an empty corpus carries no statistical power and must not be summarised.`);
  }

  const families = {};
  for (const [family, s] of [...byFamily.entries()].sort()) {
    const full = familyStats(s.xx, s.tt);
    const pub = published[family] ?? {};
    // The published sample size is only recoverable when the summary recorded it; older runs
    // (every run before SAMPLECAP-1) did not, so it is stated as unknown rather than guessed.
    const publishedSampleN = pub.familySampleN ?? null;
    families[family] = {
      reachedTrials: full.xxN,
      returnXVariety: full.returnXVariety,
      timeToReturnMedianS: full.timeToReturnMedianS,
      publishedReturnXVariety: pub.returnXVariety ?? null,
      publishedTimeToReturnMedianS: pub.timeToReturnMedianS ?? null,
      publishedSampleN,
      publishedCoverage: publishedSampleN === null ? null : publishedSampleN / full.xxN,
      // Slice 1 of measured.js has no entropy or median constructor (spec §7, slice 3), so the
      // uncertainty on these two is declared absent rather than left to read as absent.
      returnXVarietyM: indeterminate(full.returnXVariety, 'entropy interval needs measured.js slice 3 (Dirichlet resample of the 32 bin counts)', { n: full.xxN, estimand: `${family}: normalised 32-bin entropy of return-x over EVERY reached trial` }),
      timeToReturnMedianSM: indeterminate(full.timeToReturnMedianS, 'median interval needs measured.js slice 3 (order-statistic interval)', { n: full.ttN, estimand: `${family}: median time to return over EVERY reached trial` }),
    };
  }

  const out = {
    exp: 'e3', kind: 'family-stats-companion', runId,
    generatedAt: new Date().toISOString(),
    sourceRunDir: runDir,
    sourceSummary: args.summary ?? null,
    // The run's own instrumentation, carried so this companion can never be mistaken for a
    // result produced under current instrumentation.
    instrumentCommitSha: meta.instrumentCommitSha ?? null,
    note: 'Additive companion to the published summary, which is UNCHANGED. Both metrics are recomputed over every reached trial in the run; the published values came from a per-worker prefix (SAMPLECAP-1). No trial was re-simulated.',
    trials, reachedTrials: reached,
    families,
  };
  writeFileSync(path.join('data/summaries', `e3-${runId}-familystats.json`), JSON.stringify(out, null, 2));

  const L = [];
  L.push(`# E3 family stats — corrected sample (companion to \`${args.summary ?? runDir}\`)`);
  L.push('');
  L.push(`- **source run**: \`${runDir}\` · **instrument commit**: \`${out.instrumentCommitSha ?? 'not recorded'}\``);
  L.push(`- **generated**: ${out.generatedAt}`);
  L.push('');
  L.push('> The published summary is **unchanged and not regenerated**. `returnXVariety` and');
  L.push('> `timeToReturnMedianS` were computed there from the first `FAMILY_SAMPLE_CAP` reached');
  L.push('> trials each worker saw — a prefix of that worker\'s contiguous cfg slice, not a sample');
  L.push('> of the family. Every trial is on disk, so the correct values are recoverable without');
  L.push('> re-simulating anything. These are those values, over **every** reached trial.');
  L.push('');
  L.push('| family | reached trials | returnXVariety (published → corrected) | timeToReturnMedianS (published → corrected) | published sample |');
  L.push('|---|---|---|---|---|');
  for (const [family, f] of Object.entries(families)) {
    const v0 = f.publishedReturnXVariety, v1 = f.returnXVariety;
    const t0 = f.publishedTimeToReturnMedianS, t1 = f.timeToReturnMedianS;
    const cov = f.publishedCoverage === null ? 'not recorded' : `${(f.publishedCoverage * 100).toFixed(1)}% of reached`;
    L.push(`| ${family} | ${f.reachedTrials.toLocaleString()} | ${v0 === null ? '—' : v0.toFixed(4)} → **${v1.toFixed(4)}** | ${t0 === null ? '—' : t0.toFixed(4)} s → **${t1.toFixed(4)} s** | ${cov} |`);
  }
  L.push('');
  L.push('## Uncertainty');
  L.push('');
  for (const [family, f] of Object.entries(families)) {
    L.push(`- **${family}** — returnXVariety ${fmtMeasured(f.returnXVarietyM)}; timeToReturnMedianS ${fmtMeasured(f.timeToReturnMedianSM)}`);
  }
  writeFileSync(path.join('data/summaries', `e3-${runId}-familystats.md`), L.join('\n') + '\n');

  console.log(JSON.stringify({ ok: true, runId, families: Object.keys(families).length, reachedTrials: reached }));
}

// LAB-20's rule, and this file tripped it: run the CLI only when this file IS the entry point.
// A test importing `annotationBlock` otherwise runs the whole report, prints the usage banner
// and sets a non-zero exit — the test file fails with no individual test failing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err?.stack ?? err) }));
    process.exitCode = 1;
  });
}
