// LAB-4 (E3 paths) batched worker: owns a contiguous slice of the flattened
// [{cfg, trials}, ...] list (across all five families at once — same batching rationale as
// stageAWorker.js: hundreds of cfgs at a few hundred-to-few-thousand trials each would waste
// wall-clock spinning one worker thread per cfg). Writes every record into one gzipped shard
// and returns per-cfg counters (cheap: no raw arrays) plus per-family pooled samples (xx for
// the return-x entropy/variety metric, tt for timeToReturn's distribution — capped per family
// per worker at FAMILY_SAMPLE_CAP so memory stays bounded regardless of trial count; large
// enough at this run's per-family trial volumes for stable percentiles/entropy, a documented
// resolution-vs-memory trade-off, not a silent truncation) and a merged dead-zone occupancy
// Map (§5.4's heatmap), keyed `family:bx,by` since each family's dead zones live in a
// completely different part of the arena.
import { parentPort, workerData } from 'node:worker_threads';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { runTrialWithMeta } from './instrument.js';

const FAMILY_SAMPLE_CAP = 6000;

function newCfgRow(cfg) {
  return {
    cfgId: cfg.cfgId, family: cfg.family, trials: 0, flagged: 0, impactsExhausted: 0, flaggedExclArtifacts: 0,
    term: {}, feed: {}, rmp: {}, inBandSpeed: 0, reachedCount: 0,
  };
}

async function run() {
  const { items, outPath } = workerData; // items: [{cfg, trials}, ...]

  const perCfg = [];
  const familySamples = {}; // family -> { xx: [], tt: [] }
  const deadZone = new Map(); // "family:bx,by" -> count

  let ii = 0;
  let seed = 0;
  const source = new Readable({
    read() {
      while (true) {
        if (ii >= items.length) { this.push(null); return; }
        const { cfg, trials } = items[ii];
        let row = perCfg[ii];
        if (!row) row = perCfg[ii] = newCfgRow(cfg);
        if (seed >= trials) { ii += 1; seed = 0; continue; }

        const { record, deadZoneHits } = runTrialWithMeta(cfg, seed);
        row.trials += 1;
        if (record.f !== 0) row.flagged += 1;
        if (record.f & 1) row.impactsExhausted += 1; // FLAGS.IMPACTS_EXHAUSTED — see stageA.js's e3 gate
        // §2.7 gate amendment: STALLED (bit 8) is excluded too — a stall IS the §5.4
        // dead-zone measurement for a path family, the same category as E4's own
        // flaggedFractionExclStalled precedent, not a solver artifact to filter out.
        if (record.f !== 0 && !(record.f & 1) && !(record.f & 8)) row.flaggedExclArtifacts += 1;
        row.term[record.term] = (row.term[record.term] ?? 0) + 1;
        if (record.feed) row.feed[record.feed] = (row.feed[record.feed] ?? 0) + 1;
        if (record.rmp) row.rmp[record.rmp] = (row.rmp[record.rmp] ?? 0) + 1;
        if (record.term === 'reached') {
          row.reachedCount += 1;
          if (record.xs >= 1.0 && record.xs <= 2.5) row.inBandSpeed += 1;
          let fs = familySamples[cfg.family];
          if (!fs) fs = familySamples[cfg.family] = { xx: [], tt: [] };
          if (fs.xx.length < FAMILY_SAMPLE_CAP) fs.xx.push(record.xx);
          if (fs.tt.length < FAMILY_SAMPLE_CAP) fs.tt.push(record.tt);
        }
        for (const [bx, by] of deadZoneHits) {
          const key = `${cfg.family}:${bx},${by}`;
          deadZone.set(key, (deadZone.get(key) ?? 0) + 1);
        }

        seed += 1;
        this.push(JSON.stringify(record) + '\n');
        return;
      }
    },
  });

  await pipeline(source, createGzip(), createWriteStream(outPath));

  parentPort.postMessage({
    ok: true, outPath, perCfg, familySamples,
    deadZone: [...deadZone.entries()],
  });
}

run().catch((err) => {
  parentPort.postMessage({ ok: false, error: String(err?.stack ?? err) });
});
