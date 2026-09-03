// LAB-2 grid builders (§3.3): cfg-count arithmetic is the whole point of these functions —
// get it wrong and Stage A/B silently spend the wrong fraction of the mandated 1,000,000
// balls. Also checks the Stage A screen's 9-policy reduced set and Stage B's 42-point set are
// what the geometry/policy sweep tables actually specify.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeometryGrid, buildStageAPolicies, buildE1StageACfgs,
  buildStageBPolicies, buildE1StageBCfgs, buildE1CradleCfgs,
  buildE5aAssemblies, buildE5aCfgs, E4_STAGEC_UPMS, E4_STAGEC_RELEASE_DELAY_MS,
  assertUniqueCfgIds, withCfgIds,
} from '../src/sweep.js';

test('§3.3 geometry grid is exactly 6x3x6x4x3x3 = 3,888 cfgs, all cfgIds unique', () => {
  const geoms = buildGeometryGrid();
  assert.equal(geoms.length, 3888);
  const ids = new Set(geoms.map((g) => JSON.stringify(g)));
  assert.equal(ids.size, 3888, 'no duplicate geometries');
});

test('Stage A reduced policy set is 9: never + 6 fixedDelay + 2 proximity', () => {
  const policies = buildStageAPolicies();
  assert.equal(policies.length, 9);
  assert.equal(policies.filter((p) => p.pol === 'never').length, 1);
  assert.equal(policies.filter((p) => p.pol === 'fixedDelay').length, 6);
  assert.equal(policies.filter((p) => p.pol === 'proximity').length, 2);
});

test('Stage A cfgs: 3,888 geometries x 9 policies = 34,992, every cfgId unique', () => {
  const cfgs = buildE1StageACfgs();
  assert.equal(cfgs.length, 34992);
  assert.equal(new Set(cfgs.map((c) => c.cfgId)).size, 34992);
  assert.ok(cfgs.every((c) => c.exp === 'e1'));
});

test('Stage B full policy set: never + 21 fixedDelay + 20 proximity = 42', () => {
  const policies = buildStageBPolicies();
  assert.equal(policies.length, 42);
  assert.equal(policies.filter((p) => p.pol === 'never').length, 1);
  const delays = policies.filter((p) => p.pol === 'fixedDelay').map((p) => p.d);
  assert.equal(delays.length, 21);
  assert.deepEqual(delays, Array.from({ length: 21 }, (_, i) => i * 10));
  assert.equal(policies.filter((p) => p.pol === 'proximity').length, 20);
});

test('Stage B cfgs: N geometries x 42 policies, cfgIds unique', () => {
  const geoms = buildGeometryGrid().slice(0, 24);
  const cfgs = buildE1StageBCfgs(geoms);
  assert.equal(cfgs.length, 24 * 42);
  assert.equal(new Set(cfgs.map((c) => c.cfgId)).size, cfgs.length);
});

test('cradle cfgs: one per geometry, pol heldActive, cradle true', () => {
  const geoms = buildGeometryGrid().slice(0, 24);
  const cfgs = buildE1CradleCfgs(geoms);
  assert.equal(cfgs.length, 24);
  assert.ok(cfgs.every((c) => c.pol === 'heldActive' && c.cradle === true));
});

// LAB-10 / E5a (release diagnostic): the whole point is a stratified spread of hsS —
// not a rank-by-cp top-N the way Stage C's assemblies were — so the strongest possible test
// is "the assemblies actually span a wide hsS range", not just a count.
test('E5a assemblies span a wide hsS range, not clustered at one point', () => {
  const assemblies = buildE5aAssemblies();
  assert.ok(assemblies.length >= 10, `expected a real spread of assemblies, got ${assemblies.length}`);
  const hsSVals = assemblies.map((a) => a.hsSPredicted);
  assert.ok(hsSVals.every((h) => h >= 0 && h <= 1), 'hsS is the classifySettle-matching clamped [0,1] projection');
  const spread = Math.max(...hsSVals) - Math.min(...hsSVals);
  assert.ok(spread > 0.1, `expected hsS spread > 0.1 across the sample, got ${spread}`);
  // Sorted, no duplicate (guide, activeAngleDeg, radius) triples.
  const keys = new Set(assemblies.map((a) => `${a.gapX}|${a.tiltDeg}|${a.endDy}|${a.guideE}|${a.activeAngleDeg}|${a.radius}`));
  assert.equal(keys.size, assemblies.length);
});

test('E5a cfgs: assemblies x upMs x releaseDelayMs, holdThenRelease + release:true throughout', () => {
  const { cfgs, assemblyCount } = buildE5aCfgs();
  assert.ok(cfgs.length <= assemblyCount * E4_STAGEC_UPMS.length * E4_STAGEC_RELEASE_DELAY_MS.length);
  assert.ok(cfgs.every((c) => c.pol === 'holdThenRelease' && c.release === true && c.arm === 'E5a'));
  assert.equal(new Set(cfgs.map((c) => c.cfgId)).size, cfgs.length);
});

// P1-3 interim fix: assertUniqueCfgIds is the guard every grid builder now runs through
// (directly, or via withCfgIds). Test the guard itself with a genuine collision — two cfgs
// that hash identically because they ARE identical, not a mocked hash function — plus that
// withCfgIds (the choke point 17 of ~20 builders route through) actually calls it.
test('assertUniqueCfgIds throws, naming the label and the colliding id, on a genuine duplicate', () => {
  const dupe = { exp: 'e1', pol: 'never', restAngleDeg: -50 };
  const cfgs = withCfgIds([{ ...dupe }, { exp: 'e1', pol: 'fixedDelay', d: 0 }], 'unrelated-label');
  const withRealDupe = [...cfgs, { ...cfgs[0] }]; // cfgId already attached: a true repeat, not a rehash
  assert.throws(
    () => assertUniqueCfgIds(withRealDupe, 'testBuilder'),
    (err) => err.message.includes('testBuilder') && err.message.includes(cfgs[0].cfgId),
    'expected the guard to name both the calling builder and the colliding cfgId',
  );
});

test('withCfgIds itself throws when two distinct-looking inputs hash to the same cfg', () => {
  // Two cfg objects that are genuinely the same parameter set (key order differs, cfgId's
  // sort-keys-deep hash makes them collide for real) — not a mock, an actual duplicate.
  const a = { exp: 'e1', pol: 'never', d: 5 };
  const b = { d: 5, pol: 'never', exp: 'e1' };
  assert.throws(
    () => withCfgIds([a, b], 'buildFakeDuplicateCfgs'),
    (err) => err.message.startsWith('buildFakeDuplicateCfgs: duplicate cfgId'),
  );
});
