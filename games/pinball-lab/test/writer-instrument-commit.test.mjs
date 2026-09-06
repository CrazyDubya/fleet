// A corpus that cannot name its instrument commit cannot be audited from itself — opus2 hit
// this directly auditing E4/E5a (ledger/handoffs/opus2/20260904T130000Z-lab-corpus-solver-fix-
// audit.md): those two report writers never printed `instrumentCommitSha` into their markdown
// summary, so which physics commit produced a corpus had to be recovered from raw run
// directories' meta.json instead of read off the summary itself. E1 (lab2Report.js/
// aggregate.js), E2 (e2Report.js) and E3 (stageA.js's e3ToMarkdown) all already do this
// correctly — this guards ALL of them together so the E4/E5a gap can't reopen, and a future
// writer can't repeat it either.
//
// These are CLI scripts (`main()` called unconditionally at module scope, no
// `import.meta.url` guard on four of the five) — importing one doesn't crash (a missing-args
// `main()` prints usage and returns), but it sets `process.exitCode = 1` as a side effect of
// merely importing the module, which would make this test FILE's own exit status wrong
// regardless of what any assertion below finds. e4Report.js is the one exception (it guards
// `main()` behind `import.meta.url` and exports `toMarkdown`), but building a realistic
// `summary` object for its `toMarkdown` — rankingGuard/equivalenceClasses for three tables,
// e1Decomposition, pocketMap, releaseDispersion, etc. — is exactly the kind of shape-coupled
// fixture that breaks on the next unrelated refactor, the same failure mode this file exists
// to avoid. Source-text extraction (same idiom as games/pinball/test/glue-scope.test.mjs) is
// the pragmatic choice here — MEASURED-3B (BRITTLE-1) made it tolerant of a function's
// PARAMETER LIST (matched by name only, `\([^)]*\)`) rather than an exact signature, so it
// still fails only on the property it actually cares about: does this writer's markdown ever
// reference `instrumentCommitSha`. A future writer's `toMarkdown(x, y, z)` won't break this
// test just by adding a fourth parameter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'src');

/** The body of a `function <name>(...) { ... }` declaration, via brace counting from its first
 * `{` to the matching `}` — robust to nested braces (template literals, object literals). */
function extractFunctionBody(src, signaturePattern) {
  const m = src.match(signaturePattern);
  assert.ok(m, `expected to find a function matching ${signaturePattern} in source`);
  // The match's own last character is the opening brace (every pattern above ends with
  // `\{`) — searching src.indexOf('{', m.index) instead would find a `{` inside a default
  // parameter value first (e.g. "rankingGuardFallback = {}"), well before the real one.
  const start = m.index + m[0].length - 1;
  assert.equal(src[start], '{', 'signature pattern must end with the opening brace itself');
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces looking for function body end');
}

/** Text between two markers (inclusive of neither) — for a writer whose markdown block is
 * inline in `main()` rather than its own named function. */
function extractBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `expected to find "${startMarker}" in source`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end >= 0, `expected to find "${endMarker}" after the start marker`);
  return src.slice(start, end);
}

const WRITERS = [
  {
    label: 'E1 LAB-2 (lab2Report.js toMarkdown)',
    file: 'lab2Report.js',
    extract: (src) => extractFunctionBody(src, /function toMarkdown\([^)]*\)\s*\{/),
  },
  {
    label: 'E1 Stage A aggregate (aggregate.js toMarkdown)',
    file: 'aggregate.js',
    extract: (src) => extractFunctionBody(src, /function toMarkdown\([^)]*\)\s*\{/),
  },
  {
    label: 'E2 (e2Report.js toMarkdown)',
    file: 'e2Report.js',
    extract: (src) => extractFunctionBody(src, /function toMarkdown\([^)]*\)\s*\{/),
  },
  {
    label: 'E3 (stageA.js e3ToMarkdown)',
    file: 'stageA.js',
    extract: (src) => extractFunctionBody(src, /function e3ToMarkdown\([^)]*\)\s*\{/),
  },
  {
    label: 'E4 (e4Report.js toMarkdown)',
    file: 'e4Report.js',
    extract: (src) => extractFunctionBody(src, /function toMarkdown\([^)]*\)\s*\{/),
  },
  {
    label: 'E5a (e5aReport.js, inline markdown block in main())',
    file: 'e5aReport.js',
    extract: (src) => extractBetween(src, 'lines.push(`# E5a', "writeFileSync(path.join('data/summaries', `e5a-"),
  },
];

for (const w of WRITERS) {
  test(`${w.label} emits the instrument commit into its markdown summary`, () => {
    const src = fs.readFileSync(path.join(SRC, w.file), 'utf8');
    const body = w.extract(src);
    assert.ok(
      /instrumentCommitSha/.test(body),
      `${w.file}'s ${w.label} markdown block never references instrumentCommitSha — a corpus ` +
      `this writer produces cannot be audited from its own summary (must recover the commit ` +
      `from raw run meta.json instead, as opus2 had to for E4/E5a)`
    );
  });
}
