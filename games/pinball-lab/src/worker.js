// Runs a (cfg, seedRange) shard -> a gzipped JSONL file. One worker_thread per shard;
// no shared state, no locks — a crashed worker costs exactly its own shard, which runner.js
// re-runs by seed range (§2.8). Communicates over `workerData`/`postMessage`, not files, so
// there's nothing to clean up on failure beyond the shard file itself.
import { parentPort, workerData } from 'node:worker_threads';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { runTrial } from './instrument.js';

async function run() {
  const { cfg, seedStart, seedCount, outPath } = workerData;

  let flagged = 0;
  let cursor = 0;

  const source = new Readable({
    read() {
      if (cursor >= seedCount) {
        this.push(null);
        return;
      }
      const seed = seedStart + cursor;
      const record = runTrial(cfg, seed);
      if (record.f !== 0) flagged += 1;
      this.push(JSON.stringify(record) + '\n');
      cursor += 1;
    },
  });

  await pipeline(source, createGzip(), createWriteStream(outPath));

  parentPort.postMessage({ ok: true, trials: seedCount, flagged, outPath });
}

run().catch((err) => {
  parentPort.postMessage({ ok: false, error: String(err?.stack ?? err) });
});
