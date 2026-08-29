# Fleet bench — design

Date: 2026-08-29. Status: approved in brainstorm; spec for review.

## Why

The fleet's goal is to be more accurate and cheaper than a single Fable turn, at an acceptable
time cost. Today that is one A/B sample (2026-08-29: fleet v2 104 s / 0 keypresses / judge 21
vs v1 102 s / 1 / 20; single-turn Fable 109 s to first-servable, ~10× the tokens). One sample is
not a claim. `fleet bench` turns it into a routine measurement with verifiable numbers.

Operator's cost model (binding): the API-rate `$` stays as the headline, verifiable metric;
beside it the subscription view — Fable is its own pool; the weekly pool is shared by opus ≫
sonnet ≫ haiku, so several haiku calls are cheaper than one opus call.

## Scope

- Verb `fleet bench run <task|all> [--arms fable,sonnet,fleet] [--repeat N]` and
  `fleet bench report [--since DAY]`.
- Task files `bench/tasks/*.toml`; rubrics `bench/rubrics/*.md`; work dirs `bench/work/<run>/`
  (gitignored).
- Rows appended to `ledger/bench/runs.jsonl`.
- Dashboard widget `gui/widgets/bench/`.
- Nightly launchd job `ops/com.pup.fleet.bench.plist` (sonnet + fleet arms).
- Initial task set: four lane replays (build: GUI slice-2 widget; lookup: newest handoff +
  first 3 lines; plan: design the workspace widget; judge: compare two widgets) plus ~10
  synthetic build tasks with pytest checks, added as further `.toml` files.

Out of scope: statistical significance tests, multi-machine runs, allowance *balance* (the CLI
does not expose pool size; shares only).

## Decisions

- **Accuracy = executable check + judge on passes.** Every task has a `check` command; exit 0
  is pass. A task may have a rubric; an opus judge scores 0–5 only on passing runs, so judge
  cost is bounded and the objective gate is never overridden by taste.
- **Three arms.** `fable` and `sonnet` single-turn (headless `claude -p`), and `fleet` (v2,
  the default profile). The sonnet arm answers "is a fleet worth it at all"; the fable arm is
  the reference the goal is stated against.
- **Measure with the production parser.** Tokens per model come from `fleet.transcript.parse`
  windowed to [t0, t1] — the same code path `fleet status` trusts. The fleet arm's window
  covers every registered v2 thread, so coordination cost (router, hooks, lookups) is inside
  the number, not hidden.
- **Sequential arms.** One arm-run at a time so token windows never overlap.
- **Hooks on for every arm.** Single-turn arms get `--settings settings/v2/hot.json`, so
  escalations land on the dashboard the same way and interventions are comparable.

## Task definition

```toml
id = "gui-slice2"
lane = "build"                 # lookup | build | plan | judge
packet = """…{refs}… Done when POST /w/{target}/push renders a card."""
refs = ["ledger/handoffs/opus/20260829T021451Z-gui-design.md"]
target = "gui/widgets/bench-{run}"     # {run} substituted per arm-run; arms never collide
done = "POST /w/{target}/push renders a card on the dashboard"
check = "curl -sf … http://127.0.0.1:8787/w/{target}/push | grep -q name"
judge = "bench/rubrics/widget.md"      # optional; only if check passes
timeout_s = 900
cleanup = "rm -rf {target}"            # run by the bench after measurement
```

Substitutions: `{run}`, `{target}`, `{refs}` (space-joined), `{root}`. A task with no `judge`
is scored by `check` alone (lookup tasks: `grep -q <expected>` on the reply).

## Runner

Per arm-run: allocate `run` (16-hex, `packet.new_id()`), substitute, record `t0`, execute,
wait for done, record `t1`, run `check`, judge if pass and rubric present, run `cleanup`,
append the row. On any exception: row with `status: error` and the message; continue with the
next arm-run.

| arm | execute | done | measured transcripts |
|---|---|---|---|
| fable / sonnet | `claude -p --model <m> --session-id <uuid> --permission-mode acceptEdits --add-dir <ROOT> --settings settings/v2/hot.json --strict-mcp-config <packet>`; cwd `bench/work/<run>/`; stdout saved to `bench/work/<run>/stdout.txt` | process exit (killed at `timeout_s`) | `~/.claude/projects/<key of cwd>/<uuid>.jsonl` |
| fleet | `send.send_packet(Packet(to="sonnet2", lane, refs, done, id=run, reply="file"))` | a file under `ledger/handoffs/sonnet2/` newer than t0 containing `@re <run>`, or the sonnet2 pane showing `@re <run>  @status` (whitespace-insensitive, as `fleet ask` does); else timeout | every thread in the active profile's registry, windowed to [t0, t1] |

Timeout: `status: timeout`, check not run (counts as fail); fleet arm also runs
`fleet miss sonnet2 bench-timeout-<run>` to clear pending state.

Single-turn arms need the GUI server for the build task's check; the bench starts it if
`:8787` is not listening and stops it afterwards only if it started it.

## Row schema (`ledger/bench/runs.jsonl`)

```json
{"run":"…","task":"gui-slice2","arm":"fleet","t0":0,"t1":0,"wall_s":104.2,
 "status":"pass|fail|timeout|error","check_rc":0,"judge":4,"judge_path":"ledger/handoffs/judge/….md",
 "interventions":{"keypress":0,"decide":1,"escalate":1,"block":2},
 "tokens":{"<model>":{"input":0,"cache_read":0,"cache_write":0,"output":0}},
 "usd":0.31,
 "pool":{"weekly":{"opus":0.0,"sonnet":0.31,"haiku":0.02},"fable":0.0},
 "commit":"8084737","error":null}
```

- `usd` = `fleet.cost.spend` at the API rate table, summed over models.
- `pool` = the same `$` split by pool: `fable` for `claude-fable-*`; `weekly.{opus,sonnet,haiku}`
  for the rest. Shares, not balances.
- `interventions` = ledger events in [t0, t1]: `keypress` (GUI keypress route), `decide`
  (`fleet decide` / GUI Proceed-Deny), `escalate` and `block` (hook events).
- `commit` = `git rev-parse --short HEAD` at run time.

## Report

`fleet bench report [--since DAY]`: per task, per arm — n, pass rate, median wall, median `$`,
pool split, interventions/run, median judge. Then three headline lines with ratios
fleet÷sonnet and fleet÷fable: accuracy (pass rate), cost (`$` and weekly-pool `$` per pass),
time (median wall per pass). Every line shows n.

## Widget

`gui/widgets/bench/` (`WATCH ledger/bench/runs.jsonl`): three headline cards, per-task
pass/fail sparkline over time, last-run strip. Standard widget contract; no host changes.

## Nightly

`ops/com.pup.fleet.bench.plist`: 03:00 local, `fleet bench run all --arms sonnet,fleet`.
The fable arm is manual (own pool; run when the operator wants the reference refreshed).

## Judge lane

`bench/rubrics/<name>.md` is the scoring rubric; the bench dispatches a fresh opus session
(`claude -p --model claude-opus-5`) with the rubric, the task's `done`, and the run's artifact
paths, asking for a single integer 0–5 on the last line and a write-up saved to
`ledger/handoffs/judge/<UTC>-<run>.md`. Never a fork of the author (protocol rule 8).

## Testing

- Unit: task loading/substitution; window slicing of `Turn` lists; pool split; row schema;
  report aggregation on a fixture `runs.jsonl`; done-detection on pane/handoff fixtures.
- Live (skipped unless `fleet2` is up): one `lookup` task end to end on the fleet arm; one on
  the sonnet arm with a 60 s timeout.

## Risks

- Headless `claude -p` behaviour (hooks, `--settings`) may differ from the TUI; the live test
  is the guard. If `-p` ignores `PermissionRequest` hooks, single-turn interventions read 0 by
  construction — the report must say so rather than imply superiority.
- Judge variance (22/20 → 20/21 on the same task): report medians with n, and keep the
  objective `check` as the gate.
- Sequential arms make a full pass slow (≈ tasks × arms × timeout worst case); the nightly
  job runs only two arms.
