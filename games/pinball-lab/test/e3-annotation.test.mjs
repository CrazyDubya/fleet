// SAMPLECAP-1, annotation half (E3-HEADLINE). Two published runs have a changed headline
// reading once the family samples are corrected. The annotation states the CORRECTED
// characterisation in the summary a reader actually opens — not a warning that the numbers
// moved — without regenerating anything.
//
// The mechanical risk is a block appended twice, so idempotence is pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationBlock, applyAnnotation, BEGIN, END } from '../src/e3FamilyStats.js';

const companion = {
  runId: 'test-run',
  families: {
    P1: { reachedTrials: 100, returnXVariety: 0.8794, timeToReturnMedianS: 2.0292,
          publishedReturnXVariety: 0.4638, publishedTimeToReturnMedianS: 1.7875 },
    P2: { reachedTrials: 100, returnXVariety: 0.8964, timeToReturnMedianS: 1.1583,
          publishedReturnXVariety: 0.9055, publishedTimeToReturnMedianS: 1.1042 },
    P5: { reachedTrials: 100, returnXVariety: 0.9095, timeToReturnMedianS: 0.2208,
          publishedReturnXVariety: 0.8875, publishedTimeToReturnMedianS: 0.0583 },
  },
};

test('the block states the corrected values, not merely that they changed', () => {
  const b = annotationBlock(companion);
  assert.match(b, /0\.8794/, 'corrected P1 variety must appear');
  assert.match(b, /2\.029/, 'corrected P1 median must appear');
  assert.match(b, /0\.2208/, 'corrected P5 median must appear');
});

test('the block names the collapsed separation rather than leaving the reader to infer it', () => {
  // Published variety spread 0.4417 vs corrected 0.0301 — the apparent separation was mostly
  // an artifact, and saying so is the whole point of annotating rather than warning.
  const b = annotationBlock(companion);
  assert.match(b, /0\.030/, 'corrected spread must be stated');
  assert.match(b, /P1/, 'the family whose reading changes must be named');
});

test('the block reports whether the ordering survived', () => {
  // Time-to-return ordering is P5 < P2 < P1 both published and corrected here.
  const b = annotationBlock(companion);
  assert.match(b, /ordering/i);
});

test('applying twice is the same as applying once', () => {
  const md = '# A summary\n\nsome body text\n';
  const b = annotationBlock(companion);
  const once = applyAnnotation(md, b);
  const twice = applyAnnotation(once, b);
  assert.equal(once, twice, 'annotation must be idempotent, not appended again');
  assert.equal((twice.match(new RegExp(BEGIN, 'g')) ?? []).length, 1, 'exactly one begin marker');
  assert.equal((twice.match(new RegExp(END, 'g')) ?? []).length, 1, 'exactly one end marker');
});

test('re-applying a CHANGED block replaces the old one rather than stacking', () => {
  const md = '# A summary\n\nbody\n';
  const first = applyAnnotation(md, annotationBlock(companion));
  const revised = { ...companion, families: { ...companion.families,
    P1: { ...companion.families.P1, returnXVariety: 0.5 } } };
  const second = applyAnnotation(first, annotationBlock(revised));
  assert.match(second, /0\.5000/);
  assert.doesNotMatch(second, /0\.8794/, 'the superseded value must not survive alongside');
});

test('the original summary body is preserved untouched', () => {
  const md = '# A summary\n\n| family | returnRate |\n|---|---|\n| P1 | 0.58 |\n';
  const out = applyAnnotation(md, annotationBlock(companion));
  assert.ok(out.startsWith(md), 'the published text must remain, and remain first');
});
