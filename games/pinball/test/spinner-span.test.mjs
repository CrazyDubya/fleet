// Guard for opus2's whole-table audit finding: TETHERBALL's crossing zone was 16mm and
// PINWHEEL's was 30mm, both well under their shared 50mm blade mesh — the visible blade
// extends past where a crossing actually registers. This is the one audit item tonight where
// physics follows art rather than the other way around: the blade IS the physical spinner,
// so its rendered length should be exactly the crossing zone's span, sourced from one shared
// constant (mech.SPINNER_BLADE_LENGTH) rather than a spinner-builder literal and a
// mesh-builder literal that happened to agree with neither the audit nor each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mech from '../src/table/mechanisms.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MAIN_JS = path.join(root, 'src/main.js');

function zoneSpan(zone) {
  return Math.hypot(zone.b.x - zone.a.x, zone.b.y - zone.a.y);
}

test('SPINNER_BLADE_LENGTH is exported and both spinner zones span exactly that length', () => {
  assert.ok(typeof mech.SPINNER_BLADE_LENGTH === 'number', 'expected mech.SPINNER_BLADE_LENGTH to be exported');
  const spinners = mech.buildSpinners();
  assert.ok(
    Math.abs(zoneSpan(spinners.tetherball) - mech.SPINNER_BLADE_LENGTH) < 1e-9,
    `tetherball zone span ${zoneSpan(spinners.tetherball)} != SPINNER_BLADE_LENGTH ${mech.SPINNER_BLADE_LENGTH}`
  );
  assert.ok(
    Math.abs(zoneSpan(spinners.pinwheel) - mech.SPINNER_BLADE_LENGTH) < 1e-9,
    `pinwheel zone span ${zoneSpan(spinners.pinwheel)} != SPINNER_BLADE_LENGTH ${mech.SPINNER_BLADE_LENGTH}`
  );
});

test('the rendered blade mesh reads its length from mech.SPINNER_BLADE_LENGTH, not a duplicated literal', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const m = src.match(/const rod = coloredMesh\(new THREE\.BoxGeometry\(([^,]+),\s*0\.006,\s*0\.006\)/);
  assert.ok(m, 'expected to find the spinner blade BoxGeometry call in main.js');
  assert.equal(
    m[1].trim(), 'mech.SPINNER_BLADE_LENGTH',
    `blade length must read mech.SPINNER_BLADE_LENGTH, not a hardcoded literal — got "${m[1].trim()}"`
  );
});

test('spinner zone centres are unchanged by the span fix (only the span grew)', () => {
  const spinners = mech.buildSpinners();
  const tetherballMid = { x: (spinners.tetherball.a.x + spinners.tetherball.b.x) / 2, y: (spinners.tetherball.a.y + spinners.tetherball.b.y) / 2 };
  const pinwheelMid = { x: (spinners.pinwheel.a.x + spinners.pinwheel.b.x) / 2, y: (spinners.pinwheel.a.y + spinners.pinwheel.b.y) / 2 };
  assert.ok(Math.abs(tetherballMid.x - -0.17) < 1e-9 && Math.abs(tetherballMid.y - 0.38) < 1e-9, 'tetherball zone must stay centred at (-0.170, 0.38)');
  assert.ok(Math.abs(pinwheelMid.x - -0.06) < 1e-9 && Math.abs(pinwheelMid.y - 0.43) < 1e-9, 'pinwheel zone must stay centred at (-0.060, 0.43)');
});
