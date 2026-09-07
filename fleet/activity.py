"""Tell "silent in the ledger, working in a subprocess" apart from "stopped."

`fleet.ledger.events.jsonl` only ever gets a line when a fleet hook fires -
a Stop, a PreToolUse gate, a `fleet send`. Work happening inside a single
long-running tool call (a subprocess pi shells out to, a background grok
session writing its own output files) or inside the current turn's own
thinking produces none of that until the turn ends. Measured live
2026-09-06 ~21:15: `fleet watchdog` alerted ALERT (stuck) on 50m of
fleet-wide ledger silence with 23 dispatches open - and was wrong.
haiku-pi2 had written 42 new files under its own cwd in that window
(`/Users/pup/cognitive/project1/ledger/grok-probes-raw/`, live grok
subprocesses) and sonnet4 was mid-turn. From events.jsonl alone, that
silence was indistinguishable from the later one where pi had actually
died.

The fix is a derivative, not a higher threshold - raising N trades this
false alarm for blindness to a real one, which is the trade the whole day
argued against (opus2's IDLE-ROOT-CAUSE, the false positives in
`outstanding`, the census-driven handoff join: every one of today's fixes
was "look harder for evidence", never "wait longer and hope"). Two signals,
checked per thread, either one enough to call it "busy":

  - the thread's own session transcript file has a newer mtime than the
    ledger went quiet at - Claude Code appends to it independently of
    fleet's own hooks, so this catches a thread mid-turn (sonnet4's case)
    even when its tool calls touch files nowhere near its registered cwd.
  - any file under the thread's registered cwd has a newer mtime - catches
    a subprocess or background job writing its own output on a path the
    transcript won't mention again until the surrounding tool call returns
    (pi's case: grok-probes-raw is several directories under haiku-pi2's
    cwd, and pi's transcript would say nothing new until all nine probe
    families finished).

Both are existence checks, not full inventories: the first file found
newer than the cutoff is enough to call a thread busy, so this never has
to enumerate everything a thread wrote.
"""
import os
import time
from dataclasses import dataclass
from pathlib import Path

from .registry import Entry, transcript_for

_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv",
              ".mypy_cache", ".pytest_cache", ".ruff_cache"}


@dataclass
class Activity:
    status: str  # "busy" | "quiet" | "unknown"
    evidence: str


def _newest_file_since(root: Path, since: float, cap_files: int = 200_000) -> tuple[str, float | None, str | None]:
    """("hit", mtime, path) for the first file under `root` newer than
    `since`; ("clean", None, None) if the whole tree was checked and none
    qualified; ("truncated", None, None) if `cap_files` files were checked
    without finishing the tree.

    "clean" and "truncated" must stay distinct - a truncated scan found
    nothing newer only because it gave up, and reading that as "confirmed
    quiet" would silently reintroduce the false positive this module
    exists to fix, just moved into the scan itself. Early-exits on the
    first hit otherwise - "is anything newer than the cutoff" only ever
    needs one answer, not the true maximum mtime under a tree that can
    hold a whole project's history.
    """
    if not root.is_dir():
        return "clean", None, None
    checked = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            checked += 1
            if checked > cap_files:
                return "truncated", None, None
            p = Path(dirpath) / name
            try:
                mt = p.stat().st_mtime
            except OSError:
                continue
            if mt > since:
                return "hit", mt, str(p)
    return "clean", None, None


def check(thread: str, entries: dict[str, Entry] | None, since: float,
          now: float | None = None, cap_files: int = 200_000) -> Activity:
    """Has `thread` produced any evidence of real work since `since`
    (normally the moment the fleet-wide ledger went quiet)?

    "unknown" - never "quiet" - when the check itself could not run
    (no registry, thread not registered, cwd gone): a watchdog that
    silently reads "could not check" as "confirmed nothing happening"
    would just relocate the false positive this module exists to fix,
    one layer down.
    """
    now = now if now is not None else time.time()
    if entries is None:
        return Activity("unknown", "registry unreadable; cannot locate this thread's cwd or transcript")
    entry = entries.get(thread)
    if entry is None:
        return Activity("unknown", f"{thread!r} not in the registry (parked/retired?)")
    tpath = transcript_for(entry, entries)
    try:
        tmtime = tpath.stat().st_mtime
    except OSError:
        tmtime = None
    if tmtime is not None and tmtime > since:
        age_m = (now - tmtime) / 60
        return Activity("busy", f"transcript {tpath.name} written {age_m:.0f}m ago")
    scan_status, mt, path = _newest_file_since(Path(entry.cwd), since, cap_files=cap_files)
    if scan_status == "hit":
        age_m = (now - mt) / 60
        return Activity("busy", f"{path} written {age_m:.0f}m ago")
    if scan_status == "truncated":
        return Activity("unknown", f"scan of {entry.cwd} gave up before finishing "
                                    f"(more than {cap_files} files) - cannot confirm quiet")
    return Activity("quiet", f"transcript{'(not found)' if tmtime is None else ''} "
                              f"and everything under {entry.cwd} predate the cutoff")
