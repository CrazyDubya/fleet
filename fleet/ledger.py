import json
import os
import time
from pathlib import Path

from .paths import LEDGER

EVENTS = LEDGER / "events.jsonl"
HANDOFFS = LEDGER / "handoffs"


def event(kind: str, path: Path | None = None, **fields) -> dict:
    path = path or EVENTS  # resolved per call so tests can pass a temp path
    rec = {"ev": kind, "t": time.time(), **fields}
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")
    return rec


def tail_lines(path: Path, n: int, block: int = 65536) -> list[str]:
    """The last `n` lines of `path`, read by seeking backwards from the end.

    events.jsonl is append-only and grows without bound; a poller that wants
    the last 50 hook decisions has no business reading (and decoding) the
    whole file every two seconds.

    The leading chunk may start mid-line - that partial line is dropped by
    the `[-n:]` slice as long as more than `n` newlines were seen, and by
    read_events' JSONDecodeError guard otherwise. Chunks are joined before
    decoding so a multi-byte character split across a block boundary is
    never mangled.
    """
    if n <= 0 or not path.exists():
        return []
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        chunks, newlines = [], 0
        while pos > 0 and newlines <= n:
            step = min(block, pos)
            pos -= step
            f.seek(pos)
            buf = f.read(step)
            newlines += buf.count(b"\n")
            chunks.append(buf)
    return b"".join(reversed(chunks)).decode("utf-8", "replace").splitlines()[-n:]


def read_events(path: Path = EVENTS, tail: int | None = None) -> list[dict]:
    """Parsed events, oldest first. `tail=N` reads only the last N lines."""
    if not path.exists():
        return []
    lines = tail_lines(path, tail) if tail else path.read_text().splitlines()
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def last_miss(thread: str, path: Path = EVENTS) -> dict | None:
    hits = [e for e in read_events(path) if e.get("ev") == "miss" and e.get("thread") == thread]
    return hits[-1] if hits else None


def status(path: Path) -> str:
    """"missing" | "unreadable" | "ok" for a ledger file - checked separately
    from "the file parses to zero events", so a caller can tell a ledger
    that was never read at all apart from one that was read and is
    genuinely empty. Shared by `outstanding` and `watchdog`: both refuse to
    report "nothing wrong" when they could not actually check.
    """
    if not path.exists():
        return "missing"
    try:
        with open(path, "rb") as f:
            f.read(1)
    except OSError:
        return "unreadable"
    return "ok"


def last_handoff(thread: str, root: Path = HANDOFFS) -> Path | None:
    d = root / thread
    if not d.is_dir():
        return None
    # By mtime, not by name. Handoff filenames are not consistently timestamped -
    # most are "<UTC>-<slug>", but plenty are free-form ("pinball_sweep_09-04.txt"),
    # and a leading letter sorts after a leading digit. haiku-fs2 reported a file from
    # 60 hours earlier as its latest while a handoff written 90 minutes ago sat beside
    # it, because "p" > "2". launcher.py uses this to advise a respawn and status.py
    # prints it, so a stale answer here is a wrong decision, not a wrong label.
    files = [p for p in d.iterdir() if p.is_file()]
    return max(files, key=lambda f: f.stat().st_mtime) if files else None
