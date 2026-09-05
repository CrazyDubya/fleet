// LAB-4 (E3 paths) batched worker: owns a contiguous slice of the flattened
// [{cfg, trials}, ...] list (across all five families at once — same batching rationale as
// stageAWorker.js: hundreds of cfgs at a few hundred-to-few-thousand trials each would waste
// wall-clock spinning one worker thread per cfg). Writes every record into one gzipped shard
// and returns per-cfg counters (cheap: no raw arrays) plus per-family pooled samples (xx for
// the return-x entropy/variety metric, tt for timeToReturn's distribution — held in a uniform
// RESERVOIR of FAMILY_SAMPLE_CAP per family per worker, so memory stays bounded regardless of
// trial count while the sample still represents the whole stream. It used to keep the first
// CAP instead, which is a prefix of this worker's contiguous cfg slice and not a sample of
// the family at all; see src/reservoir.js and SAMPLECAP-1) and a merged dead-zone occupancy
// Map (§5.4's heatmap), keyed `family:bx,by` since each family's dead zones live in a
// completely different part of the arena.
import { parentPort, workerData } from 'node:worker_threads';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { basename } from 'node:path';
import { runTrialWithMeta } from './instrument.js';
import { makeReservoir, seedFromString, E3_FAMILY_SAMPLE_CAP as FAMILY_SAMPLE_CAP } from './reservoir.js';

function newCfgRow(cfg) {
  return {
    cfgId: cfg.cfgId, family: cfg.family, trials: 0, flagged: 0, impactsExhausted: 0, flaggedExclArtifacts: 0,
    term: {}, feed: {}, rmp: {}, inBandSpeed: 0, reachedCount: 0,
    // LAB-18: per-cfg reached-trial return speeds — lets the ranking guard fall back to a
    // continuous metric (median return speed / distance from the in-band centre) when
    // `inBandFraction` saturates at its ceiling and can't order a top-N cut (P5's own case —
    // see stageA.js's per-family guard). Bounded by that cfg's own trial count (a few hundred
    // here), unlike the cross-cfg pooled `familySamples.xx/tt` arrays above, which need the
    // FAMILY_SAMPLE_CAP because they accumulate across an entire family's cfgs into one array.
    xsVals: [],
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
          row.xsVals.push(record.xs);
          // SAMPLECAP-1: a uniform reservoir, not the first CAP seen. Keeping the prefix kept
          // the opening cfgs of this worker's contiguous slice, which is not a sample of the
          // family — see src/reservoir.js for the measured consequence. `xx` and `tt` are
          // offered as ONE object so the pair survives together.
          let fs = familySamples[cfg.family];
          if (!fs) {
            fs = familySamples[cfg.family] =
              makeReservoir(FAMILY_SAMPLE_CAP, seedFromString(`${basename(outPath)}:${cfg.family}`));
          }
          fs.offer({ xx: record.xx, tt: record.tt });
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

  // Reservoirs cannot cross the worker boundary as live objects; send the held items plus the
  // count they were drawn from, which is exactly what `mergeReservoirs` needs to weight them.
  const familySampleOut = {};
  for (const [family, r] of Object.entries(familySamples)) {
    familySampleOut[family] = { items: r.items, seen: r.seen };
  }

  parentPort.postMessage({
    ok: true, outPath, perCfg, familySamples: familySampleOut,
    deadZone: [...deadZone.entries()],
  });
}

run().catch((err) => {
  parentPort.postMessage({ ok: false, error: String(err?.stack ?? err) });
});
