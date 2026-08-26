# Fleet runbook

Daily: `tmux attach -t fleet`; type in the `sonnet` window. `fleet status --watch` in `fleet-home`.

| need | command |
|---|---|
| start the day | `fleet up sonnet && fleet up haiku-fs` (opus/fable on demand) |
| consult fable | `fleet up fable` (or `fleet wake fable` if parked) → sonnet sends a packet → `fleet park fable` after |
| domain expert | write `briefs/<expert>.md`, then `fleet fork opus <expert> --brief briefs/<expert>.md` |
| haiku is bloated | `fleet respawn haiku-fs` |
| regenerate the map | run the block in `maps/repo.md`'s header, then `fleet respawn haiku-fs` |
| about to compact | `fleet miss <thread> compaction` (threads do this themselves per brief) |
| message from outside Claude | `fleet send <thread> "text"` |
| numbers | `fleet status` — resume$ vs respawn$ decides wake-vs-respawn for cold threads |

Cache rules baked into the layout: prefix frozen per thread (spec hash flags drift as
STALE-SPEC), 1-h TTL observed from transcripts, haiku never compacts.
