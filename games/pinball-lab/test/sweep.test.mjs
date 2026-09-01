// LAB-2 grid builders (§3.3): cfg-count arithmetic is the whole point of these functions —
// get it wrong and Stage A/B silently spend the wrong fraction of the mandated 1,000,000
// balls. Also checks the Stage A screen's 9-policy reduced set and Stage B's 42-point set are
// what the geometry/policy sweep tables actually specify.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeometryGrid, buildStageAPolicies, buildE1StageACfgs,
  buildStageBPolicies, buildE1StageBCfgs, buildE1CradleCfgs,
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
