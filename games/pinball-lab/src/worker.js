// Runs a (cfg, seedRange) shard -> a gzipped JSONL file. One worker_thread per shard;
// no shared state, no locks — a crashed worker costs exactly its own shard, which runner.js
// re-runs by seed range (§2.8). Communicates over `workerData`/`postMessage`, not files, so
// there's nothing to clean up on failure beyond the shard file itself.
//
// §2.4a: also accumulates n/sum/sumSq for each raw injected inbound quantity (not vi/ai,
// which are null on a no-contact trial) and a flipper-contact count, so runner.js can check
// the ensemble is non-degenerate across the whole cfg without a second pass over the shards.
// This is in-memory only — the accumulators aren't written into the records themselves,
// keeping the §2.6 record format's short-keys budget untouched.
import { parentPort, workerData } from 'node:worker_threads';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { runTrialWithMeta, FLAGS } from './instrument.js';

function newAcc() {
  return { n: 0, sum: 0, sumSq: 0 };
}
function addAcc(acc, x) {
  acc.n += 1;
  acc.sum += x;
  acc.sumSq += x * x;
}

async function run() {
  const { cfg, seedStart, seedCount, outPath } = workerData;

  let flagged = 0;
  let contactCount = 0;
  let cursor = 0;
  // LAB-22: per-flag counts, so the declared-premise gate can hold every flag the premise did
  // NOT declare to FLAG_GATE_FRACTION. The aggregate `flagged` total cannot answer that.
  const flagCounts = {};
  for (const name of Object.keys(FLAGS)) flagCounts[name] = 0;
  const inboundAcc = { x0: newAcc(), speed0: newAcc(), angle0Deg: newAcc() };

  const source = new Readable({
    read() {
      if (cursor >= seedCount) {
        this.push(null);
        return;
      }
      const seed = seedStart + cursor;
      const { record, inbound, contacted } = runTrialWithMeta(cfg, seed);
      if (record.f !== 0) flagged += 1;
      for (const [name, bit] of Object.entries(FLAGS)) if (record.f & bit) flagCounts[name] += 1;
      if (contacted) contactCount += 1;
      addAcc(inboundAcc.x0, inbound.x0);
      addAcc(inboundAcc.speed0, inbound.speed0);
      addAcc(inboundAcc.angle0Deg, inbound.angle0Deg);
      this.push(JSON.stringify(record) + '\n');
      cursor += 1;
    },
  });

  await pipeline(source, createGzip(), createWriteStream(outPath));

  parentPort.postMessage({ ok: true, trials: seedCount, flagged, flagCounts, contactCount, inboundAcc, outPath });
}

run().catch((err) => {
  parentPort.postMessage({ ok: false, error: String(err?.stack ?? err) });
});
