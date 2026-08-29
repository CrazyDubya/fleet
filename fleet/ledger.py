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


def last_handoff(thread: str, root: Path = HANDOFFS) -> Path | None:
    d = root / thread
    if not d.is_dir():
        return None
    files = sorted(p for p in d.iterdir() if p.is_file())
    return files[-1] if files else None
