"""Join `send` ledger events to their replies, and report what never got one.

The correlation this module builds did not exist before: `send_packet` logs
`@id` on the ledger's `send` event, a handoff replies with `@re <id>`, and a
lookup's `@reply inline` answer only ever lands in the target thread's own
pane/transcript - nothing on disk pointed the first at the second or third.
`outstanding()` is that join, run cold off `ledger/events.jsonl`,
`ledger/handoffs/`, and (for inline replies) each thread's own session
transcript via the registry.

Three things this module refuses to do, on purpose:
  - It never claims an inline reply is confirmed just because it is no
    longer in `state/<profile>/pending/<sender>.json`. `ask()` clears that
    entry on a timeout exactly the same way it clears it on success
    (fleet/ask.py:194-207), so "not pending" is not evidence of anything.
  - It never silently drops a `send` event it cannot join. Every dispatch
    ends up in exactly one bucket - outstanding, answered, or unresolvable -
    and the counts of all three are reported together.
  - It never reports "0 outstanding" and stops there. `Report.describe()`
    always names how many dispatches were joinable, how many could not be
    correlated at all (no @id on the send event), and how many inline sends
    could not be checked (dead thread, missing/unreadable transcript) -
    so an instrument with nothing to check cannot read the same as an
    instrument that checked and found everything answered.
"""
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import ledger
from . import packet as packet_mod
from . import registry as registry_mod
from .paths import profile_state
from .registry import Entry, transcript_for

HANDOFFS = ledger.HANDOFFS


@dataclass
class Dispatch:
    id: str
    thread: str
    sender: str
    lane: str | None
    reply: str | None
    done: str | None
    t: float


@dataclass
class Item:
    d: Dispatch
    status: str  # "outstanding" | "answered" | "unresolvable"
    evidence: str
    age_s: float | None = None  # time outstanding, or delay until answered


@dataclass
class Report:
    ledger_status: str  # "missing" | "unreadable" | "empty" | "ok"
    ledger_path: str
    total_sends: int
    no_id: int
    excluded_no_reply: int
    items: list[Item] = field(default_factory=list)

    @property
    def outstanding(self) -> list[Item]:
        return sorted(
            (i for i in self.items if i.status == "outstanding"),
            key=lambda i: i.age_s or 0, reverse=True,
        )

    @property
    def unresolvable(self) -> list[Item]:
        return [i for i in self.items if i.status == "unresolvable"]

    @property
    def answered(self) -> list[Item]:
        return [i for i in self.items if i.status == "answered"]

    def describe(self) -> str:
        lines = []
        if self.ledger_status == "missing":
            return f"no ledger at {self.ledger_path} - cannot tell outstanding from answered; this is not \"0 outstanding\"."
        if self.ledger_status == "unreadable":
            return f"ledger at {self.ledger_path} could not be read - cannot tell outstanding from answered; this is not \"0 outstanding\"."
        if self.ledger_status == "empty":
            return f"ledger at {self.ledger_path} exists but contains zero send events - nothing to check, not \"0 outstanding\"."
        lines.append(
            f"{self.total_sends} send event(s); {self.no_id} carry no @id and cannot be "
            f"joined to anything; {self.excluded_no_reply} declared @reply none (no reply "
            f"expected, excluded); {len(self.items)} joinable dispatch(es) checked."
        )
        out = self.outstanding
        if not out:
            lines.append("0 outstanding.")
        else:
            lines.append(f"{len(out)} outstanding:")
            for i in out:
                age = _fmt_age(i.age_s or 0)
                done = i.d.done or "(no @done recorded)"
                lines.append(
                    f"  {i.d.id}  {i.d.thread:14} out {age:>8}  lane={i.d.lane or '?':7} "
                    f"reply={i.d.reply or '?':6} — {done}"
                )
                lines.append(f"      {i.evidence}")
        un = self.unresolvable
        if un:
            lines.append(f"{len(un)} could not be checked (not outstanding, not confirmed):")
            for i in un:
                lines.append(f"  {i.d.id}  {i.d.thread:14} — {i.evidence}")
        return "\n".join(lines)


def _fmt_age(s: float) -> str:
    if s < 90:
        return f"{s:.0f}s"
    if s < 5400:
        return f"{s / 60:.0f}m"
    return f"{s / 3600:.1f}h"


def _load_dispatches(events_path: Path | None) -> tuple[list[Dispatch], int, int]:
    events = ledger.read_events(events_path or ledger.EVENTS)
    dispatches: list[Dispatch] = []
    no_id = 0
    excluded_no_reply = 0
    for e in events:
        if e.get("ev") != "send":
            continue
        pid = e.get("id")
        if not pid:
            no_id += 1
            continue
        if e.get("reply") == "none":
            excluded_no_reply += 1
            continue
        dispatches.append(Dispatch(
            id=pid, thread=e.get("thread", "?"), sender=e.get("from", "?"),
            lane=e.get("lane"), reply=e.get("reply"), done=e.get("done"), t=e.get("t", 0.0),
        ))
    return dispatches, no_id, excluded_no_reply


_RE_TOKEN = __import__("re").compile(r"@re([0-9A-Za-z._-]+)")


def _index_handoff_replies(root: Path) -> dict[str, str]:
    """{id: path} for every `@re<id>` found in any handoff file under `root`,
    built once per `outstanding()` call rather than re-scanning every
    handoff file for every dispatch (O(threads) instead of
    O(dispatches * handoff files)).

    Indexed across every thread's directory, not just each dispatch's own
    target - a reply filed under the wrong thread's directory still counts
    as an answer, and `evidence` says which directory it actually turned up
    in so a misfiled handoff is visible rather than silently accepted.
    """
    idx: dict[str, str] = {}
    if not root.is_dir():
        return idx
    for thread_dir in sorted(root.iterdir()):
        if not thread_dir.is_dir():
            continue
        for f in sorted(thread_dir.iterdir()):
            if not f.is_file():
                continue
            try:
                text = packet_mod.norm(f.read_text(errors="replace"))
            except OSError:
                continue
            for m in _RE_TOKEN.finditer(text):
                idx.setdefault(m.group(1), str(f))
    return idx


def _registry_entries(profile: str) -> dict[str, Entry] | None:
    try:
        reg = registry_mod.Registry(profile_state(profile) / "registry.json")
        return reg.load()
    except OSError:
        return None


_TRANSCRIPT_CACHE: dict[Path, list[str] | None] = {}


def _cached_lines(path: Path) -> list[str] | None:
    """Read+split a transcript once per `outstanding()` call, not once per
    dispatch. The same thread (sonnet2, haiku-pi2, ...) is the target of
    dozens of dispatches in a single run, and its transcript can run into
    the megabytes - re-reading it per dispatch turned one run of this
    module into a multi-minute scan.
    """
    if path in _TRANSCRIPT_CACHE:
        return _TRANSCRIPT_CACHE[path]
    try:
        lines = path.read_text(errors="replace").splitlines() if path.exists() else None
    except OSError:
        lines = None
    _TRANSCRIPT_CACHE[path] = lines
    return lines


def _inline_evidence(d: Dispatch, entries: dict[str, Entry] | None) -> tuple[str, str, float | None]:
    """(status, evidence, reply_ts) for a `@reply inline` dispatch.

    Mirrors what `ask()`/`extract_reply` already do against a live pane
    (fleet/ask.py), but against the durable transcript instead of a pane
    that has long since scrolled away: find the dispatch's own `@id` line
    (its delivery record), then the first assistant turn with real text
    after it. A thread answering inline rarely bothers writing `@re<id>` -
    it just replies in prose - so this does not require one, the same way
    extract_reply's block-based fallback does not.
    """
    if entries is None:
        return "unresolvable", "registry unreadable; cannot locate a transcript", None
    entry = entries.get(d.thread)
    if entry is None:
        return "unresolvable", f"{d.thread!r} not in the registry (parked/retired?)", None
    path = transcript_for(entry, entries)
    lines = _cached_lines(path)
    if lines is None:
        return "unresolvable", f"transcript not found or unreadable: {path}", None
    paste_idx = None
    for i, line in enumerate(lines):
        if d.id in line:
            paste_idx = i
            break
    if paste_idx is None:
        return "unresolvable", "dispatch @id not found in transcript (never delivered, or the session rotated)", None
    for line in lines[paste_idx + 1:]:
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("type") != "assistant":
            continue
        m = r.get("message") or {}
        c = m.get("content")
        text = ""
        if isinstance(c, list):
            text = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text").strip()
        elif isinstance(c, str):
            text = c.strip()
        if not text:
            continue
        ts = r.get("timestamp")
        reply_t = None
        if ts:
            from datetime import datetime, timezone
            try:
                reply_t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
            except ValueError:
                pass
        return "answered", f"first assistant reply in {path.name} after the dispatch", reply_t
    return "outstanding", f"no assistant reply found after the dispatch in {path.name}", None


def outstanding(profile: str = "v2", events_path: Path | None = None,
                 handoffs_root: Path = HANDOFFS, now: float | None = None) -> Report:
    now = now if now is not None else time.time()
    path = events_path or ledger.EVENTS
    lstatus = ledger.status(path)
    if lstatus != "ok":
        return Report(ledger_status=lstatus, ledger_path=str(path), total_sends=0, no_id=0, excluded_no_reply=0)
    dispatches, no_id, excluded_no_reply = _load_dispatches(events_path)
    if not dispatches and not no_id and not excluded_no_reply:
        return Report(ledger_status="empty", ledger_path=str(path), total_sends=0, no_id=0, excluded_no_reply=0)
    _TRANSCRIPT_CACHE.clear()
    entries = None
    handoff_idx = _index_handoff_replies(handoffs_root)
    items: list[Item] = []
    for d in dispatches:
        # Route by LANE, not the recorded @reply: `lookup` is synchronous by
        # protocol (briefs/_protocol.md rule 2/3) regardless of what a
        # particular send's @reply field says, so its real answer channel is
        # the target's own pane/transcript, never a handoff. Keying off
        # @reply instead produced ~150 false "outstanding" lookups here that
        # were answered inline the way the protocol always intended, just
        # never filed a handoff naming the id - because none was expected.
        if d.lane == "lookup" or d.reply == "inline":
            if entries is None:
                entries = _registry_entries(profile) or {}
            status, evidence, reply_t = _inline_evidence(d, entries)
            age = (reply_t - d.t) if status == "answered" and reply_t else (now - d.t if status == "outstanding" else None)
            items.append(Item(d=d, status=status, evidence=evidence, age_s=age))
            continue
        # reply == "file", or unknown (a hand-typed packet with no @reply field).
        hit = handoff_idx.get(d.id)
        if hit:
            items.append(Item(d=d, status="answered", evidence=f"handoff: {hit}"))
        else:
            items.append(Item(d=d, status="outstanding",
                               evidence="no handoff anywhere under ledger/handoffs/ names this @id in an @re",
                               age_s=now - d.t))
    return Report(ledger_status="ok", ledger_path=str(path),
                  total_sends=len(dispatches) + no_id + excluded_no_reply, no_id=no_id,
                  excluded_no_reply=excluded_no_reply, items=items)
