// Stage A screen worker (LAB-2, §3.3): owns a contiguous slice of the 34,992 geometry x
// policy cfgs and runs all of that slice's trials itself, writing every record (already
// carrying "c":cfgId) into ONE gzipped shard — unlike the pilot's runner.js, which spins one
// worker per cfg. At ~11 trials/cfg that one-worker-per-cfg model would mean 34,992 worker
// thread spin-ups (module load included) for the screen alone, which measurement showed
// dominates wall-clock at this cfg count; batching by contiguous cfg range keeps the worker
// count at `os.cpus().length - 1` regardless of how many cfgs there are.
import { parentPort, workerData } from 'node:worker_threads';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { runTrialWithMeta } from './instrument.js';

function newAcc() {
  return { n: 0, sum: 0, sumSq: 0 };
}
function addAcc(acc, x) {
  acc.n += 1;
  acc.sum += x;
  acc.sumSq += x * x;
}

async function run() {
  const { cfgs, trialCounts, outPath } = workerData;

  const inboundAcc = { x0: newAcc(), speed0: newAcc(), angle0Deg: newAcc() };
  const perCfg = [];

  let ci = 0;
  let seed = 0;
  const source = new Readable({
    read() {
      while (true) {
        if (ci >= cfgs.length) { this.push(null); return; }
        const cfg = cfgs[ci];
        let row = perCfg[ci];
        if (!row) row = perCfg[ci] = { cfgId: cfg.cfgId, trials: 0, flagged: 0, contactCount: 0, xaVals: [], stallWithContact: 0 };
        if (seed >= trialCounts[ci]) { ci += 1; seed = 0; continue; }

        const { record, inbound, contacted } = runTrialWithMeta(cfg, seed);
        row.trials += 1;
        if (record.f !== 0) row.flagged += 1;
        if (contacted) row.contactCount += 1;
        if (record.xa !== null) row.xaVals.push(record.xa);
        if (record.term === 'stall' && contacted) row.stallWithContact += 1;
        addAcc(inboundAcc.x0, inbound.x0);
        addAcc(inboundAcc.speed0, inbound.speed0);
        addAcc(inboundAcc.angle0Deg, inbound.angle0Deg);
        seed += 1;
        this.push(JSON.stringify(record) + '\n');
        return;
      }
    },
  });

  await pipeline(source, createGzip(), createWriteStream(outPath));

  parentPort.postMessage({ ok: true, inboundAcc, perCfg, outPath });
}

run().catch((err) => {
  parentPort.postMessage({ ok: false, error: String(err?.stack ?? err) });
});
