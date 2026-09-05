// LAB-22: the declared-premise exemption, written test-first.
//
// Background (opus2 `ledger/handoffs/opus2/20260904T150000Z-three-gate-rulings.md`): §2.7's
// gate says "an experiment whose flagged fraction exceeds 1% is not summarised until the cause
// is understood". Two corpora exceed 1% for reasons that ARE understood and written down —
// e1-pilot-01's TIMEOUT tail (§3.3 samples down to 0.3 m/s against a 2.0s cap) and E4 Stage A1's
// coarse first-stage sweep. The ruling was that they are exempt by DECLARED PREMISE rather than
// defective, and that the exemption must be a recorded claim a reader can challenge — not a
// loosened threshold. FLAG_GATE_FRACTION stays 0.01 for everything that has not declared.
//
// The three properties these tests exist to pin, in order of importance:
//   1. A premise is a CEILING THAT STILL FAILS. Declaring 13% does not skip the gate; it moves
//      it to 13%, and 13.1% is still a refusal. An exemption that cannot fail is not a gate.
//   2. A premise is NARROW. It names the flags it covers, and every flag it does NOT name is
//      still held to FLAG_GATE_FRACTION. This is what keeps "do not weaken FLAG_GATE_FRACTION"
//      true: a corpus declaring a TIMEOUT tail does not thereby get to hide a NAN.
//   3. A premise is ATTRIBUTABLE. A written reason and a declaredBy pointer are required, so
//      the claim can be traced to the handoff that made it and argued with.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLAG_GATE_FRACTION, flagGateResult, parseCfgSet, premiseHeaderLines, PREMISE_MIN_REASON_CHARS,
  PREMISE_FLAG_NAMES, PREMISE_MAX_CEILING,
} from '../src/gate.js';
import { FLAGS } from '../src/instrument.js';

test('premise: the flag vocabulary matches instrument.js', () => {
  // gate.js duplicates the flag NAMES rather than importing FLAGS, to stay free of the
  // instrument's imports. If a flag is ever added, this fails rather than letting a premise
  // silently be unable to declare it.
  assert.deepEqual([...PREMISE_FLAG_NAMES].sort(), Object.keys(FLAGS).sort());
});

const GOOD_REASON =
  'The TIMEOUT tail is the pilot\'s subject matter: §3.3 samples inbound speed down to 0.3 m/s ' +
  'against a 2.0s cap, so slow injections are still in play when the window closes.';
const GOOD = {
  expectedFlagFraction: 0.13,
  expectedFlags: ['TIMEOUT'],
  reason: GOOD_REASON,
  declaredBy: 'ledger/handoffs/opus2/20260904T150000Z-three-gate-rulings.md §(b)',
};

// --- parseCfgSet: both file shapes ---------------------------------------------------------

test('parseCfgSet: a bare array is today\'s form and declares no premise', () => {
  const r = parseCfgSet([{ cfgId: 'a' }, { cfgId: 'b' }]);
  assert.equal(r.premise, null);
  assert.deepEqual(r.cfgs.map((c) => c.cfgId), ['a', 'b']);
});

test('parseCfgSet: the object form carries a premise alongside the cfgs', () => {
  const r = parseCfgSet({ premise: GOOD, cfgs: [{ cfgId: 'a' }] });
  assert.equal(r.premise.expectedFlagFraction, 0.13);
  assert.deepEqual(r.premise.expectedFlags, ['TIMEOUT']);
  assert.equal(r.cfgs.length, 1);
});

test('parseCfgSet: the object form without a premise is allowed (cfgs is the only required key)', () => {
  const r = parseCfgSet({ cfgs: [{ cfgId: 'a' }] });
  assert.equal(r.premise, null);
});

// --- parseCfgSet: a malformed premise is a wiring error, never a silent skip -----------------

test('parseCfgSet: a premise with no reason is rejected', () => {
  assert.throws(() => parseCfgSet({ premise: { ...GOOD, reason: undefined }, cfgs: [] }), /reason/i);
});

test('parseCfgSet: a token reason is rejected — the exemption has to be arguable', () => {
  assert.throws(() => parseCfgSet({ premise: { ...GOOD, reason: 'timeouts' }, cfgs: [] }),
    new RegExp(String(PREMISE_MIN_REASON_CHARS)));
});

test('parseCfgSet: a premise with no declaredBy is rejected — a claim needs an author', () => {
  assert.throws(() => parseCfgSet({ premise: { ...GOOD, declaredBy: '' }, cfgs: [] }), /declaredBy/i);
});

test('parseCfgSet: expectedFlagFraction must be a fraction in (0, 1]', () => {
  for (const bad of [0, -0.1, 1.5, 'lots', null, NaN]) {
    assert.throws(() => parseCfgSet({ premise: { ...GOOD, expectedFlagFraction: bad }, cfgs: [] }),
      /expectedFlagFraction/i, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('parseCfgSet: expectedFlags must name real flags, non-empty', () => {
  assert.throws(() => parseCfgSet({ premise: { ...GOOD, expectedFlags: [] }, cfgs: [] }), /expectedFlags/i);
  assert.throws(() => parseCfgSet({ premise: { ...GOOD, expectedFlags: ['TIMEOUTS'] }, cfgs: [] }), /TIMEOUTS/);
});

test('parseCfgSet: an unknown premise key is rejected rather than silently ignored', () => {
  // A typo'd `expectedFlagFractoin` that reads as "no ceiling declared" is the exact failure
  // mode this whole mechanism exists to avoid.
  assert.throws(() => parseCfgSet({ premise: { ...GOOD, expectedFlagFractoin: 0.2 }, cfgs: [] }),
    /expectedFlagFractoin/);
});

// --- flagGateResult: the premise is a ceiling that still fails -------------------------------

test('flagGateResult: with no premise, FLAG_GATE_FRACTION is unchanged at 1%', () => {
  assert.equal(FLAG_GATE_FRACTION, 0.01);
  assert.equal(flagGateResult({ trials: 10000, flagged: 100 }).ok, true);
  assert.equal(flagGateResult({ trials: 10000, flagged: 101 }).ok, false);
});

test('flagGateResult: a declared premise raises the ceiling to the declared number', () => {
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  const r = flagGateResult({ trials: 10000, flagged: 1156, premise, flagCounts: { TIMEOUT: 1091, IMPACTS_EXHAUSTED: 65 } });
  assert.equal(r.ok, true);
  assert.equal(r.premiseApplied, true);
  assert.equal(r.gateFraction, 0.13);
});

test('flagGateResult: EXCEEDING the declared premise still fails — an exemption that cannot fail is not a gate', () => {
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  const r = flagGateResult({ trials: 10000, flagged: 1301, premise, flagCounts: { TIMEOUT: 1301 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /declared/i);
  assert.match(r.reason, /13/);
});

test('flagGateResult: a premise can also declare a STRICTER ceiling than 1%', () => {
  const { premise } = parseCfgSet({ premise: { ...GOOD, expectedFlagFraction: 0.002 }, cfgs: [] });
  const r = flagGateResult({ trials: 100000, flagged: 500, premise, flagCounts: { TIMEOUT: 500 } });
  assert.equal(r.ok, false, '0.5% is under the global 1% but over this corpus\'s own declaration');
});

// --- flagGateResult: the premise is narrow ---------------------------------------------------

test('flagGateResult: a flag the premise did NOT declare is still held to FLAG_GATE_FRACTION', () => {
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  // 11% TIMEOUT is declared and fine; 1.5% NAN is not declared and is a solver bug.
  const r = flagGateResult({
    trials: 10000, flagged: 1250, premise,
    flagCounts: { TIMEOUT: 1100, NAN: 150 },
  });
  assert.equal(r.ok, false, 'the undeclared NAN must not ride in under the TIMEOUT declaration');
  assert.match(r.reason, /NAN/);
  assert.deepEqual(r.undeclaredOverGate.map((u) => u.flag), ['NAN']);
});

test('flagGateResult: an undeclared flag UNDER 1% is fine — the premise narrows, it does not forbid', () => {
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  const r = flagGateResult({
    trials: 10000, flagged: 1165, premise,
    flagCounts: { TIMEOUT: 1091, IMPACTS_EXHAUSTED: 65, ESCAPED: 9 },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.undeclaredOverGate, []);
});

test('flagGateResult: a flag the CALLER already excluded from the numerator is not re-gated', () => {
  // Found by running E4 Stage A1 against the first version of this mechanism, which refused it
  // with "STALLED at 56.07% — over the 1% gate and NOT covered by the declared premise".
  // That was wrong. §7's amendment already removes STALLED from E4's numerator ("for a cradle
  // experiment STALLED IS the measurement"), so re-applying the 1% gate to it per-flag
  // reinstated by the back door exactly the exclusion the caller had legitimately made.
  // `excludedFlags` is a different thing from `expectedFlags`: the premise declares an
  // EXPECTED excess and is per-corpus, while this records a STRUCTURAL exclusion already
  // ruled on and is per-experiment. Conflating them would hide that distinction.
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  const counts = { STALLED: 56070, TIMEOUT: 7400, IMPACTS_EXHAUSTED: 269 };
  const withoutExclusion = flagGateResult({ trials: 100000, flagged: 7669, premise, flagCounts: counts });
  assert.equal(withoutExclusion.ok, false, 'STALLED is over 1% and undeclared');

  const withExclusion = flagGateResult({
    trials: 100000, flagged: 7669, premise, flagCounts: counts, excludedFlags: ['STALLED'],
  });
  assert.equal(withExclusion.ok, true, 'once STALLED is declared structurally excluded, it is not re-gated');
  assert.deepEqual(withExclusion.undeclaredOverGate, []);
  assert.deepEqual(withExclusion.excludedFlags, ['STALLED']);
});

test('flagGateResult: flagCounts must be counted the same way the numerator is', () => {
  // Found while regenerating E4 Stage A2. E4's numerator is `flaggedExclStalled`, which
  // stageAWorker computes as `record.f !== 0 && !(record.f & STALLED)` — it drops whole
  // STALLED *trials*, not the STALLED *bit*. So a per-bit IMPACTS_EXHAUSTED count taken over
  // ALL trials is not comparable to it: A2 reads 57.3% IMPACTS_EXHAUSTED per-bit while its
  // excl-stalled numerator is 21.8%, because most of those trials also stalled. Feeding the
  // per-bit count to the per-flag check compares two different populations. The caller must
  // pass counts restricted the same way its numerator is; this test pins the distinction so
  // the two cannot drift apart again.
  const trials = 243400;
  const perBit = { IMPACTS_EXHAUSTED: 139360, TIMEOUT: 36231, STALLED: 184468 };
  const exclStalled = { IMPACTS_EXHAUSTED: 1200, TIMEOUT: 36231, STALLED: 0 };
  const opts = { trials, flagged: 53026, excludedFlags: ['STALLED'] };
  const { premise } = parseCfgSet({ premise: { ...GOOD, expectedFlagFraction: 0.25 }, cfgs: [] });

  const wrongPopulation = flagGateResult({ ...opts, premise, flagCounts: perBit });
  assert.equal(wrongPopulation.ok, false, 'per-bit counts make IMPACTS_EXHAUSTED look like 57%');

  const matched = flagGateResult({ ...opts, premise, flagCounts: exclStalled });
  assert.equal(matched.ok, true, 'counted over the same population as the numerator, it is 0.5%');
});

test('flagGateResult: excludedFlags works without a premise too', () => {
  const r = flagGateResult({
    trials: 100000, flagged: 500, flagCounts: { STALLED: 56000, TIMEOUT: 500 }, excludedFlags: ['STALLED'],
  });
  assert.equal(r.ok, true);
});

test('flagGateResult: excludedFlags must name real flags', () => {
  assert.throws(() => flagGateResult({ trials: 100, flagged: 0, flagCounts: {}, excludedFlags: ['STALLD'] }), /STALLD/);
});

test('premiseHeaderLines: a structural exclusion is named in the header alongside the premise', () => {
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  const text = premiseHeaderLines(premise, { fraction: 0.077, ok: true, excludedFlags: ['STALLED'] }).join('\n');
  assert.match(text, /STALLED/);
  assert.match(text, /excluded/i);
});

test('flagGateResult: a premise with no flagCounts supplied is a wiring error, not a pass', () => {
  // "Not checked" must never read as "passed" — the same rule LAB-21 applied to ranking support.
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  assert.throws(() => flagGateResult({ trials: 10000, flagged: 1156, premise }), /flagCounts/i);
});

// --- the premise is echoed into the summary header -------------------------------------------

test('premiseHeaderLines: the declaration, its author and the actual number all reach the header', () => {
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  const lines = premiseHeaderLines(premise, { fraction: 0.1156, ok: true });
  const text = lines.join('\n');
  assert.match(text, /declared premise/i);
  assert.match(text, /13\.0+%/, 'the declared ceiling is stated');
  assert.match(text, /11\.56%/, 'the actual measured fraction is stated beside it');
  assert.match(text, /TIMEOUT/, 'the flags the premise covers are named');
  assert.match(text, /three-gate-rulings/, 'declaredBy is echoed so the claim can be traced');
  assert.ok(text.includes(GOOD_REASON.slice(0, 60)), 'the written reason is reproduced verbatim');
});

test('premiseHeaderLines: a premise that was EXCEEDED says so in the header, loudly', () => {
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  const text = premiseHeaderLines(premise, { fraction: 0.20, ok: false }).join('\n');
  assert.match(text, /⚠|EXCEEDED/);
  assert.match(text, /20\.00%/);
});

test('premiseHeaderLines: no premise SAYS no premise (was: returned nothing at all)', () => {
  // Superseded by LAB-26. This used to assert `[]`, which made a corpus that declared nothing
  // indistinguishable in the markdown from one that declared and passed. Kept as a test rather
  // than deleted, so the change of behaviour is visible in the history.
  const lines = premiseHeaderLines(null, { fraction: 0.005, ok: true });
  assert.notDeepEqual(lines, []);
  assert.match(lines.join('\n'), /no declared premise/i);
});

// ============================================================================================
// LAB-26: two holes in the mechanism, found by an outside reviewer (opencode) within a dispatch
// of it landing, and reproduced before being closed. Both reproductions are the tests.
// ============================================================================================

test('LAB-26 EXPLOIT 1: a ceiling of 1.0 is not a ceiling — it must be rejected at declaration', () => {
  // Reproduced first: `fraction > ceiling` means 1.0 > 1.0 is false, so a corpus with EVERY
  // trial flagged passed with {ok:true, premiseApplied:true, reason:null}. The design principle
  // was "a premise is a ceiling that still fails"; at 1.0 it cannot fail. The fix is at the
  // declaration, not the comparison — an unfailable ceiling is a malformed claim, not a
  // permissive one.
  assert.throws(
    () => parseCfgSet({ premise: { ...GOOD, expectedFlagFraction: 1.0 }, cfgs: [] }),
    /expectedFlagFraction/i,
    'a ceiling of 1.0 must be a declaration error');
  assert.throws(() => parseCfgSet({ premise: { ...GOOD, expectedFlagFraction: 0.5 }, cfgs: [] }), /expectedFlagFraction/i);
  assert.throws(() => parseCfgSet({ premise: { ...GOOD, expectedFlagFraction: 0.75 }, cfgs: [] }), /expectedFlagFraction/i);
  // The bound is principled rather than arbitrary: a premise may not declare that the MAJORITY
  // of a corpus is flagged. Past half, "expected" stops being an exemption and becomes a
  // description of a broken corpus.
  assert.equal(PREMISE_MAX_CEILING, 0.5);
  assert.equal(parseCfgSet({ premise: { ...GOOD, expectedFlagFraction: 0.49 }, cfgs: [] }).premise.expectedFlagFraction, 0.49);
});

test('LAB-26 EXPLOIT 2: undeclared flags must clear the gate COMBINED, not just individually', () => {
  // Reproduced first: a TIMEOUT-only premise at 13% let NAN, ESCAPED, IMPACTS_EXHAUSTED, CREEP
  // and STALLED each sit at 0.99% — every one individually under the 1% gate, the aggregate
  // under the declared ceiling, and the whole thing passing. That is 4.95% of the corpus
  // carrying an undeclared flag, five times what §2.7 permits. (The reviewer put it at ~18%;
  // that figure adds the declared TIMEOUT back in and double-counts. 4.95% is the real number
  // and it is still five times the gate.)
  //
  // The rule: a premise carves out the flags it NAMES. Everything it does not name must still
  // satisfy the original gate as if no premise existed — combined, not one at a time.
  const { premise } = parseCfgSet({ premise: { ...GOOD, expectedFlagFraction: 0.13 }, cfgs: [] });
  const exploit = { TIMEOUT: 80000, NAN: 9900, ESCAPED: 9900, IMPACTS_EXHAUSTED: 9900, CREEP: 9900, STALLED: 9900 };
  const r = flagGateResult({ trials: 1000000, flagged: 129500, premise, flagCounts: exploit });
  assert.equal(r.ok, false, '4.95% of trials carrying undeclared flags must not pass');
  assert.match(r.reason, /combined|together/i);
  assert.ok(Math.abs(r.undeclaredCombinedFraction - 0.0495) < 1e-9);

  // And the honest corpus is unaffected: undeclared flags well under the gate in total.
  const fine = flagGateResult({
    trials: 1000000, flagged: 105000, premise,
    flagCounts: { TIMEOUT: 100000, IMPACTS_EXHAUSTED: 3000, CREEP: 2000 },
  });
  assert.equal(fine.ok, true, '0.5% combined is under the gate and must still pass');
  assert.ok(Math.abs(fine.undeclaredCombinedFraction - 0.005) < 1e-9);
});

test('LAB-26: a single undeclared flag over the gate is still caught (the old rule is not lost)', () => {
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  const r = flagGateResult({ trials: 10000, flagged: 1250, premise, flagCounts: { TIMEOUT: 1100, NAN: 150 } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.undeclaredOverGate.map((u) => u.flag), ['NAN']);
});

test('LAB-26: an excluded flag is not counted into the combined undeclared total either', () => {
  // E4 removes STALLED from its numerator by §7; it must not be re-admitted through the
  // combined check any more than through the per-flag one.
  const { premise } = parseCfgSet({ premise: GOOD, cfgs: [] });
  const r = flagGateResult({
    trials: 100000, flagged: 7669, premise, excludedFlags: ['STALLED'],
    flagCounts: { STALLED: 56070, TIMEOUT: 7400, IMPACTS_EXHAUSTED: 269 },
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.undeclaredCombinedFraction - 0.00269) < 1e-9);
});

test('LAB-26: no premise means the header SAYS so — unchecked must not look like passed', () => {
  // My own rule, violated by my own code: premiseHeaderLines returned [] for null, so a summary
  // with no declaration and a summary that passed one were indistinguishable in the markdown.
  const lines = premiseHeaderLines(null, { fraction: 0.005, ok: true });
  assert.ok(lines.length > 0, 'absence of a premise must be stated, not silent');
  assert.match(lines.join('\n'), /no declared premise/i);
  assert.match(lines.join('\n'), /0\.50%/);
});
