#!/usr/bin/env node
// LAB-4, §5.3 — extracts E1's MEASURED shot-line (speed, angle) distribution from a Stage B
// run's raw shards into a compact empirical-CDF file E3's arenas consume at trial time
// (arenas/e3_paths.js / instrument.js's runE3Trial). LAB-2's own committed summary
// (e1-lab2-<runId>.json) only carries the BINNED transfer function, not a raw sample list a
// bootstrap sampler can draw from — this script is the missing piece, run once against the
// Stage B shards LAB-2 already produced (still on disk under data/e1/, gitignored but not
// deleted).
//
// Only unflagged (`f===0`) `term==='shotline'` records are kept — a flagged trial's crossing
// state is not a clean measurement of "what a flipper does" (§2.7). Output is committed
// (small: ~1-2 MB for ~90k pairs) so replay/coupling never depends on the raw, gitignored
// shards existing.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

function walkShards(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkShards(full));
    else if (entry.endsWith('.jsonl.gz')) out.push(full);
  }
  return out;
}

async function readShard(shardPath, samples) {
  const rl = readline.createInterface({ input: createReadStream(shardPath).pipe(createGunzip()) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.f === 0 && r.term === 'shotline' && r.xs !== null && r.xa !== null) {
      samples.push([r.xs, r.xa]);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.run; // e.g. data/e1/stageB-main-20260901T073830Z
  const out = args.out;
  if (!runDir || !out) {
    console.error('usage: node src/e1ShotlineCdf.js --run data/e1/stageB-main-<runId> --out data/summaries/e1-lab2-<runId>-shotline.json');
    process.exitCode = 1;
    return;
  }

  const shards = walkShards(runDir);
  const samples = [];
  for (const shard of shards) await readShard(shard, samples);

  if (samples.length === 0) {
    console.error(JSON.stringify({ ok: false, error: 'no shotline samples found', runDir }));
    process.exitCode = 1;
    return;
  }

  const speeds = samples.map((s) => s[0]);
  const angles = samples.map((s) => s[1]);
  const speedMin = Math.min(...speeds), speedMax = Math.max(...speeds);
  const angleMin = Math.min(...angles), angleMax = Math.max(...angles);
  // Circular-ish mean is unnecessary here: E1's outbound angles cluster well inside one
  // winding (never near the 0/360 wrap for a shot that actually left the shotline upward),
  // so a plain arithmetic mean is fine and was checked against the actual sample spread.
  const meanAngleDeg = angles.reduce((a, b) => a + b, 0) / angles.length;
  const meanSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;

  const payload = {
    runId: path.basename(runDir),
    source: runDir,
    n: samples.length,
    speedMin, speedMax, meanSpeed,
    angleMin, angleMax, meanAngleDeg,
    samples,
  };
  writeFileSync(out, JSON.stringify(payload));
  console.log(JSON.stringify({ ok: true, n: samples.length, meanSpeed: Number(meanSpeed.toFixed(3)), meanAngleDeg: Number(meanAngleDeg.toFixed(2)), speedMin, speedMax, angleMin, angleMax, out }));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.stack ?? err) }));
  process.exitCode = 1;
});
