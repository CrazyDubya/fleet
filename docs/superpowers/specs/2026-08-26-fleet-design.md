# Fleet — Design (2026-08-26)

Status: approved in discussion 2026-08-26; spec written for implementation planning.
Leverages `/Users/pup/cognitive` (Harness Observatory, Cognitive Torture Rig) — its ledger
conventions, its episode/handoff discipline, its evidence about Claude Code's resume/fork
behaviour. Separate project; `cognitive` is a dependency of ideas, not of code.

## 1. Purpose

A personal daily fleet of long-running Claude Code sessions ("threads"), one per model tier,
each with a prebuilt, frozen baseline, coordinated by a layer that contains **no reasoning**:
a registry, a launcher, a status reader, and a messenger. Every action the layer performs is
one the operator could type by hand. It is not a harness; Claude Code is the harness.

Tiers (fixed by the operator):

| thread | model | tier | persistence | role |
|---|---|---|---|---|
| sonnet | claude-sonnet-5 | hot | singular, persistent, compacts | daily driver; the pane the operator types in; delegates |
| opus | claude-opus-5 | warm | on demand; forkable into domain experts | day-to-day planner |
| fable | claude-fable-5 | dormant | on demand, light standing context | strategic consultant; brought in, not active by default |
| haiku-* | claude-haiku-4-5 | tool | disposable: never compact, respawn from spec | file-system / grep / mechanical workhorses with prebuilt context |

Haiku threads carry prebuilt context so Sonnet's delegation is a few words: the expensive
token in a delegation is Sonnet's output composing the prompt, not Haiku's input.

## 2. Non-goals

- No routing logic, no model calls inside the layer, no own agent loop.
- No message storage: messages are handoffs; files are memory (§6).
- No replacement of Claude Code's own subagents — Sonnet still uses `Agent` for one-off
  bounded work; fleet threads are for continuity and independence.
- No TUI beyond a refreshing status view in v1. A read-only transcript presenter is a
  later, optional addition.

## 3. Layout

```
/Users/pup/fleet/
  fleet.toml            thread specs (stdlib tomllib; zero dependencies)
  briefs/<thread>.md    baseline appended to each thread's system prompt
  maps/                 prebuilt context for tool-threads (repo maps, conventions)
  mcp/<set>.json        frozen MCP server sets, referenced by name from specs
  state/registry.json   name -> session_id, cwd, tmux target, spec_hash, status, lineage
  ledger/events.jsonl   spawn / park / wake / fork / respawn / compact / send / miss-reason
  ledger/handoffs/      deliverables written by consulted threads (their memory)
  <thread>/             one cwd per thread, named exactly as the thread (sonnet/ opus/ fable/ haiku-fs/ …);
                        the existing /Users/pup/{sonnet,opus,fable,haiku} move here, haiku → haiku-fs
  bin/fleet             the CLI
  fleet/                python package: spec, registry, launcher, status, send, ledger
```

Claude Code keys sessions to cwd, so each thread has its own directory; that directory holds
only `.claude/` and whatever the thread writes. Moving the four existing dirs under `fleet/`
restarts their (minutes-old) sessions — accepted.

## 4. Thread spec (`fleet.toml`)

```toml
[thread.sonnet]
model = "claude-sonnet-5"
tier = "hot"
persist = "singular"          # singular | on-demand | respawn
baseline = ["briefs/sonnet.md"]
mcp = "core"                  # mcp/core.json, passed with --strict-mcp-config
dirs = ["/Users/pup"]         # --add-dir
permission_mode = "default"

[thread.opus]
model = "claude-opus-5"
tier = "warm"
persist = "on-demand"
baseline = ["briefs/opus.md"]
forkable = true

[thread.fable]
model = "claude-fable-5"
tier = "dormant"
persist = "on-demand"
baseline = ["briefs/fable.md"]
resume_policy = "packet-first"   # packet-first | trajectory  (see §7)

[thread.haiku-fs]
model = "claude-haiku-4-5"
tier = "tool"
persist = "respawn"
baseline = ["briefs/haiku-fs.md", "maps/repo.md"]
effort = "low"
```

A spec's hash (model + baseline contents + mcp set + dirs + permission mode) is stored in the
registry at spawn; `fleet status` flags a thread whose spec changed since spawn (its baseline
is stale, its cache prefix is not).

Experts and extra tools are new `[thread.<name>]` entries with `fork_of = "opus"` or a
different baseline. Nothing in the spec is interpolated per run: **the prefix is frozen**.

## 5. Verbs

All verbs shell to `claude` and `tmux` and write a ledger event. tmux session `fleet`, one
window per thread.

| verb | effect |
|---|---|
| `fleet up <t>` | mint UUID; `cd <t>/ && claude --model … --name <t> --session-id <uuid> --append-system-prompt-file … [--mcp-config mcp/<set>.json --strict-mcp-config] [--add-dir …] [--permission-mode …]` in a new tmux window; registry: running. Implementation ruling: `--strict-mcp-config` is ALWAYS passed — without it `claude` auto-discovers `.mcp.json` in ancestor dirs (`/Users/pup/.mcp.json`) and blocks on a first-run trust dialog, and the prefix would depend on files outside the spec |
| `fleet park <t>` | kill the window; registry keeps session_id; status parked |
| `fleet wake <t>` | same command with `--resume <session_id>` from the same cwd; status running |
| `fleet fork <parent> <new> --brief briefs/<new>.md` | `--resume <parent_id> --fork-session --name <new> --append-system-prompt-file briefs/<new>.md`; registry entry with `fork_of` |
| `fleet respawn <t>` | new UUID, fresh session from spec; old id archived in registry lineage; the never-compact rule for tool-threads |
| `fleet send <t> "<msg>"` | tmux `load-buffer` + `paste-buffer` into the thread's pane, prefixed `[fleet:<from>]`; Claude Code queues typed input while busy. Sonnet→thread uses native `SendMessage` instead — `send` exists for the operator and for scripts |
| `fleet ls` / `fleet status [--watch]` | §8 |
| `fleet miss <t> <reason>` | records a deliberate cache miss (compaction, fresh-start) with its reason — threads are briefed to call this before compacting |

## 6. Protocol rules (written into every brief)

1. **Message = handoff, file = memory.** A consulted thread writes any decision or deliverable
   to `ledger/handoffs/<thread>/<ts>-<slug>.md` before replying; the reply cites the path.
2. **Packets, not transcripts.** A consult carries objective + file pointers; never pasted
   context. The receiver reads what it needs.
3. **The prefix is frozen.** No thread changes its MCP set, permission mode, CLAUDE.md, or
   baseline mid-life. A different baseline is a fork or a respawn.
4. **Deliberate misses are logged** with a reason (`fleet miss`). Compaction, fresh-start,
   respawn are methodological choices, not failures.
5. **Tier rules.** Haiku never compacts — respawn. Sonnet compacts. Opus/Fable are consulted
   packet-first; resume only when the accumulated trajectory is the point (§7).
6. **Independence when it matters.** A critic/judge of another thread's work is a fresh
   thread or a non-fork subagent, never the author's fork.

## 7. Cache model (the numbers the layer keeps visible)

Prompt cache is prefix-exact and model-scoped; a cross-thread handoff is a miss by
construction, so the only handoff lever is packet size. Within a thread, on this account's
1-hour TTL: reads ≈0.1× base input, writes 2× base (1.25× on 5-min TTL). A thread idle
> 60 min pays a full rewrite of its context on the next turn.

Rates ($/M, input / output): sonnet 2/10, opus 5/25, fable 10/50, haiku 1/5.

Derived per thread from its transcript (`~/.claude/projects/<cwd-key>/<session_id>.jsonl`,
per-turn `usage`: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
`output_tokens`). Verified 2026-08-26: a child spawned with `--resume <parent> --fork-session`
writes its transcript under the PARENT cwd's project key, not its own cwd; status/telemetry
resolve forked threads via `fork_of` (pending ids = newest transcript in the parent's dir that
is not the parent's own).

- **warmth** — minutes since last assistant turn: hot < 45, cooling 45–60, cold > 60.
- **context size** ≈ last turn's `input + cache_read + cache_creation` (the current prefix).
- **spend** — cumulative cached-read / written / output tokens and dollars.
- **resume-vs-respawn** for a cold thread: resume ≈ context × 2 × input rate;
  respawn ≈ baseline tokens × 2 × input rate. Shown side by side so `resume_policy` is a
  number, not a vibe.

`resume_policy = "packet-first"` means `wake` warns when resume cost exceeds respawn cost
and the last handoff is already in the ledger; `"trajectory"` resumes without asking.

## 8. Status view

`fleet status` prints one row per registered thread: name, model, tier, state
(new/busy/idle/parked/archived — state is derived, so "running" never appears; a registry
entry says running, the transcript says busy or idle), warmth with minutes, context tokens, session $ (cached / written /
output), spec-stale flag, last handoff path. `--watch` refreshes every 10 s. Busy/idle comes
from the transcript's last record type; alive comes from the tmux window. No API calls.

## 9. Error handling

- `claude` exits non-zero on spawn → registry stays unchanged, event `spawn_failed` with
  stderr tail; verb exits 1.
- Registry session_id has no transcript yet (fresh spawn, no turn) → status shows `new`,
  context 0; not an error.
- `wake` on a running thread, `park` on a parked one → no-op with a message.
- Transcript parse errors on a line → skip the line, count it, show `?` for affected fields.
- Two `fleet` processes: the registry is written atomically (tmp + rename) under a lock
  file; the lesson from the thesis test's supervisor collision.

## 10. Testing (no mocks — real `claude`, real tmux)

1. `up haiku-fs` → tmux window exists, registry has running entry, transcript appears after
   one `send`; the sent text is a user turn in the transcript.
2. `park` then `wake` with a planted fact → the woken session recalls it (resume works from
   the moved cwd).
3. `fork opus expert-x --brief …` → new session id, `fork_of = opus`, and the brief text is
   present in the child's first system prompt record and absent from the parent's.
4. `respawn haiku-fs` → new id, old id in lineage, window replaced.
5. `status` against a transcript with hand-summed usage → dollars match to the cent;
   warmth transitions verified by timestamp arithmetic on a synthetic-timestamp copy.
6. `miss` writes the event; `status` shows the reason on the row until the next turn.
7. Registry lock: two concurrent `up` calls → exactly one succeeds, one reports the lock.

Unit-level pure functions (spec hashing, usage summation, warmth, cost) get plain
`unittest` tests on fixture transcripts copied from real sessions.

## 11. Relationship to `cognitive`

- Ledger/handoff conventions are P2's, thinned: events + handoff files, no SQLite.
- Thread specs are P1's phenotype axes (model, POV/baseline, persistence scope, arity via
  fork) instantiated as sessions.
- Track 1 (in `cognitive`): P2 gains a resident-session continuity mode driven by messages,
  and both projects gain cache read/write as a measured dimension. The fleet's threads are
  the executors for that verification run.

## 12. Resolved questions

- Haiku as threads (with prebuilt context) rather than only subagents — operator's call,
  justified by Sonnet output cost. Subagents remain for one-offs.
- `send` from outside Claude is tmux paste, not a helper model call.
- Location `/Users/pup/fleet`; the four model dirs move under it.
- TOML over YAML: stdlib, zero dependencies.

## 12a. Open after first bring-up (2026-08-26)

- **Permission mode for unattended tiers.** `fleet.toml` spawns every thread with
  `permission_mode = "default"`, so opus's first Bash call (reading the ledger, per its brief)
  stalled on an interactive approval nobody was watching; the sonnet→opus `SendMessage` leg
  worked. Options: `acceptEdits` (still prompts on Bash), a per-thread `--settings` allowlist
  for read-only Bash + writes under `ledger/handoffs/<thread>/`, or `bypassPermissions` for
  opus/fable/haiku-fs. Security-sensitive — operator's call. Changing it changes `spec_hash`,
  so it lands as a respawn.

## 13. Telemetry the fleet emits, what `cognitive` can use, and how quality is judged over time

The fleet is a live, daily-use instance of exactly what P1 probes and P2 simulates. Its
transcripts and ledger are therefore evidence, provided they are recorded in a shape the
other projects can consume without re-deriving.

### 13.1 What is captured (all derived from files; nothing self-reported by a model)

Per thread, per turn (from the session jsonl): timestamp, `input`, `cache_read`,
`cache_creation`, `output`, thinking tokens, model, tool-call count, and whether the turn was
the first after an idle gap and how long that gap was. Per thread, per lifecycle event (from
`ledger/events.jsonl`): spawn/park/wake/fork/respawn/compact/miss with reason, spec hash,
session lineage. Per handoff (from `ledger/handoffs/`): from-thread, to-thread, packet bytes,
time to reply, path of the deliverable.

Derived, appended nightly to `ledger/telemetry/YYYY-MM-DD.jsonl`:

| metric | meaning | who uses it |
|---|---|---|
| cache hit ratio per thread per day | `cache_read / (input + cache_read + cache_creation)` | fleet status; P1 as observed resume/idle behaviour on real cadence |
| cost of each cold wake | tokens rewritten × 2 × rate, tied to the idle gap that caused it | validates the resume-vs-respawn estimator; P2's resume/fresh cost model |
| packet size vs reply latency vs handoff outcome | is the "packets not transcripts" rule actually cheaper and no worse | P2 context-manifest sizing; the parent prompt's Q6 (smallest useful durable state) |
| deliberate-miss log | reason distribution: compaction / respawn / fresh-for-independence | P2 continuity-choice policy evidence |
| respawn count per Haiku thread and context at respawn | when tool-thread context bloats and how fast | sizing `maps/`; P1 phenotype persistence-scope evidence |
| fork fidelity | did an expert forked from Opus need re-briefing (measured by an explicit `rebrief` event) | P1 branching evidence on real use |
| spec-stale days | how long a thread runs on a baseline that has since changed | prefix-freezing discipline compliance |

### 13.2 Long-term quality assessment

The fleet's quality is not "did the layer work" — that is the test suite — but whether the
tiering pays off over weeks. Three questions, each answerable from the telemetry alone:

1. **Is Sonnet's context doing what a hot tier should?** Its cache hit ratio should stay
   high (> 0.8) between compactions and its compaction cadence should be days, not hours. If
   compactions cluster, the daily driver is absorbing work that belongs in Haiku tools or
   handoff files — the metric to watch is Sonnet's output tokens per handoff sent.
2. **Are dormant tiers actually cheap?** Fable/Opus cold-wake cost per consult vs the
   consult's handoff size. If cold wakes dominate, `resume_policy` should flip to
   packet-first (or already is and is being overridden — the `miss` log shows which).
3. **Do tool-threads earn their standing context?** Haiku respawn frequency vs work done
   between respawns; a tool that respawns every few calls has a baseline too small to be
   worth caching and should be a subagent instead.

A monthly `fleet report` prints these three with the trend; the decision each one drives is
written in the report (rebalance tiers, resize baselines, demote a tool-thread). Quality
regressions are expected to show up as cache hit ratio falling or cold-wake cost rising
before they show up as the operator noticing slowness.

### 13.3 Data quality caveats, stated up front

- Transcript `usage` is authoritative for tokens but silent on TTL: warmth is inferred from
  timestamps against a known 1-hour TTL, so if the account's TTL changes, the estimator is
  wrong until `fleet.toml` says otherwise (`cache_ttl_minutes`, default 60).
- Busy/idle is inferred from the last transcript record; a thread mid-tool-call looks busy,
  a thread waiting on a permission prompt looks idle. Acceptable for status, not for billing.
- Nothing is sampled; every turn is recorded. Retention: raw transcripts are Claude Code's
  (its own retention); the fleet keeps derived telemetry indefinitely — it is small.
