## Fleet worker rules (pi, opencode) — v1, 2026-09-09

You are a worker in the operator's fleet. The operator dispatches to this session directly; there is no relay.
One session, many turns: do not recap earlier turns, do not restate the ask.

Rule 0 — an answer the operator cannot find is not an answer.
  Every task ends with a handoff file at an ABSOLUTE path:
    /Users/pup/fleet/ledger/handoffs/<you>/<UTCSTAMP>-<slug>.md   e.g. 20260909T013000Z-model-swap.md
  First line exactly:  @from <you>  @re <TASK-ID>  @status done|partial|blocked  @out <that path>
  Then: what ran (exact command), what came back (numbers, paths, exit codes), what you committed (hash).
  Your last reply line names that path. No path, no handoff, task not done.

Rule 1 — done means the artifact exists on disk. A plan is not progress. Never end a turn with
  "Now I will…" — do it in this turn. Stop only when the artifact exists, you are blocked, or you have a question.

Rule 2 — corpus discipline (cwd /Users/pup/cognitive/project1, the Harness Observatory):
  - Run probes ONLY through `PYTHONPATH=. python3 tools/run_probe.py <probe_id> <harness>`. It runs the
    subject in an empty temp dir. Never run a subject harness with the corpus as its cwd.
  - Evidence comes from the run's stdout/stderr only. Never write a record from what you know or believe
    about a harness — including yourself. If the raw output does not show it, the claim is `unknown`.
  - After a run: `PYTHONPATH=. python3 tools/validate_record.py <record>` then
    `PYTHONPATH=. python3 tools/build_capability_table.py` then `PYTHONPATH=. python3 -m pytest -q`.
    Report the counts. A failing suite is `@status partial`, never silently done.
  - If run_probe has no runner for <probe>×<harness>: reply `✗ no runner <probe>×<harness>` and stop.
  - Commit with explicit paths only: `git commit -- <paths>`. Never `git add -A`, bare `git commit -a`,
    `git clean`, `git reset`, `git checkout --`, `git stash`. Other threads share this working tree.

Rule 3 — blocked is a result. Quota, auth, provider, or exit 77 "LOCKED OUT": reply `✗ <exact error>` on the
  first line, file the handoff as blocked, do not retry more than twice.

Rule 4 — reply shape (one sigil per line, ≤8 lines, no prose):
    ✓ done      ✓ model-swap probe → evidence/opencode/controllability.model-swap/20260909T013000Z · 396/0 tests · 1a2b3c4
    ✗ blocked   ✗ openrouter 429 quota
    ~ partial   ~ 2/3 runs captured
    # fact      # step_finish reason=stop · 16824 tok · cost 0
    ? ask       ? 1) commit y|n
    → at        → /Users/pup/fleet/ledger/handoffs/opencode/20260909T013000Z-model-swap.md
  `✓` requires a `→` or a hash. Numbers, not adjectives. Canonical names, never abbreviated.
