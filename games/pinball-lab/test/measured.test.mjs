// Slice 1 of the scalar-guard design (ledger/handoffs/opus2/20260905T174929Z-scalar-guard-spec.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rate, analytic, indeterminate, unmeasured, fmt, Measured } from '../src/measured.js';

test('rate: Wilson interval against a known value (k=1, n=11000)', () => {
  // Cross-checked against the spec's own worked example (§11): "Wilson CI for the one-event
  // row [0.0016%, 0.0515%]".
  const m = rate(1, 11000, { estimand: 'shot rate' });
  assert.equal(m.kind, 'measured');
  assert.ok(Math.abs(m.value - 1 / 11000) < 1e-12);
  const [lo, hi] = m.ci;
  assert.ok(Math.abs(lo * 100 - 0.0016) < 0.001, `lo=${lo * 100}`);
  assert.ok(Math.abs(hi * 100 - 0.0515) < 0.001, `hi=${hi * 100}`);
});

test('rate: a textbook Wilson interval (k=50, n=100) matches the standard reference value', () => {
  // Widely cited reference: Wilson 95% CI for 50/100 is [0.4038, 0.5962].
  const m = rate(50, 100, { estimand: 'test' });
  assert.ok(Math.abs(m.ci[0] - 0.4038) < 0.001);
  assert.ok(Math.abs(m.ci[1] - 0.5962) < 0.001);
});

test('rate(0, 0): zero trials returns unmeasured, with NO value field at all', () => {
  const m = rate(0, 0, { estimand: 'anything' });
  assert.equal(m.kind, 'unmeasured');
  assert.equal('value' in m, false, 'a writer reading .value must get undefined, not a fabricated 0');
  assert.equal(m.value, undefined);
});

test('rate: requires estimand', () => {
  assert.throws(() => rate(1, 10, {}), /estimand is required/);
  assert.throws(() => rate(1, 10), /estimand is required/);
});

test('rate: rejects k > n and negative/non-integer inputs', () => {
  assert.throws(() => rate(11, 10, { estimand: 'x' }), /k must be an integer in \[0, n=10\]/);
  assert.throws(() => rate(-1, 10, { estimand: 'x' }));
  assert.throws(() => rate(1.5, 10, { estimand: 'x' }));
  assert.throws(() => rate(1, -1, { estimand: 'x' }));
});

test('fmt: throws on a bare number — there is no way to publish a number through the wall without evidence attached', () => {
  assert.throws(() => fmt(0.45), /expected a Measured value/);
  assert.throws(() => fmt(0), /expected a Measured value/);
  assert.throws(() => fmt(undefined), /expected a Measured value/);
  assert.throws(() => fmt({ value: 0.45 }), /expected a Measured value/);
});

test('fmt and template-literal interpolation both print the accompanied form, not a bare number', () => {
  const m = rate(1, 11000, { estimand: 'shot rate' });
  const viaFmt = fmt(m);
  const viaTemplate = `${m}`;
  assert.equal(viaFmt, viaTemplate);
  assert.match(viaFmt, /^0\.009% \(1 event \/ 11,000, 95% CI 0\.0016%–0\.051\d%\)$/);
});

test('a rate with k>=2 pluralizes "events" correctly, k=1 does not', () => {
  assert.match(`${rate(1, 100, { estimand: 'x' })}`, /1 event \//);
  assert.match(`${rate(2, 100, { estimand: 'x' })}`, /2 events \//);
});

test('toJSON: measured/unmeasured/analytic/indeterminate each serialize only their own real fields', () => {
  const measured = rate(3, 100, { estimand: 'x' });
  const measuredJson = JSON.parse(JSON.stringify(measured));
  assert.equal(measuredJson.kind, 'measured');
  assert.equal(measuredJson.k, 3);
  assert.equal(measuredJson.n, 100);
  assert.ok(Array.isArray(measuredJson.ci));
  assert.equal(measuredJson.method, 'wilson');

  const un = unmeasured('no trials', { estimand: 'x' });
  const unJson = JSON.parse(JSON.stringify(un));
  assert.equal('value' in unJson, false);
  assert.equal(unJson.why, 'no trials');

  const an = analytic(0.5, 'computed from geometry', { estimand: 'x' });
  const anJson = JSON.parse(JSON.stringify(an));
  assert.equal(anJson.value, 0.5);
  assert.equal(anJson.kind, 'analytic');
  assert.equal('ci' in anJson, false, 'analytic has no interval — nothing to report there');

  const ind = indeterminate(0.7, 'bootstrap not yet wired', { n: 50, estimand: 'x' });
  const indJson = JSON.parse(JSON.stringify(ind));
  assert.equal(indJson.kind, 'indeterminate');
  assert.equal(indJson.n, 50);
});

test('analytic/indeterminate/unmeasured all require their own why/estimand', () => {
  assert.throws(() => analytic(1, '', { estimand: 'x' }));
  assert.throws(() => analytic(1, 'ok', {}));
  assert.throws(() => indeterminate(1, '', { estimand: 'x' }));
  assert.throws(() => unmeasured('', { estimand: 'x' }));
  assert.throws(() => unmeasured('ok', {}));
});

test('toString reads plainly for the non-measured kinds', () => {
  assert.match(`${unmeasured('zero trials', { estimand: 'x' })}`, /^unmeasured \(zero trials\)$/);
  assert.match(`${analytic(0.5, 'computed from geometry', { estimand: 'x' })}`, /analytic — computed from geometry/);
  assert.match(`${indeterminate(0.7, 'bootstrap not yet wired', { n: 50, estimand: 'x' })}`, /n=50.*bootstrap not yet wired/);
});

test('every constructor returns a real Measured instance (fmt accepts all of them)', () => {
  for (const m of [
    rate(1, 10, { estimand: 'x' }),
    rate(0, 0, { estimand: 'x' }),
    analytic(1, 'why', { estimand: 'x' }),
    indeterminate(1, 'why', { estimand: 'x' }),
    unmeasured('why', { estimand: 'x' }),
  ]) {
    assert.ok(m instanceof Measured);
    assert.equal(typeof fmt(m), 'string');
  }
});
