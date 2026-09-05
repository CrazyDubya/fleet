// LAB-28: five verified ways a number reached a published lab summary without any guard
// examining it (opencode cross-family review, ledger/handoffs/haiku-opencode2/
// 20260905-writer-review.md). One test per finding.
//
// V3 — three writers read `meta.flagGateOk !== false`, which reads a MISSING field (no gate
//      ever ran) identically to an explicit pass. A fourth (lab2Report's markdown call) defaulted
//      a missing gate object to `{ ok: true }`. Fixed by `gate.js`'s new `requireFlagGateOk`,
//      which throws on anything but a recorded boolean.
// V2 — a guard's result was computed but nothing branched on it for one table (lab2Report's full
//      geometries table, sorted by fanWidthXaDeg with no caveat). Fixed with an explicit
//      not-a-validated-ranking note (e4Report's own per-table guards were already correctly
//      wired — see the handoff for why that one needed no code change).
// V5 — a derived headline value was computed AFTER its constituent guards ran, so nothing
//      re-examined it (e4Report's `bestCp`, the max of three already-guarded top rows; e5a's
//      Pearson r / max shot rate, computed after `axisGuard`). Fixed by attaching the covering
//      guard's verdict to the derived value at the point it's derived.
// V1 — e2Report.js called zero gate functions at all. Fixed by adding a real §2.7 flag-gate,
//      computed from records this writer itself streamed.
// V4 — `trials ? x / trials : 0` reads an unmeasured (zero-trial) group identically to a
//      genuinely-measured-zero one. Fixed by using `null` (this project's existing "not
//      measured" sentinel) instead of `0`, with render call sites updated not to multiply a
//      possibly-null value by 100 before checking.
//
// These are CLI scripts (`main()` runs unconditionally at import in most of them) — several
// tests here use source-text extraction (the idiom `writer-instrument-commit.test.mjs` already
// established for this exact class of check) rather than executing a real multi-shard run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { requireFlagGateOk, flagGateResult } from '../src/gate.js';
import { cradleRowStats } from '../src/lab2Report.js';
import { seriesFlagTotals } from '../src/e2Report.js';

process.exitCode = 0; // see lab2Report.test.mjs's note: importing a CLI writer sets this as a side effect

const SRC = path.join(import.meta.dirname, '..', 'src');
const src = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');

// --- V3: requireFlagGateOk itself -------------------------------------------------------
test('V3: requireFlagGateOk throws on a missing field — absence must not read as a pass', () => {
  assert.throws(() => requireFlagGateOk(undefined, 'test'), /not a recorded boolean/);
  assert.throws(() => requireFlagGateOk({}.flagGateOk, 'test'), /not a recorded boolean/);
});

test('V3: requireFlagGateOk throws on null and on non-boolean junk, not just undefined', () => {
  assert.throws(() => requireFlagGateOk(null, 'test'));
  assert.throws(() => requireFlagGateOk('true', 'test'), 'a stringly-typed value must not be coerced');
  assert.throws(() => requireFlagGateOk(1, 'test'), 'a truthy non-boolean must not be coerced');
});

test('V3: requireFlagGateOk passes through a real recorded boolean, either way', () => {
  assert.equal(requireFlagGateOk(true, 'test'), true);
  assert.equal(requireFlagGateOk(false, 'test'), false);
});

// The exact vulnerable expression, demonstrated directly: an empty metadata object (a
// hand-made meta.json, or one written before flagGateOk existed) evaluates `!== false` to
// `true` — indistinguishable from a gate that ran and passed.
test('V3: the pre-fix expression is the bug — confirmed directly before asserting the fix is gone', () => {
  const meta = {};
  assert.equal(meta.flagGateOk !== false, true, 'the vulnerable pattern reads absence as a pass');
  assert.throws(() => requireFlagGateOk(meta.flagGateOk, 'test'), 'the fixed helper refuses the same input');
});

for (const file of ['aggregate.js', 'e4Report.js', 'lab2Report.js']) {
  test(`V3: ${file} no longer reads flagGateOk with the absence-reads-as-pass pattern`, () => {
    const text = src(file);
    assert.doesNotMatch(text, /flagGateOk\s*!==\s*false/, `${file} still contains the vulnerable !== false pattern`);
    assert.match(text, /requireFlagGateOk\(/, `${file} does not call the strict replacement`);
  });
}

test('V3: lab2Report.js no longer defaults a missing declaredPremiseGate to { ok: true }', () => {
  const text = src('lab2Report.js');
  assert.doesNotMatch(text, /declaredPremiseGate\s*\?\?\s*\{[^}]*ok:\s*true/, 'the ok:true fallback object is still present');
});

test('V3: aggregate.js validates flagGateOk before its first writeFileSync, not after (no partial publish)', () => {
  const text = src('aggregate.js');
  const checkIdx = text.indexOf('requireFlagGateOk(meta.flagGateOk');
  const firstWriteIdx = text.indexOf('writeFileSync(jsonOut');
  assert.ok(checkIdx >= 0, 'expected an early requireFlagGateOk call in main()');
  assert.ok(firstWriteIdx >= 0, 'expected to find the first writeFileSync call');
  assert.ok(checkIdx < firstWriteIdx, 'the gate check must run before any file is written, or a throw leaves a half-published corpus (json written, no md)');
});

// --- V2: a guard's result computed but nothing branched on it for one table ------------
test('V2: lab2Report.js\'s full geometries table (sorted, no per-row guard) now carries an explicit not-a-ranking caveat', () => {
  const text = src('lab2Report.js');
  const tableIdx = text.indexOf('## Fan width / timing sensitivity / cradle, per geometry');
  assert.ok(tableIdx >= 0, 'expected the geometries table header');
  const nearby = text.slice(tableIdx, tableIdx + 1200);
  assert.match(nearby, /not a validated ranking/i, 'the table must say its sort order is not a validated ranking');
});

// --- V5: a derived headline computed after its guards ran, never re-examined -----------
test('V5: e4Report.js attaches the covering ranking guard\'s verdict to bestCp, the value derived from it', () => {
  const text = src('e4Report.js');
  assert.match(text, /bestCpGuardOk/, 'expected bestCp to carry a guard-verdict companion field');
  assert.match(text, /bestPocketCpGuardOk/, 'expected the guard verdict to reach the published summary object');
});

test('V5: e5aReport.js\'s raw Pearson r / max shot rate line is marked when the axis guard failed', () => {
  const text = src('e5aReport.js');
  const lineIdx = text.indexOf('Pearson r(hsS, shotRate)');
  assert.ok(lineIdx >= 0);
  const nearby = text.slice(lineIdx - 400, lineIdx + 400);
  assert.match(nearby, /axisGuard\.ok/, 'the raw stat line must itself check axisGuard, not just the verdict banner above it');
});

// --- V1: e2Report.js called zero gate functions; now runs a real §2.7 gate -------------
test('V1: e2Report.js imports and calls the shared §2.7 gate', () => {
  const text = src('e2Report.js');
  assert.match(text, /import\s*\{[^}]*flagGateResult[^}]*\}\s*from\s*'\.\/gate\.js'/, 'e2Report.js must import flagGateResult from gate.js');
  assert.match(text, /flagGateResult\(/, 'e2Report.js must call it, not just import it');
});

test('V1: seriesFlagTotals sums raw trials/flagged across every N-group, not a stored fraction', () => {
  const byN = new Map([
    [1, { pooled: { trials: 100, flagged: 1 } }],
    [10, { pooled: { trials: 200, flagged: 5 } }],
  ]);
  assert.deepEqual(seriesFlagTotals(byN), { trials: 300, flagged: 6 });
});

test('V1: a series whose pooled totals exceed the 1% gate now fails it (before the fix, nothing would have checked)', () => {
  const byN = new Map([[1, { pooled: { trials: 1000, flagged: 50 } }]]); // 5%
  const { trials, flagged } = seriesFlagTotals(byN);
  const gate = flagGateResult({ trials, flagged });
  assert.equal(gate.ok, false);
});

test('V1: e2Report.js sets a non-zero exit code and renders a banner when the gate fails', () => {
  const text = src('e2Report.js');
  assert.match(text, /§2\.7 validity gate FAILED/, 'expected a rendered failure banner');
  assert.match(text, /process\.exitCode = 1/, 'expected a non-zero exit on gate failure (loud, matching the rest of the project)');
});

// --- V4: unmeasured (zero-trial) reads as null, not a measured-clean 0 -----------------
test('V4: cradleRowStats reports null cradleRate for zero trials, distinct from a measured zero', () => {
  assert.equal(cradleRowStats([]).cradleRate, null);
  assert.equal(cradleRowStats([{ cr: 0, st: null, bn: 0, cs: null }]).cradleRate, 0, 'one real trial, not settled, is a genuinely measured 0 — must stay 0, not null');
});

for (const [file, patterns] of [
  ['e2Report.js', [/flaggedFraction: agg\.trials \? agg\.flagged \/ agg\.trials : null/]],
  ['e4Report.js', [/a2Controls\.C0 \? a2Controls\.C0\.cp \/ a2Controls\.C0\.trials : null/]],
  ['lab2Report.js', [/cradleRate: trials > 0 \? settled \/ trials : null/]],
]) {
  test(`V4: ${file} uses null, not 0, for an unmeasured (zero-trial) rate`, () => {
    const text = src(file);
    for (const p of patterns) assert.match(text, p, `expected ${p} in ${file}`);
    assert.doesNotMatch(text, /trials \? [a-zA-Z0-9_./ ]+ : 0,/, `${file} still has a bare ": 0" trials-fallback the review flagged`);
  });
}

test('V4: e2Report.js and lab2Report.js scale a possibly-null rate through a null-safe helper before formatting, not a bare "* 100"', () => {
  for (const file of ['e2Report.js', 'lab2Report.js', 'e4Report.js']) {
    const text = src(file);
    assert.match(text, /function fmtPct\(/, `expected a null-safe percent helper in ${file}`);
  }
});
