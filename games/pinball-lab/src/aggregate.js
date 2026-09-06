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
import { premiseHeaderLines, requireFlagGateOk } from './gate.js';
import { rate as measuredRate, fmt as fmtMeasured } from './measured.js';

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
  // flagged fraction/breakdown are reported over ALL records (that's the point of §2.7's
  // gate); every other column below describes what an unflagged trial actually did, per
  // P0-2's `r.f === 0` precedent (lab2Report.js) — no STALLED exception here: unlike E4,
  // this file's own §2.7 warning block already treats STALLED as one of the artifact causes
  // for E1 (see CAUSE_NOTES below), so `validExclStalled` (E4's "STALLED is a measurement,
  // not an artifact" exception, gate.js) would be the wrong mask to reuse for this exp.
  const flags = records.map((r) => r.f);
  const { count: flaggedCount, fraction: flaggedFrac } = flaggedFraction(flags);
  const flagBreakdown = {};
  for (const [name, bit] of Object.entries(FLAGS)) flagBreakdown[name] = bitFraction(flags, bit);
  // MEASURED-3B: additive sidecars — `bitFraction` returns only the fraction, not the count a
  // Wilson interval needs, so the count is recomputed here rather than changing that helper's
  // signature (every other caller of `bitFraction` wants just the number).
  const flagBreakdownM = {};
  for (const [name, bit] of Object.entries(FLAGS)) {
    const count = flags.filter((f) => (f & bit) !== 0).length;
    flagBreakdownM[name] = measuredRate(count, flags.length, { estimand: `${cfgMeta.cfgId}: fraction of trials flagged ${name}` });
  }

  const validRecords = records.filter((r) => r.f === 0);
  const columns = {};
  for (const key of NUMERIC_COLUMNS) columns[key] = summariseColumn(validRecords, key);

  const terms = Object.fromEntries(tally(records.map((r) => r.term)));
  const xaValues = validRecords.map((r) => r.xa).filter((v) => v !== null && v !== undefined);

  // MEASURED-3B: `contactRate` (used by the header's `never`-baseline line) is not otherwise
  // computed by this file — `meta.neverBaselineContactRate` is a bare fraction runner.js copied
  // into meta.json with no raw count alongside it (checked: `cfgMeta.push({..., contactRate,
  // ...})` in runner.js never stores the numerator). Recomputed here instead of touching
  // runner.js's shared meta.json shape, from the same per-trial contact-count field
  // (`r.n`, per instrument.js's runE1Trial) this file already streams into `records`.
  const contactCount = records.filter((r) => r.n > 0).length;

  return {
    cfgId: cfgMeta.cfgId,
    cfg: cfgMeta.cfg,
    trials: records.length,
    flaggedCount,
    flaggedFraction: flaggedFrac,
    flaggedFractionM: measuredRate(flaggedCount, records.length, { estimand: `${cfgMeta.cfgId}: fraction of trials carrying any validity flag` }),
    flagBreakdown,
    flagBreakdownM,
    contactRate: records.length ? contactCount / records.length : 0,
    contactRateM: measuredRate(contactCount, records.length, { estimand: `${cfgMeta.cfgId}: fraction of trials reaching flipper contact` }),
    terms,
    columns,
    fanWidthXa: xaValues.length >= 2 ? fanWidth(xaValues) : null,
  };
}

function fmt(x, digits = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

function toMarkdown(meta, cfgSummaries, flaggedFractionM) {
  const lines = [];
  lines.push(`# E1 pilot summary — run \`${path.basename(meta.out)}\``);
  lines.push('');
  lines.push(`- **exp**: ${meta.exp}  ·  **instrument commit**: \`${meta.instrumentCommitSha}\`  ·  **generated**: ${meta.generatedAt}`);
  lines.push(`- **cfgs**: ${meta.cfgCount}  ·  **trials**: ${meta.trialCount}  ·  **flagged fraction (any bit)**: ${fmtMeasured(flaggedFractionM)}  ·  **wall-clock**: ${meta.secs.toFixed(1)}s`);
  lines.push(`- **units**: length m, speed m/s, angle deg (recorded) / rad (internal), \`dt\` ms, \`dw\` s`);
  const eSds = meta.ensembleInboundSds;
  // MEASURED-3B: `never`-baseline contact rate now carries its own interval, recomputed by
  // `summariseCfg` (meta.json's own `neverBaselineContactRate` has no raw count to build one
  // from — see that function's comment) from the same `never`-policy cfg's records.
  const neverCfgSummary = cfgSummaries.find((s) => s.cfg.pol === 'never');
  lines.push(
    `- **§2.4a ensemble check** (so the next reader can see the ensemble was real without opening a shard): ` +
    `inbound sd — x0=${eSds.x0.toFixed(4)}m, speed0=${eSds.speed0.toFixed(4)}m/s, angle0=${eSds.angle0Deg.toFixed(2)}° ` +
    `(all cfgs passed their §2.4a floor) · **\`never\`-baseline flipper-contact rate**: ${neverCfgSummary ? fmtMeasured(neverCfgSummary.contactRateM) : '—'} (floor > 30%)`
  );
  lines.push('');
  lines.push('> Pilot scope (program handoff §9/LAB-1): one fixed geometry × the policy families' +
    ' (`never`/`fixedDelay`/`proximity`), ~800 trials/cfg — proves the harness and every §3.4' +
    ' column, not the full Stage A/B geometry sweep or the §3.6 transfer function (LAB-2).');
  lines.push('');
  // LAB-22: if the cfg set declared a §2.7 premise, it is echoed here — the exemption has to
  // travel with the summary a reader actually opens, not live only in the cfg file.
  lines.push(...premiseHeaderLines(meta.declaredPremise ?? null, {
    fraction: meta.flaggedFraction, ok: requireFlagGateOk(meta.flagGateOk, `aggregate.js (${meta.out ?? meta.exp})`),
  }));

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
    const CAUSE_NOTES = {
      IMPACTS_EXHAUSTED: 'the flipper firing right as the ball is already at/near the pivot' +
        ' saturates MAX_IMPACTS resolving the overlap in one substep — the same class of fact' +
        ' as the P0 root cause (a kinematic surface appearing where the ball already is).',
      TIMEOUT: 'the ball is still in play at the 2.0s cap — likely a slow-speed injection' +
        ' (§3.3 samples down to 0.3 m/s) taking a while to fall/settle rather than a stuck' +
        ' state; check a --trace replay of one flagged trial before assuming either way.',
      ESCAPED: 'the ball left the arena bounding box — a potential solver tunneling bug,' +
        ' reported per §2.7 rather than filed in a summary; investigate immediately.',
      STALLED: 'the ball sat below 0.05 m/s for over 0.5s without draining — likely resting' +
        ' on a flipper or in a geometric pocket.',
      NAN: 'a non-finite position/velocity appeared — a solver bug, not a sampling issue.',
    };
    for (const s of overFlagged) {
      const dominant = Object.entries(s.flagBreakdown).sort((a, b) => b[1] - a[1])[0];
      lines.push(
        `- **${s.cfgId}** (\`${s.cfg.pol}\`${s.cfg.R != null ? ` R=${s.cfg.R} L=${s.cfg.L}` : ''}` +
        `${s.cfg.d != null ? ` d=${s.cfg.d}` : ''}): ` +
        `${fmtMeasured(s.flaggedFractionM)} flagged, dominated by \`${dominant[0]}\` ` +
        `(${fmtMeasured(s.flagBreakdownM[dominant[0]])}). ${CAUSE_NOTES[dominant[0]] ?? 'Cause not yet inspected.'}`
      );
    }
    lines.push('');
  }
  lines.push('| cfg | pol | d | R | L | n | flagged | top term | vi | ai | hs | ha | hw | dt(ms) | vo | ao | contacts(n) | fan(xa) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of cfgSummaries) {
    const topTerm = Object.entries(s.terms).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
    const c = s.columns;
    lines.push(
      `| ${s.cfgId} | ${s.cfg.pol} | ${s.cfg.d ?? '—'} | ${s.cfg.R ?? '—'} | ${s.cfg.L ?? '—'} | ${s.trials} | ` +
      `${fmtMeasured(s.flaggedFractionM)} | ${topTerm} | ` +
      `${fmt(c.vi.mean)} | ${fmt(c.ai.mean, 1)} | ${fmt(c.hs.mean)} | ${fmt(c.ha.mean, 1)} | ${fmt(c.hw.mean, 1)} | ` +
      `${fmt(c.dt.mean, 1)} | ${fmt(c.vo.mean)} | ${fmt(c.ao.mean, 1)} | ${fmt(c.n.mean)} | ${fmt(s.fanWidthXa, 1)} |`
    );
  }
  lines.push('');
  lines.push('## IMPACTS_EXHAUSTED, per cfg (§2.7/§4.5 — reported prominently, not folded away)');
  lines.push('');
  lines.push('| cfg | pol | IMPACTS_EXHAUSTED | ESCAPED | TIMEOUT | STALLED | NAN |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of cfgSummaries) {
    lines.push(
      `| ${s.cfgId} | ${s.cfg.pol} | ${fmtMeasured(s.flagBreakdownM.IMPACTS_EXHAUSTED)} | ` +
      `${fmtMeasured(s.flagBreakdownM.ESCAPED)} | ${fmtMeasured(s.flagBreakdownM.TIMEOUT)} | ` +
      `${fmtMeasured(s.flagBreakdownM.STALLED)} | ${fmtMeasured(s.flagBreakdownM.NAN)} |`
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
  // Validated here, before any writeFileSync below — toMarkdown's own call to
  // requireFlagGateOk would otherwise throw only after jsonOut had already been written,
  // publishing half a corpus (the raw json, no md, an unhandled-rejection stack trace) instead
  // of refusing outright.
  requireFlagGateOk(meta.flagGateOk, `aggregate.js (${metaPath})`);

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

  // MEASURED-3B: additive sidecar for the headline `meta.flaggedFraction` — bare field
  // unchanged (re-derived here from the raw counts this loop already summed, same as
  // e2Report.js's `seriesFlagTotals` precedent, rather than trusting `meta.flaggedFraction`
  // as a pre-computed value from a possibly different pipeline stage).
  const flaggedFractionM = measuredRate(totalFlagged, totalTrials, { estimand: `${exp}/${runId}: fraction of ALL trials carrying any validity flag` });
  const jsonSummary = { ...meta, flaggedFractionM, cfgSummaries };
  writeFileSync(jsonOut, JSON.stringify(jsonSummary, null, 2));
  writeFileSync(mdOut, toMarkdown(meta, cfgSummaries, flaggedFractionM));

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
