// §2.4: "All randomness comes from makeRng(...) — never Math.random, never a wall-clock
// read. runner.js may call performance.now() for throughput reporting only; it must never
// reach a trial." profile.js is the same category as runner.js (a throughput-reporting CLI,
// not a trial) and is exempted from the performance.now() check for the same reason; neither
// it nor runner.js may use Math.random/Date.now, since nothing here needs actual wall-clock
// dates or non-deterministic randomness, only monotonic timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.join(import.meta.dirname, '..', 'src');
// stageA.js (LAB-2's batched Stage A screen runner) and lab2Report.js (its aggregator) are
// the same category as runner.js/profile.js/aggregate.js: orchestration CLIs, never a trial.
const TIMING_ALLOWED = new Set(['runner.js', 'profile.js', 'stageA.js']);
// e2Report.js is the same category as lab2Report.js: an orchestration CLI writing a summary
// timestamp, never a trial.
// e4Report.js (LAB-6) is the same category: an orchestration CLI writing a summary timestamp.
const WALLCLOCK_ALLOWED = new Set(['runner.js', 'stageA.js', 'lab2Report.js', 'e2Report.js', 'e4Report.js']); // Date.now/new Date() — meta.json/summary timestamps only

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

test('purity: no Math.random anywhere in src/', () => {
  for (const file of walk(SRC_DIR)) {
    const content = readFileSync(file, 'utf8');
    assert.ok(!/Math\.random/.test(content), `${path.relative(SRC_DIR, file)} calls Math.random — all randomness must come from the game's seeded makeRng`);
  }
});

test('purity: no Date.now/new Date() outside runner.js', () => {
  for (const file of walk(SRC_DIR)) {
    const name = path.basename(file);
    if (WALLCLOCK_ALLOWED.has(name)) continue;
    const content = readFileSync(file, 'utf8');
    assert.ok(!/Date\.now\(\)|new Date\(/.test(content), `${path.relative(SRC_DIR, file)} reads the wall clock — only runner.js may (for meta.json timestamps)`);
  }
});

test('purity: no performance.now() outside runner.js/profile.js, and it never reaches instrument.js', () => {
  for (const file of walk(SRC_DIR)) {
    const name = path.basename(file);
    if (TIMING_ALLOWED.has(name)) continue;
    const content = readFileSync(file, 'utf8');
    assert.ok(!/performance\.now\(\)/.test(content), `${path.relative(SRC_DIR, file)} calls performance.now() — only runner.js/profile.js may, for throughput reporting`);
  }
});
