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
