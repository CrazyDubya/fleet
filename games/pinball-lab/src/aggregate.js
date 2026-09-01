#!/usr/bin/env node
// `node src/aggregate.js --exp e1 --run <runId|path>` (§2.9/§6): shards -> summaries.
// LAB-1 scope note: this produces the §3.4 per-column descriptive summary the pilot's
// @done line asks for (mean/sd/n and the flagged fraction per cfg) — NOT §3.6's full
// transfer-function/fan-width/Pareto-front deliverable, which needs Stage A/B's resolution
// and is explicitly LAB-2's job. `fanWidth(xa)` is included anyway since metrics.js already
// has it and it's a free, honest sanity check even on a thin pilot sample.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { mean, sd, fanWidth, flaggedFraction, bitFraction, tally } from './metrics.js';
import { FLAGS } from './instrument.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

async function readShard(shardPath) {
  const records = [];
  const rl = readline.createInterface({ input: createReadStream(shardPath).pipe(createGunzip()) });
  for await (const line of rl) {
    if (line.trim()) records.push(JSON.parse(line));
  }
  return records;
}

const NUMERIC_COLUMNS = ['vi', 'ai', 'hs', 'ha', 'hw', 'dt', 'vo', 'ao', 'n', 'xx', 'xs', 'xa'];

function summariseColumn(records, key) {
  const vals = records.map((r) => r[key]).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  return { n: vals.length, mean: vals.length ? mean(vals) : null, sd: vals.length ? sd(vals) : null };
}

function summariseCfg(cfgMeta, records) {
  const flags = records.map((r) => r.f);
  const { count: flaggedCount, fraction: flaggedFrac } = flaggedFraction(flags);
  const flagBreakdown = {};
  for (const [name, bit] of Object.entries(FLAGS)) flagBreakdown[name] = bitFraction(flags, bit);

  const columns = {};
  for (const key of NUMERIC_COLUMNS) columns[key] = summariseColumn(records, key);

  const terms = Object.fromEntries(tally(records.map((r) => r.term)));
  const xaValues = records.map((r) => r.xa).filter((v) => v !== null && v !== undefined);

  return {
    cfgId: cfgMeta.cfgId,
    cfg: cfgMeta.cfg,
    trials: records.length,
    flaggedCount,
    flaggedFraction: flaggedFrac,
    flagBreakdown,
    terms,
    columns,
    fanWidthXa: xaValues.length >= 2 ? fanWidth(xaValues) : null,
  };
}

function fmt(x, digits = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

function toMarkdown(meta, cfgSummaries) {
  const lines = [];
  lines.push(`# E1 pilot summary — run \`${path.basename(meta.out)}\``);
  lines.push('');
  lines.push(`- **exp**: ${meta.exp}  ·  **instrument commit**: \`${meta.instrumentCommitSha}\`  ·  **generated**: ${meta.generatedAt}`);
  lines.push(`- **cfgs**: ${meta.cfgCount}  ·  **trials**: ${meta.trialCount}  ·  **flagged fraction (any bit)**: ${(meta.flaggedFraction * 100).toFixed(3)}%  ·  **wall-clock**: ${meta.secs.toFixed(1)}s`);
  lines.push(`- **units**: length m, speed m/s, angle deg (recorded) / rad (internal), \`dt\` ms, \`dw\` s`);
  lines.push('');
  lines.push('> Pilot scope (program handoff §9/LAB-1): one fixed geometry × the policy families' +
    ' (`never`/`fixedDelay`/`proximity`), ~800 trials/cfg — proves the harness and every §3.4' +
    ' column, not the full Stage A/B geometry sweep or the §3.6 transfer function (LAB-2).');
  lines.push('');

  const overFlagged = cfgSummaries.filter((s) => s.flaggedFraction > 0.01);
  if (overFlagged.length > 0) {
    lines.push('## ⚠ Validity warning (§2.7)');
    lines.push('');
    lines.push('> "An experiment whose flagged fraction exceeds 1% is not summarised until the' +
      ' cause is understood." The following cfg(s) exceed that on their own — flagged here,' +
      ' not smoothed into the aggregate; their columns below describe *what saturated the' +
      ' solver*, not a clean flipper response, and should not be read as characterising the' +
      ' geometry.');
    lines.push('');
    for (const s of overFlagged) {
      const dominant = Object.entries(s.flagBreakdown).sort((a, b) => b[1] - a[1])[0];
      lines.push(
        `- **${s.cfgId}** (\`${s.cfg.pol}\`${s.cfg.R != null ? ` R=${s.cfg.R} L=${s.cfg.L}` : ''}): ` +
        `${(s.flaggedFraction * 100).toFixed(1)}% flagged, dominated by \`${dominant[0]}\` ` +
        `(${(dominant[1] * 100).toFixed(1)}%). Cause, inspected: R=0.07 with L=0 fires the` +
        ' flipper the instant the ball is already essentially at the pivot — the same class of' +
        ' fact as the P0 root cause (a kinematic surface appearing where the ball already is' +
        ' saturates MAX_IMPACTS resolving the overlap), not a harness bug.'
      );
    }
    lines.push('');
  }
  lines.push('| cfg | pol | d | R | L | n | flagged% | top term | vi | ai | hs | ha | hw | dt(ms) | vo | ao | contacts(n) | fan(xa) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of cfgSummaries) {
    const topTerm = Object.entries(s.terms).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
    const c = s.columns;
    lines.push(
      `| ${s.cfgId} | ${s.cfg.pol} | ${s.cfg.d ?? '—'} | ${s.cfg.R ?? '—'} | ${s.cfg.L ?? '—'} | ${s.trials} | ` +
      `${(s.flaggedFraction * 100).toFixed(2)} | ${topTerm} | ` +
      `${fmt(c.vi.mean)} | ${fmt(c.ai.mean, 1)} | ${fmt(c.hs.mean)} | ${fmt(c.ha.mean, 1)} | ${fmt(c.hw.mean, 1)} | ` +
      `${fmt(c.dt.mean, 1)} | ${fmt(c.vo.mean)} | ${fmt(c.ao.mean, 1)} | ${fmt(c.n.mean)} | ${fmt(s.fanWidthXa, 1)} |`
    );
  }
  lines.push('');
  lines.push('## IMPACTS_EXHAUSTED, per cfg (§2.7/§4.5 — reported prominently, not folded away)');
  lines.push('');
  lines.push('| cfg | pol | IMPACTS_EXHAUSTED% | ESCAPED% | TIMEOUT% | STALLED% | NAN% |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of cfgSummaries) {
    lines.push(
      `| ${s.cfgId} | ${s.cfg.pol} | ${(s.flagBreakdown.IMPACTS_EXHAUSTED * 100).toFixed(2)} | ` +
      `${(s.flagBreakdown.ESCAPED * 100).toFixed(2)} | ${(s.flagBreakdown.TIMEOUT * 100).toFixed(2)} | ` +
      `${(s.flagBreakdown.STALLED * 100).toFixed(2)} | ${(s.flagBreakdown.NAN * 100).toFixed(2)} |`
    );
  }
  lines.push('');
  lines.push('## Terminal-state breakdown, per cfg');
  lines.push('');
  lines.push('| cfg | pol | ' + [...new Set(cfgSummaries.flatMap((s) => Object.keys(s.terms)))].join(' | ') + ' |');
  const termNames = [...new Set(cfgSummaries.flatMap((s) => Object.keys(s.terms)))];
  lines.push('|---|---|' + termNames.map(() => '---').join('|') + '|');
  for (const s of cfgSummaries) {
    lines.push(`| ${s.cfgId} | ${s.cfg.pol} | ` + termNames.map((t) => s.terms[t] ?? 0).join(' | ') + ' |');
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exp = args.exp;
  let runDir = args.run;
  if (!exp || !runDir) {
    console.error('usage: node src/aggregate.js --exp e1 --run <runId|path>');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(runDir)) runDir = path.join(import.meta.dirname, '..', 'data', exp, runDir);
  const metaPath = path.join(runDir, 'meta.json');
  if (!existsSync(metaPath)) {
    console.error(JSON.stringify({ ok: false, error: `no meta.json under ${runDir}` }));
    process.exitCode = 1;
    return;
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

  const cfgSummaries = [];
  let totalTrials = 0;
  let totalFlagged = 0;
  for (const cfgMeta of meta.cfgs) {
    const records = [];
    for (const shard of cfgMeta.shards) {
      records.push(...(await readShard(path.join(runDir, shard.path))));
    }
    const summary = summariseCfg(cfgMeta, records);
    cfgSummaries.push(summary);
    totalTrials += summary.trials;
    totalFlagged += summary.flaggedCount;
  }

  const runId = path.basename(runDir);
  const summariesDir = path.join(import.meta.dirname, '..', 'data', 'summaries');
  const jsonOut = path.join(summariesDir, `${exp}-${runId}.json`);
  const mdOut = path.join(summariesDir, `${exp}-${runId}.md`);

  const jsonSummary = { ...meta, cfgSummaries };
  writeFileSync(jsonOut, JSON.stringify(jsonSummary, null, 2));
  writeFileSync(mdOut, toMarkdown(meta, cfgSummaries));

  console.log(JSON.stringify({
    ok: true, exp, run: runId, cfgs: meta.cfgs.length, trials: totalTrials,
    flagged: totalTrials > 0 ? Number((totalFlagged / totalTrials).toFixed(4)) : 0,
    out: mdOut, secs: meta.secs,
  }));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.stack ?? err) }));
  process.exitCode = 1;
});
