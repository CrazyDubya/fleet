# Fleet runbook

Daily: `tmux attach -t fleet`; type in the `sonnet` window. `fleet status --watch` in `fleet-home`.

| need | command |
|---|---|
| start the day | `fleet up sonnet && fleet up haiku-fs` (opus/fable on demand) |
| consult fable | `fleet up fable` (or `fleet wake fable` if parked) → sonnet sends a packet → `fleet park fable` after |
| domain expert | write `briefs/<expert>.md`, then `fleet fork opus <expert> --brief briefs/<expert>.md`. This **appends a `[thread.<expert>]` stanza to `fleet.toml`** (parent's model/tier/mcp/dirs/permission_mode/effort, parent's baselines + the new brief, `fork_of`, `forkable = false`) so `wake`/`respawn`/`status` treat it like any other thread. Delete the stanza when you retire the expert. |
| haiku is bloated | `fleet respawn haiku-fs` |
| regenerate the map | `bin/fleet-map`, then `fleet respawn haiku-fs` |
| about to compact | `fleet miss <thread> compaction` (threads do this themselves per brief) |
| message from outside Claude | `fleet send <thread> "text"` |
| numbers | `fleet status` — resume$ vs respawn$ decides wake-vs-respawn for cold threads |

Cache rules baked into the layout: prefix frozen per thread (spec hash flags drift as
STALE-SPEC), 1-h TTL observed from transcripts, haiku never compacts.

`fleet send` takes the whole packet as **one quoted argument** —
`fleet send opus "line one
line two"` — not one argument per line. It is pasted with bracketed paste, so a multi-line
packet arrives as a single message.

## When something is stuck

| symptom | fix |
|---|---|
| `registry locked by another fleet process` and no fleet command is running | a previous run died holding the lock: `rm /Users/pup/fleet/state/registry.lock`, then retry. The registry itself is written atomically, so it is never half-written. |
| a verb reports `claude exited within 3s` | the message and the `spawn_failed` ledger event both carry the pane's last 20 lines; read those before retrying. |
| a thread shows `STALE-SPEC` | its baseline, mcp set, dirs, permission mode or settings file changed since it spawned. `fleet respawn <thread>` to adopt, or revert the file. |
| a forked expert is stuck at `session=pending` | `fleet status` resolves it once the child's first turn lands in the parent's project dir. |

## Nightly telemetry

`ops/com.pup.fleet.telemetry.plist` is the committed copy of the launchd job (fires 23:55
**local**; telemetry days are local days). Install or reinstall it with:

```sh
cp /Users/pup/fleet/ops/com.pup.fleet.telemetry.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.pup.fleet.telemetry.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.pup.fleet.telemetry.plist
```

## Unattended permissions (opt-in, operator's call)

`settings/unattended.json` is a read-only-Bash allowlist plus writes under
`ledger/handoffs/**`. **opus, fable, and haiku-fs are opted in; sonnet (the attended pane)
is not.** To put another thread on it, add to that thread's stanza in `fleet.toml`:

```toml
settings = "settings/unattended.json"
```

then `fleet respawn <thread>` — the file's bytes are part of `spec_hash`, so the thread shows
STALE-SPEC until you do, and editing the allowlist later flags it again.

Two things to know before enabling it:

- **`--settings` merges with `~/.claude/settings.json`; it does not replace it.** Allow rules
  from the user scope still apply and cannot be removed from here. Check that file first.
- An `allow` list does not by itself deny everything else — unmatched tools fall back to the
  thread's `permission_mode`. For a genuinely unattended thread, pair the settings file with a
  non-prompting `permission_mode` in `fleet.toml`. That choice is security-sensitive and
  deliberately left to the operator; the fleet ships the mechanism, not the policy.

## v2 profile (parallel fleet, spec docs/superpowers/specs/2026-08-28-fleet-v2-workflow-design.md)

**v2 is the default profile** (`default_profile = "v2"` in `fleet.toml` `[settings]`); use `FLEET_PROFILE=v1` or `fleet --profile v1 ...` to address the old fleet. Session `fleet2`; threads `sonnet2`,
`opus2`, `haiku-fs2`, `haiku-router2`; state under `state/v2/`.

| need | command |
|---|---|
| start | `fleet up haiku-fs2 && fleet up haiku-router2 && fleet up sonnet2` (opus2 on demand) |
| send a task | `fleet send sonnet2 --lane build --done "<acceptance>" --refs <paths> "<body>"` — effort is a thread property (fleet.toml `effort`, applied at spawn); `@effort` in a packet is advice to the model, not a mode change. `--effort` still sets that header; to actually run a task at a different effort, route it to a thread that spawns with it (e.g. opus2 for the plan lane) |
| sync lookup | `fleet ask haiku-fs2 "<few words>"` (≈2 s; threads use this too) |
| a thread is waiting on a prompt | dashboard → Prompts card → Proceed / Deny (or `fleet decide <thread> <id> allow`) |
| hook stalls | dashboard → Hooks; red rows are blocks or escalations older than 60 s |
| A/B against v1 | same packet to `sonnet` (v1) and `sonnet2`; compare wall-clock to @done, `$` in status, escalate/block counts in Hooks, and operator keypresses |

A first `up` of a `bypassPermissions` thread (haiku-fs2, haiku-router2) blocks on Claude
Code's one-time "Bypass Permissions mode" confirmation dialog until it is accepted
(`tmux send-keys -t fleet2:=<thread> Down` then `Enter`) — expected on the very first spawn
in that thread's directory; `respawn`/`wake` afterward do not re-prompt.

Two live-bring-up findings worth knowing before tuning a v2 brief further:

- **`--settings` hooks stack with `~/.claude/settings.json`, per the note above — including
  any personal Stop hooks.** A machine with a global "flag unverified completion claims" Stop
  hook (e.g. from a `verify-completion-claims.sh`) will fire on *any* v2 thread's reply that
  contains a word like "done"/"complete", including the packet protocol's own `@status done`
  field - this is not a fleet hook and cannot be turned off from `fleet.toml` or a brief. It
  mainly matters for a thread that always emits `@status done` on a fast, single-turn cadence
  (haiku-router2's classification reply): the hook's follow-up round trip can crowd the real
  reply off the tmux pane before `fleet ask`'s polling loop reads it, or - if the follow-up
  wording also reads as a completion claim - snowball into several rounds. `briefs/v2/router.md`
  works around this by using `@status ok` instead of `@status done` for haiku-router2's own
  replies specifically (nothing in fleet parses that field's literal value) and by giving it a
  fixed, non-"done"-sounding line (`(routed)`) to fall back on if the hook fires anyway.
- **`fleet ask`'s pane-matching (`fleet/ask.py:extract_reply`) needs the reply's own `@re
  <id>` header, not just a same-looking bare block** - a multi-turn exchange (e.g. the Stop
  hook round trip above) can redraw the pane enough that the thread's own echoed `@id` line is
  no longer visible, so the match no longer requires it as an anchor. If `fleet ask` still
  times out against a thread that clearly answered (check with
  `tmux capture-pane -p -t fleet2:=<thread> -S -100`), suspect a brief that lets the thread run
  a tool or add prose before/after its reply - that widens the window in which the pane can be
  redrawn before the reply is captured.

## Bench (spec docs/superpowers/specs/2026-08-29-fleet-bench-design.md)

| need | command |
|---|---|
| run everything, three arms | `fleet bench run all` (sequential; ≈ tasks × arms × minutes) |
| one task, cheap arms | `fleet bench run lookup-newest-handoff --arms sonnet,fleet` |
| the numbers | `fleet bench report [--since 2026-08-29]` — `$` is API-rate; `weekly$`/`fable$` split the same `$` by subscription pool (shares, not balances) |
| add a task | drop `bench/tasks/<id>.toml` (see the four there); `check` must exit 0 on success; `judge` is optional |
| what the fleet arm measures | the fleet arm enters at `sonnet2` (the fleet's front door); haiku/opus spend appears in its rows only when sonnet2 delegates — that is the fleet being measured, not a shortcut |
| nightly | `cp ops/com.pup.fleet.bench.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.pup.fleet.bench.plist` (sonnet + fleet arms; run the fable arm by hand) |
| leftovers | each `fleet bench run` first sweeps `gui/widgets/bench<run>` and `bench/work/*` older than a day, printing what it removed. Outside the repo it also leaves one `~/.claude/projects/-Users-pup-fleet-bench-work-*` dir per single-turn arm-run (~4/night) — those are just headless transcripts, safe to delete once the rows are written: `rm -rf ~/.claude/projects/-Users-pup-fleet-bench-work-*` |
