import time
from dataclasses import dataclass
from pathlib import Path

from . import cost, ledger, tmux, transcript
from .paths import ROOT, transcript_path
from .registry import Entry, Registry, RegistryLocked, transcript_for
from .spec import Thread, active_threads, load_settings, spec_hash

# Sentinel for "this model has no published rate", so a dollar field is never
# a plausible-looking 0.00. render() shows it as `?`.
UNKNOWN_USD = -1.0


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
    # The provider refused the last turn (Claude Code isApiErrorMessage record,
    # e.g. "rate_limit"). State is `refused`, not `idle`: the thread did not
    # stop, it was stopped, and the operator's remedy is different.
    provider_refused: str | None = None
    provider_refused_text: str = ""


def resolve_pending(entries: dict[str, Entry]) -> bool:
    """Fill in the session id of any fork still registered as "pending".

    Pure: mutates `entries` in place and reports whether anything changed.
    Persisting is the caller's job, because the caller is the one that knows
    whether it already holds the registry lock (spec §9) - the lock is not
    reentrant.

    `claude --resume <parent-session> --fork-session` writes the child's
    transcript into the *parent's* project directory (keyed off the parent's
    original cwd), not the child's own cwd - verified by hand: a forked
    "expert-test" child's session lands under
    ~/.claude/projects/-Users-pup-fleet-opus/, alongside opus's own
    transcript, never under -Users-pup-fleet-expert-test/. So look there, and
    skip the parent's own already-known session file when picking the newest
    candidate.
    """
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
    return changed


def _resolve_and_persist(registry: Registry) -> dict[str, Entry]:
    """Resolve pending forks and write them back under the registry lock.

    If another fleet process holds the lock, skip the write and use the
    in-memory resolution for this render: it is idempotent and the next
    `fleet status` will persist it.
    """
    entries = registry.load()
    if resolve_pending(entries):
        try:
            with registry.locked():
                registry.save(entries)
        except RegistryLocked:
            pass
    return entries


def resolve_pending_fork_ids(registry: Registry) -> None:
    _resolve_and_persist(registry)


def _baseline_bytes(thread) -> int:
    return sum((ROOT / b).stat().st_size for b in thread.baseline if (ROOT / b).exists())


def _money(turns, ctx: int, model: str, ttl: int, baseline_bytes: int):
    """Spend + resume/respawn estimates, tolerating a model with no rate.

    cost._rate raises for an unpublished or mistyped model id. One such row
    must not take down `fleet status` for the whole fleet, and it must not
    render as $0.00 either - the dollar fields become UNKNOWN_USD, which
    render() shows as `?`. Token counts are rate-free and stay exact.
    """
    try:
        return (cost.spend(turns, model), cost.resume_cost(ctx, model, ttl),
                cost.respawn_cost(baseline_bytes, model, ttl))
    except ValueError:
        sp = cost.Spend(read=sum(t.cache_read for t in turns),
                        written=sum(t.cache_5m + t.cache_1h for t in turns),
                        output=sum(t.output for t in turns), dollars=UNKNOWN_USD)
        return sp, UNKNOWN_USD, UNKNOWN_USD


def _usd(v: float) -> str:
    return "      ?" if v == UNKNOWN_USD else f"{v:7.2f}"


def _specs() -> dict[str, Thread]:
    """The active profile's threads, keyed by name.

    Local import to dodge the cli<->status cycle (cli imports status at
    module level for `fleet status`), same trick launcher._thread uses.
    The resolution itself lives in spec.active_threads, shared with launcher.
    """
    from .cli import current_profile  # local: cli imports status
    return active_threads(current_profile())


def rows(now: float | None = None, registry: Registry | None = None, specs=None,
         entries: dict[str, Entry] | None = None) -> list[Row]:
    """Rows for every registered thread.

    Pass `entries` when you already hold the registry lock (launcher.wake
    does): the resolution is then applied to *your* dict and persisted by
    your own save, instead of being written behind your back and then
    reverted by it.
    """
    now = now or time.time()
    registry = registry or Registry()
    specs = specs or _specs()
    default_ttl = load_settings()["cache_ttl_minutes"]
    if entries is None:
        entries = _resolve_and_persist(registry)
    else:
        resolve_pending(entries)
    out = []
    for name, e in sorted(entries.items()):
        t = specs.get(name)
        parsed = transcript.parse(transcript_for(e, entries))
        turns = parsed.turns
        ttl = cost.observed_ttl_minutes(turns, default_ttl)
        last_turn_ts = turns[-1].ts if turns else None
        w, idle = cost.warmth(last_turn_ts, now, ttl)
        if e.status in ("parked", "archived"):
            state = e.status
        elif not turns:
            state = "new"
        elif parsed.last_api_error:
            # Checked before busy/idle on purpose: a refusal record is the last
            # assistant turn, so the idle branch would otherwise claim it.
            state = "refused"
        elif parsed.last_type == "user" or turns[-1].stop_reason == "tool_use":
            state = "busy"
        else:
            state = "idle" if tmux.window_exists(name) else "parked"
        ctx = cost.context_size(turns)
        sp, resume_usd, respawn_usd = _money(turns, ctx, e.model, ttl, _baseline_bytes(t) if t else 0)
        miss = ledger.last_miss(name)
        hand = ledger.last_handoff(name)
        out.append(Row(
            name=name, model=e.model, tier=(t.tier if t else "?"), state=state, warmth=w, idle_minutes=idle,
            context=ctx, read=sp.read, written=sp.written, output=sp.output, dollars=sp.dollars,
            spec_stale=bool(t) and spec_hash(t) != e.spec_hash,
            last_handoff=(str(hand.relative_to(ROOT)) if hand else None),
            miss_reason=(miss["reason"] if miss and miss["t"] > (last_turn_ts or 0) else None),
            resume_usd=resume_usd, respawn_usd=respawn_usd,
            errors=parsed.errors,
            provider_refused=parsed.last_api_error,
            provider_refused_text=(turns[-1].api_error_text if turns and parsed.last_api_error else ""),
        ))
    return out


def render(rs: list[Row]) -> str:
    hdr = f"{'thread':10} {'tier':8} {'state':7} {'warmth':8} {'idle':>5} {'ctx':>8} {'read':>9} {'write':>8} {'out':>7} {'$':>7} {'resume$':>8} {'respawn$':>9} flags"
    lines = [hdr]
    for r in rs:
        flags = " ".join(x for x in (
            # The age matters as much as the refusal. `refused` derives from the last
            # transcript record, so it is STICKY: it survives the wall lifting and only
            # clears when the thread is poked and succeeds. On 2026-09-04 three threads
            # read `refused` carrying a reset time already an hour past, and nothing in
            # the flag said the state was stale. Reuse idle_minutes rather than deriving
            # the age again, so the flag can never disagree with the column beside it.
            (f"PROVIDER:{r.provider_refused} {r.idle_minutes}m-ago"
             + (f' "{r.provider_refused_text}"' if r.provider_refused_text else ""))
            if r.provider_refused else "",
            "STALE-SPEC" if r.spec_stale else "", f"miss:{r.miss_reason}" if r.miss_reason else "",
            f"handoff:{r.last_handoff}" if r.last_handoff else "", f"parse-errors:{r.errors}" if r.errors else "") if x)
        lines.append(f"{r.name:10} {r.tier:8} {r.state:7} {r.warmth:8} {r.idle_minutes:>5} {r.context:>8} {r.read:>9} "
                     f"{r.written:>8} {r.output:>7} {_usd(r.dollars):>7} {_usd(r.resume_usd):>8} "
                     f"{_usd(r.respawn_usd):>9} {flags}")
    return "\n".join(lines)


def watch(interval: int = 10) -> None:
    try:
        while True:
            print("\x1b[2J\x1b[H" + render(rows()), flush=True)
            time.sleep(interval)
    except KeyboardInterrupt:
        pass
