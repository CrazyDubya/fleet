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
        if (!row) {
          row = perCfg[ci] = {
            cfgId: cfg.cfgId, trials: 0, flagged: 0, contactCount: 0, xaVals: [], stallWithContact: 0,
            // E4 (LAB-6) fields — harmless no-ops on E1/E2 records, which never set ct/cr/cp/cv.
            ct: 0, cr: 0, cp: 0, cv: 0, creep: 0, flaggedExclStalled: 0, stVals: [], rxaVals: [], relCounts: {},
            // LAB-22: per-flag counts, so the declared-premise gate can hold every flag the
            // premise did NOT declare to FLAG_GATE_FRACTION. Two versions, because E4's
            // numerator (`flaggedExclStalled`) drops whole STALLED *trials*, not the STALLED
            // *bit* — a per-bit count over all trials is not comparable to it (A2 reads 57.3%
            // IMPACTS_EXHAUSTED per-bit against a 21.8% excl-stalled numerator, because most
            // of those trials also stalled). Each caller passes whichever matches its own
            // numerator.
            flagCounts: Object.fromEntries(Object.keys(FLAGS).map((n) => [n, 0])),
            flagCountsExclStalled: Object.fromEntries(Object.keys(FLAGS).map((n) => [n, 0])),
          };
        }
        if (seed >= trialCounts[ci]) { ci += 1; seed = 0; continue; }

        const { record, inbound, contacted } = runTrialWithMeta(cfg, seed);
        row.trials += 1;
        if (record.f !== 0) row.flagged += 1;
        for (const [name, bit] of Object.entries(FLAGS)) if (record.f & bit) row.flagCounts[name] += 1;
        if (!(record.f & FLAGS.STALLED)) {
          for (const [name, bit] of Object.entries(FLAGS)) if (record.f & bit) row.flagCountsExclStalled[name] += 1;
        }
        if (contacted) row.contactCount += 1;
        if (record.xa !== null) row.xaVals.push(record.xa);
        if (record.term === 'stall' && contacted) row.stallWithContact += 1;
        if (record.ct !== undefined) {
          if (record.ct) row.ct += 1;
          if (record.cr) row.cr += 1;
          if (record.cp) row.cp += 1;
          if (record.cv) row.cv += 1;
          if (record.f & 32) row.creep += 1;
          if (record.f !== 0 && !(record.f & 8)) row.flaggedExclStalled += 1;
          if (record.st !== null) row.stVals.push(record.st);
          if (record.rxa !== null) row.rxaVals.push(record.rxa);
          if (record.rel) row.relCounts[record.rel] = (row.relCounts[record.rel] ?? 0) + 1;
        }
        if (inbound.x0 !== null) {
          addAcc(inboundAcc.x0, inbound.x0);
          addAcc(inboundAcc.speed0, inbound.speed0);
          addAcc(inboundAcc.angle0Deg, inbound.angle0Deg);
        }
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
