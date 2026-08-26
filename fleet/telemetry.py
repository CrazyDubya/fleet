import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from . import cost, ledger, transcript
from .paths import LEDGER, transcript_path
from .registry import Registry
from .spec import load_settings

OUT = LEDGER / "telemetry"


def _day_bounds(day: str) -> tuple[float, float]:
    start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    return start, start + 86400


def derive_day(day: str, registry: Registry | None = None, events: list[dict] | None = None,
               out_dir: Path = OUT, default_ttl: int | None = None) -> list[dict]:
    registry = registry or Registry()
    events = ledger.read_events() if events is None else events
    default_ttl = default_ttl or load_settings()["cache_ttl_minutes"]
    lo, hi = _day_bounds(day)
    entries = registry.load()
    recs = []
    for name, e in sorted(entries.items()):
        # Forked children's transcripts live under the PARENT's cwd project
        # dir (see status.resolve_pending_fork_ids) - not the child's own cwd.
        parent = entries.get(e.fork_of) if e.fork_of else None
        transcript_cwd = Path(parent.cwd) if parent else Path(e.cwd)
        all_turns = transcript.parse(transcript_path(transcript_cwd, e.session_id)).turns
        turns = [t for t in all_turns if lo <= t.ts < hi]
        ttl = cost.observed_ttl_minutes(turns, default_ttl)
        uncached = sum(t.input for t in turns); read = sum(t.cache_read for t in turns)
        written = sum(t.cache_5m + t.cache_1h for t in turns); output = sum(t.output for t in turns)
        denom = uncached + read + written
        cold_wakes, cold_usd = 0, 0.0
        # A cold wake is "the first turn after a gap ≥ TTL" - including the
        # overnight boundary, where the previous turn belongs to an earlier
        # day. Anchor the gap sequence on the last turn before `lo` (if any)
        # so that boundary-crossing gap is counted against *this* day, while
        # turns/spend/hit_ratio stay strictly day-scoped (`turns` above).
        prior = [t for t in all_turns if t.ts < lo]
        seq = ([prior[-1]] if prior else []) + turns
        for prev, cur in zip(seq, seq[1:]):
            if (cur.ts - prev.ts) / 60 >= ttl:
                cold_wakes += 1
                cold_usd += cost.resume_cost(cur.cache_5m + cur.cache_1h, e.model, ttl)
        day_events = [x for x in events if lo <= x.get("t", 0) < hi]
        respawns = sum(1 for x in day_events if x.get("ev") == "respawn" and x.get("thread") == name)
        misses = Counter(x.get("reason", "?") for x in day_events if x.get("ev") == "miss" and x.get("thread") == name)
        sent = sum(1 for x in day_events if x.get("ev") == "send" and x.get("from") == name)
        recs.append({
            "day": day, "thread": name, "model": e.model, "turns": len(turns),
            "hit_ratio": (read / denom) if denom else 0.0,
            "cold_wakes": cold_wakes, "cold_wake_usd": cold_usd, "respawns": respawns,
            "misses": dict(misses), "handoffs_sent": sent,
            "output_per_handoff": (output / sent) if sent else 0.0,
            "dollars": cost.spend(turns, e.model).dollars,
        })
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{day}.jsonl").write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in recs))
    return recs


def _load_all(out_dir: Path) -> list[dict]:
    recs = []
    for p in sorted(out_dir.glob("*.jsonl")) if out_dir.is_dir() else []:
        recs += [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    return recs


def report(days: list[str] | None = None, out_dir: Path = OUT) -> str:
    recs = _load_all(out_dir)
    if days:
        recs = [r for r in recs if r["day"] in days]
    by = {}
    for r in recs:
        by.setdefault(r["thread"], []).append(r)
    lines = [f"fleet report — {len({r['day'] for r in recs})} day(s), {len(by)} thread(s)", ""]
    lines.append("1. Is Sonnet's context doing what a hot tier should? (hit ratio > 0.8 between compactions; compaction cadence in days)")
    for r in by.get("sonnet", []):
        lines.append(f"   {r['day']}: hit={r['hit_ratio']:.2f} misses={r['misses']} out/handoff={r['output_per_handoff']:.0f}")
    lines.append("2. Are dormant tiers actually cheap? (cold-wake $ per consult vs handoff size)")
    for th in ("fable", "opus"):
        for r in by.get(th, []):
            lines.append(f"   {th} {r['day']}: cold_wakes={r['cold_wakes']} cold$={r['cold_wake_usd']:.2f} total$={r['dollars']:.2f}")
    lines.append("3. Do tool-threads earn their standing context? (respawns vs turns between them)")
    for th, rs in by.items():
        if th.startswith("haiku"):
            for r in rs:
                lines.append(f"   {th} {r['day']}: respawns={r['respawns']} turns={r['turns']} hit={r['hit_ratio']:.2f}")
    return "\n".join(lines)
