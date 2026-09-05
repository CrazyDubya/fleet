// LAB-25: E5a draws a GEOMETRY/MODEL verdict from a Pearson r over its assemblies, and until
// now applied no validity guard to the axis that correlation is computed against.
//
// The regenerated E5a run (post-LAB-23 solver, 135 cfgs, 180,000 trials) has 15 assemblies of
// which NINE share `hsSPredicted` = 0.0000 exactly — 7 distinct x values across 15 rows, 60%
// tied at one. The published r = 0.845 is carried by two rows (shotRate 0.2064 and 0.4564)
// while the other thirteen sit at 0.0000-0.0477. That is the LAB-16 family of mistake in a
// correlation rather than a ranking: a conclusion drawn from a metric that cannot carry it.
//
// No new threshold is invented here. `rankingValidityResult`'s existing population test — the
// one that asks "can this column support an ordering at all" — already answers it: 60% tied
// against a 50% ceiling. These tests pin that the axis fails it, so the verdict must be gated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankingValidityResult, RANKING_MAX_TIE_BLOCK_FRACTION } from '../src/gate.js';

// The real axis, read off data/summaries/e5a-lab25.json.
const HSS_AXIS = [
  0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000, 0.0000,
  0.0159, 0.0411, 0.0677, 0.1033, 0.1364, 0.1896,
];

test('LAB-25: E5a\'s hsS axis fails the existing validity guard — 60% of rows tied at one value', () => {
  const g = rankingValidityResult(HSS_AXIS);
  assert.equal(g.ok, false, 'an axis with 9 of 15 rows identical cannot carry a correlation verdict');
  assert.equal(g.distinctCount, 7);
  assert.ok(g.maxTieFraction > RANKING_MAX_TIE_BLOCK_FRACTION,
    `${g.maxTieFraction} should exceed the ${RANKING_MAX_TIE_BLOCK_FRACTION} ceiling`);
  assert.match(g.reason, /tied at one value/);
});

test('LAB-25: a well-spread axis of the same length passes, so the guard is not just rejecting n=15', () => {
  const spread = Array.from({ length: 15 }, (_, i) => i / 14);
  assert.equal(rankingValidityResult(spread).ok, true);
});

test('LAB-25: the guard is what distinguishes them, not the correlation value', () => {
  // Both axes below produce a high Pearson r against a matching y; only one is trustworthy.
  // This is the point: r alone cannot tell you whether its x-axis had any resolution.
  const degenerate = rankingValidityResult(HSS_AXIS);
  const sound = rankingValidityResult(Array.from({ length: 15 }, (_, i) => i / 14));
  assert.notEqual(degenerate.ok, sound.ok);
});
