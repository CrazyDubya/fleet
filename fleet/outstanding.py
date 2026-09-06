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


# Only ~2% of real handoffs put `@re<id>` on line 1 the way the protocol
# describes (ledger/handoffs/haiku-fs6/2026-0906T020200Z-handoff-format-census.md,
# 440 files censused). `_RE_TOKEN` already looks anywhere in the file, which
# recovers the ~45% that embed `@re` as bold markdown mid-document (the
# census's Pattern 3/4/5/6/7). It recovers nothing for Pattern 1 (30%: the
# dispatch id appears - often only in the filename or a title line - but no
# `@re` was ever written) or Pattern 2 (29%: no id anywhere, no `@from`/`@re`,
# pure content). Both are common, not edge cases - two real dispatches
# (IDEA-DECLINE, IDEA-SUPPLY, both to muse2) were reported outstanding despite
# being answered within minutes, purely because muse2 writes Pattern 2.
#
# Three tiers, evidence weakest last, each one only asked once the tier
# before it found nothing for that id:
#   1. `@re<id>` anywhere in the file (protocol-shaped, ~45% of the corpus).
#   2. the raw dispatch id (hex or an UPPER-CASE-HYPHENATED token) appearing
#      anywhere in the file's name or body, no `@re` required - Pattern 1.
#   3. thread directory + timing: the earliest handoff filed under the
#      target thread's own directory after the dispatch was sent, within a
#      day, that no stronger tier already claimed - Pattern 2, where the
#      thread wrote a real reply but never mentioned the id in any form.
# A file is claimed by at most one dispatch, strongest tier first, so tier 3
# cannot steal a file that already answers a different id, and a thread's
# unrelated status write-ups are only ever reached once every id-bearing
# candidate has already been matched.
_RE_TOKEN = __import__("re").compile(r"@re([0-9A-Za-z._-]+)")
_ID_TOKEN = __import__("re").compile(r"\b(?:[0-9a-f]{16}|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\b")
TIER3_WINDOW_S = 86400.0  # a day - generous same-day/next-morning turnaround, not a week-old coincidence


@dataclass
class _HandoffIndex:
    re_idx: dict[str, str] = field(default_factory=dict)          # id -> path (tier 1)
    id_idx: dict[str, str] = field(default_factory=dict)          # id -> path (tier 2)
    by_thread: dict[str, list[tuple[float, str]]] = field(default_factory=dict)  # thread -> [(mtime, path), ...]


def _build_handoff_index(root: Path) -> _HandoffIndex:
    """One pass over every handoff file, building all three tiers' evidence
    at once - re-reading 440+ files per dispatch is what made the naive
    version of this function slow, and every tier needs the same file text.
    """
    idx = _HandoffIndex()
    if not root.is_dir():
        return idx
    for thread_dir in sorted(root.iterdir()):
        if not thread_dir.is_dir():
            continue
        thread = thread_dir.name
        for f in sorted(thread_dir.iterdir()):
            if not f.is_file():
                continue
            try:
                raw = f.read_text(errors="replace")
                mtime = f.stat().st_mtime
            except OSError:
                continue
            text = packet_mod.norm(raw)
            for m in _RE_TOKEN.finditer(text):
                idx.re_idx.setdefault(m.group(1), str(f))
            # `raw`, not the whitespace-stripped `text`: norm() exists to
            # squash markdown/whitespace around a literal `@re` so it reads
            # as one token, but applied to ordinary prose it glues adjacent
            # words together ("...retry of a04e13..." -> "...retryofa04e13...")
            # and kills the \b boundary a hex id needs on its left edge.
            # Confirmed live: a04e1323330bc8dc appears in a real sonnet2
            # handoff as "(retry of a04e1323330bc8dc, dropped ...)" and only
            # matches against the raw text.
            for m in _ID_TOKEN.finditer(f.name + " " + raw):
                idx.id_idx.setdefault(m.group(0), str(f))
            idx.by_thread.setdefault(thread, []).append((mtime, str(f)))
    for files in idx.by_thread.values():
        files.sort()
    return idx


def _tier3_match(dispatches: list["Dispatch"], idx: _HandoffIndex, claimed: set[str]) -> dict[str, tuple[str, float]]:
    """{id: (path, mtime)} for dispatches tier 1/2 found nothing for, matched
    to the earliest not-yet-claimed handoff in their own target thread's
    directory that was written after the dispatch and within TIER3_WINDOW_S.

    Greedy, in send order, per thread: the thread's own earliest still-open
    dispatch gets first claim on the thread's earliest still-available
    handoff. This is deliberately conservative in the direction that matters
    here - a stray unrelated write-up gets consumed by whichever dispatch
    was actually open when it landed, rather than left to accidentally
    answer a later, genuinely-unrelated one.
    """
    by_thread: dict[str, list[Dispatch]] = {}
    for d in dispatches:
        by_thread.setdefault(d.thread, []).append(d)
    out: dict[str, tuple[str, float]] = {}
    for thread, ds in by_thread.items():
        candidates = [(mt, p) for mt, p in idx.by_thread.get(thread, []) if p not in claimed]
        for d in sorted(ds, key=lambda d: d.t):
            for i, (mt, p) in enumerate(candidates):
                if mt > d.t and mt - d.t <= TIER3_WINDOW_S:
                    out[d.id] = (p, mt)
                    claimed.add(p)
                    del candidates[i]
                    break
    return out


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
    handoff_idx = _build_handoff_index(handoffs_root)
    claimed: set[str] = set()
    items: list[Item] = []
    file_lane: list[Dispatch] = []
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
        hit = handoff_idx.re_idx.get(d.id)
        if hit:
            claimed.add(hit)
            items.append(Item(d=d, status="answered", evidence=f"handoff (@re): {hit}"))
            continue
        hit = handoff_idx.id_idx.get(d.id)
        if hit:
            claimed.add(hit)
            items.append(Item(d=d, status="answered", evidence=f"handoff (id mentioned, no @re): {hit}"))
            continue
        file_lane.append(d)
    tier3 = _tier3_match(file_lane, handoff_idx, claimed)
    for d in file_lane:
        hit = tier3.get(d.id)
        if hit:
            hpath, mt = hit
            delta_m = (mt - d.t) / 60
            items.append(Item(d=d, status="answered",
                               evidence=f"handoff (thread+timing, no id anywhere, {delta_m:.0f}m after send): {hpath}"))
        else:
            items.append(Item(d=d, status="outstanding",
                               evidence=(f"no @re, no id mention, and no handoff filed under "
                                          f"ledger/handoffs/{d.thread}/ within {TIER3_WINDOW_S / 3600:.0f}h of the send"),
                               age_s=now - d.t))
    return Report(ledger_status="ok", ledger_path=str(path),
                  total_sends=len(dispatches) + no_id + excluded_no_reply, no_id=no_id,
                  excluded_no_reply=excluded_no_reply, items=items)
