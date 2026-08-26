import time
from dataclasses import dataclass
from pathlib import Path

from . import cost, ledger, tmux, transcript
from .paths import ROOT, transcript_path
from .registry import Registry
from .spec import load_settings, load_specs, spec_hash


@dataclass
class Row:
    name: str
    model: str
    tier: str
    state: str
    warmth: str
    idle_minutes: int
    context: int
    read: int
    written: int
    output: int
    dollars: float
    spec_stale: bool
    last_handoff: str | None
    miss_reason: str | None
    resume_usd: float
    respawn_usd: float
    errors: int


def resolve_pending_fork_ids(registry: Registry) -> None:
    # `claude --resume <parent-session> --fork-session` writes the child's
    # transcript into the *parent's* project directory (keyed off the
    # parent's original cwd), not the child's own cwd - verified by hand: a
    # forked "expert-test" child's session lands under
    # ~/.claude/projects/-Users-pup-fleet-opus/, alongside opus's own
    # transcript, never under -Users-pup-fleet-expert-test/. So look there,
    # and skip the parent's own already-known session file when picking the
    # newest candidate.
    entries = registry.load()
    changed = False
    for e in entries.values():
        if e.session_id != "pending":
            continue
        parent = entries.get(e.fork_of) if e.fork_of else None
        search_cwd = Path(parent.cwd) if parent else Path(e.cwd)
        exclude = parent.session_id if parent else None
        d = transcript_path(search_cwd, "x").parent
        files = sorted((p for p in d.glob("*.jsonl") if p.stem != exclude),
                        key=lambda p: p.stat().st_mtime) if d.is_dir() else []
        if files:
            e.session_id = files[-1].stem; changed = True
    if changed:
        registry.save(entries)


def _baseline_bytes(thread) -> int:
    return sum((ROOT / b).stat().st_size for b in thread.baseline if (ROOT / b).exists())


def rows(now: float | None = None, registry: Registry | None = None, specs=None) -> list[Row]:
    now = now or time.time()
    registry = registry or Registry()
    specs = specs or load_specs()
    default_ttl = load_settings()["cache_ttl_minutes"]
    resolve_pending_fork_ids(registry)
    out = []
    for name, e in sorted(registry.load().items()):
        t = specs.get(name)
        parsed = transcript.parse(transcript_path(Path(e.cwd), e.session_id))
        turns = parsed.turns
        ttl = cost.observed_ttl_minutes(turns, default_ttl)
        last_turn_ts = turns[-1].ts if turns else None
        w, idle = cost.warmth(last_turn_ts, now, ttl)
        if e.status in ("parked", "archived"):
            state = e.status
        elif not turns:
            state = "new"
        elif parsed.last_type == "user" or turns[-1].stop_reason == "tool_use":
            state = "busy"
        else:
            state = "idle" if tmux.window_exists(name) else "parked"
        sp = cost.spend(turns, e.model)
        ctx = cost.context_size(turns)
        miss = ledger.last_miss(name)
        hand = ledger.last_handoff(name)
        out.append(Row(
            name=name, model=e.model, tier=(t.tier if t else "?"), state=state, warmth=w, idle_minutes=idle,
            context=ctx, read=sp.read, written=sp.written, output=sp.output, dollars=sp.dollars,
            spec_stale=bool(t) and spec_hash(t) != e.spec_hash,
            last_handoff=(str(hand.relative_to(ROOT)) if hand else None),
            miss_reason=(miss["reason"] if miss and miss["t"] > (last_turn_ts or 0) else None),
            resume_usd=cost.resume_cost(ctx, e.model, ttl),
            respawn_usd=cost.respawn_cost(_baseline_bytes(t) if t else 0, e.model, ttl),
            errors=parsed.errors,
        ))
    return out


def render(rs: list[Row]) -> str:
    hdr = f"{'thread':10} {'tier':8} {'state':7} {'warmth':8} {'idle':>5} {'ctx':>8} {'read':>9} {'write':>8} {'out':>7} {'$':>7} {'resume$':>8} {'respawn$':>9} flags"
    lines = [hdr]
    for r in rs:
        flags = " ".join(x for x in (
            "STALE-SPEC" if r.spec_stale else "", f"miss:{r.miss_reason}" if r.miss_reason else "",
            f"handoff:{r.last_handoff}" if r.last_handoff else "", f"parse-errors:{r.errors}" if r.errors else "") if x)
        lines.append(f"{r.name:10} {r.tier:8} {r.state:7} {r.warmth:8} {r.idle_minutes:>5} {r.context:>8} {r.read:>9} "
                     f"{r.written:>8} {r.output:>7} {r.dollars:>7.2f} {r.resume_usd:>8.2f} {r.respawn_usd:>9.2f} {flags}")
    return "\n".join(lines)


def watch(interval: int = 10) -> None:
    try:
        while True:
            print("\x1b[2J\x1b[H" + render(rows()), flush=True)
            time.sleep(interval)
    except KeyboardInterrupt:
        pass
