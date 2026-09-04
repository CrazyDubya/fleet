// Slice 2 guard: the sandbox must register the exact same capture zones and ramp gates the
// real game does — not a plausible-looking reimplementation that can silently drift from the
// table. Neither main.js (pinball's or the sandbox's) can be imported under `node --test` (both
// import 'three' as a bare specifier, resolved only by a browser import map — see
// games/pinball/test/glue-scope.test.mjs), so this combines two checks:
//   1. Resolve the shared builders directly (pure data, safely importable) and assert their
//      actual count/centre/radius — the real numbers this parity check is about.
//   2. Source-text-extract each main.js's setCaptureZones/setLayerZones call and assert BOTH
//      wire the exact same builder-derived expression. If the game's wiring ever changes and
//      the sandbox's doesn't (or vice versa), this fails — that's the drift guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMerryGoRound } from '../../pinball/src/table/mechanisms.js';
import { buildSandbox, buildSlideRamp, buildMonkeyBarsRamp, buildTunnelRamp } from '../../pinball/src/table/ramps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_ROOT = path.join(here, '..');
const SANDBOX_MAIN_JS = path.join(SANDBOX_ROOT, 'src', 'main.js');
const PINBALL_MAIN_JS = path.join(SANDBOX_ROOT, '..', 'pinball', 'src', 'main.js');

test('capture zones: count, centres and radii from the shared builders, wired identically in both main.js files', () => {
  const sandbox = buildSandbox();
  const mgr = buildMerryGoRound();
  const zones = [sandbox.captureZone, mgr.captureZone];

  assert.equal(zones.length, 2, 'expected exactly two capture zones: sandbox_entry and merry_go_round');
  assert.deepEqual(zones[0].centre, { x: -0.01, y: 0.56 });
  assert.equal(zones[0].radius, 0.022);
  assert.deepEqual(zones[1].centre, { x: 0.01, y: 0.9 });
  assert.equal(zones[1].radius, 0.075);

  const expectedCall = "setCaptureZones(world, 'playfield', [sandbox.captureZone, merryGoRound.captureZone])";
  const gameSrc = fs.readFileSync(PINBALL_MAIN_JS, 'utf8');
  const sandboxSrc = fs.readFileSync(SANDBOX_MAIN_JS, 'utf8');
  assert.ok(
    gameSrc.includes(expectedCall),
    `expected the game's main.js to contain exactly: ${expectedCall}`
  );
  assert.ok(
    sandboxSrc.includes(expectedCall),
    `expected the sandbox's main.js to contain exactly: ${expectedCall} — it must register the ` +
    `same two capture zones the game does, not a reimplementation that can drift from it`
  );
});

test('ramp gates: all three built from the shared builders, wired into setLayerZones in both main.js files', () => {
  const slide = buildSlideRamp();
  const monkeyBars = buildMonkeyBarsRamp();
  const tunnel = buildTunnelRamp();

  for (const [name, gate, layer] of [
    ['slide', slide.gate, 'slide'],
    ['monkeyBars', monkeyBars.gate, 'monkeybars'],
    ['tunnel', tunnel.gate, 'tunnel'],
  ]) {
    assert.equal(gate.kind, 'zone', `expected ${name}.gate to be a Gate shape (kind: 'zone')`);
    assert.ok(typeof gate.a?.x === 'number' && typeof gate.a?.y === 'number', `${name}.gate.a must be a real point`);
    assert.ok(typeof gate.b?.x === 'number' && typeof gate.b?.y === 'number', `${name}.gate.b must be a real point`);
    assert.equal(gate.gate.toLayer, layer, `${name}.gate must switch the ball onto the "${layer}" ramp layer`);
  }

  const gameSrc = fs.readFileSync(PINBALL_MAIN_JS, 'utf8');
  const sandboxSrc = fs.readFileSync(SANDBOX_MAIN_JS, 'utf8');
  for (const gateExpr of ['slide.gate', 'monkeyBars.gate', 'tunnel.gate']) {
    assert.ok(gameSrc.includes(gateExpr), `expected the game's main.js to wire ${gateExpr} into a zones list`);
    assert.ok(
      sandboxSrc.includes(gateExpr),
      `expected the sandbox's main.js to wire ${gateExpr} into a zones list — same gate the game uses, not a reimplementation`
    );
  }
});

test('all three ramps are added to the world via addRamp in both main.js files', () => {
  const gameSrc = fs.readFileSync(PINBALL_MAIN_JS, 'utf8');
  const sandboxSrc = fs.readFileSync(SANDBOX_MAIN_JS, 'utf8');
  for (const rampExpr of ['addRamp(world, slide.ramp)', 'addRamp(world, monkeyBars.ramp)', 'addRamp(world, tunnel.ramp)']) {
    assert.ok(gameSrc.includes(rampExpr), `expected the game's main.js to contain: ${rampExpr}`);
    assert.ok(sandboxSrc.includes(rampExpr), `expected the sandbox's main.js to contain: ${rampExpr}`);
  }
});
