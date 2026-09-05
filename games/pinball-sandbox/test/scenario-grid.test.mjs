// Grid sweeps (SBX-GRID-1): a scenario run over two swept parameters, reported as a matrix.
// See src/scenarios.js's own doc comment for why (this week's throwaway scripts were all
// exactly this shape, done by hand, once).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenarioGrid, formatGrid } from '../src/scenarios.js';

test('sweeps two parameters into an NxM matrix, one independent cell per combination', () => {
  const g = runScenarioGrid('arc-containment', {
    xPath: 'ball.speed', xValues: [1, 3, 6],
    yPath: 'ball.offset', yValues: [0, 0.005, 0.01],
    extract: (r) => r.contained,
  });
  assert.equal(g.cells.length, 3, 'one row per xValue');
  for (const row of g.cells) assert.equal(row.length, 3, 'one column per yValue');
  for (const row of g.cells) {
    for (const cell of row) assert.equal(cell.ok, true);
  }
});

test('determinism: cell order never affects a cell\'s own result (no state carried between cells)', () => {
  // Run the full grid, then run a handful of the SAME individual cells again in reverse order —
  // if anything were shared/mutated across cells, running them in a different order would
  // change at least one answer. It must not.
  const speeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const g1 = runScenarioGrid('arc-containment', {
    xPath: 'ball.speed', xValues: speeds,
    yPath: 'ball.offset', yValues: [0],
    extract: (r) => r.contained,
  });
  const g2 = runScenarioGrid('arc-containment', {
    xPath: 'ball.speed', xValues: [...speeds].reverse(),
    yPath: 'ball.offset', yValues: [0],
    extract: (r) => r.contained,
  });
  const valuesInOrder1 = g1.cells.map((row) => row[0].value);
  const valuesInReverseOrder2 = [...g2.cells.map((row) => row[0].value)].reverse();
  assert.deepEqual(valuesInOrder1, valuesInReverseOrder2, 'same cells, different run order, must agree');
});

test('a cell that fails to run is a hole in the matrix, never a value that reads as a result', () => {
  const g = runScenarioGrid('arc-containment', {
    xPath: 'durationS', xValues: [0, -1, 1.0], // first two are non-positive: 0 physics steps
    yPath: 'ball.speed', yValues: [3, 6],
    extract: (r) => r.contained,
  });
  assert.equal(g.cells[0][0].ok, false);
  assert.equal(g.cells[0][1].ok, false);
  assert.equal(g.cells[1][0].ok, false);
  assert.equal(g.cells[1][1].ok, false);
  assert.equal(g.cells[2][0].ok, true, 'a positive duration in the same grid must still run fine');
  assert.equal(g.cells[2][1].ok, true);
  assert.equal(g.summary.holeCount, 4);
  // The hole must be VISIBLE in the rendered shape, not silently absorbed into true/false.
  assert.equal(g.summary.ascii[0], '??');
  assert.equal(g.summary.ascii[1], '??');
});

test('formatGrid renders the ASCII shape and a hole/monotonic summary, not a wall of raw values', () => {
  const g = runScenarioGrid('arc-containment', {
    xPath: 'ball.speed', xValues: [1, 6],
    yPath: 'ball.offset', yValues: [0],
    extract: (r) => r.contained,
  });
  const text = formatGrid(g);
  assert.ok(text.includes('##') || text.includes('.'), 'must render the ascii shape');
  assert.ok(text.includes('holes:'));
  assert.ok(text.includes('monotonic:'));
  assert.ok(!/true,true,true/.test(text), 'must not just dump raw per-cell values');
});

test('measured: the realistic flipper-speed x offset containment grid for this channel is fully contained, no islands', () => {
  // The real question this grid answers (per SBX-GRID-1's own framing): where's the boundary,
  // is it monotonic, are there islands. Measured here, not assumed: for THIS channel's own
  // geometry, swept across the full realistic flipper-tip speed range and a spread of lateral
  // offsets, containment holds everywhere — a real, reportable finding (see scenarios.js's own
  // arc-containment doc comment on why this does NOT reproduce sonnet2's differently-dimensioned
  // channel's escape at 6/7.5 m/s).
  const g = runScenarioGrid('arc-containment', {
    xPath: 'ball.speed', xValues: [0.5, 1.5, 3, 4.5, 6, 8],
    yPath: 'ball.offset', yValues: [-0.005, 0, 0.005],
    extract: (r) => r.contained,
  });
  assert.equal(g.summary.holeCount, 0);
  assert.equal(g.summary.monotonic, true, 'no islands in this grid');
  for (const row of g.summary.ascii) assert.equal(row, '###', `every cell must be contained; got row "${row}"`);
});

test('a non-boolean extract() degrades to a stated no-summary note, not a broken/fabricated shape read', () => {
  const g = runScenarioGrid('arc-containment', {
    xPath: 'ball.speed', xValues: [3, 6],
    yPath: 'ball.offset', yValues: [0],
    extract: (r) => r.maxY, // a number, not a boolean
  });
  assert.ok(g.summary.note, 'must explicitly say it has no shape summary for this grid, not guess one');
  assert.equal(typeof g.cells[0][0].value, 'number');
});

test('omitting extract() keeps full per-cell reports, with an explicit note instead of a summary', () => {
  const g = runScenarioGrid('arc-containment', {
    xPath: 'ball.speed', xValues: [3, 6],
    yPath: 'ball.offset', yValues: [0],
  });
  assert.equal(typeof g.cells[0][0].value, 'object');
  assert.equal(g.cells[0][0].value.name, 'arc-containment');
  assert.ok(g.summary.note);
});
