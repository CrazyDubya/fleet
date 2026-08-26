import json
import time
from pathlib import Path

from .paths import LEDGER

EVENTS = LEDGER / "events.jsonl"
HANDOFFS = LEDGER / "handoffs"


def event(kind: str, path: Path = EVENTS, **fields) -> dict:
    rec = {"ev": kind, "t": time.time(), **fields}
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")
    return rec


def read_events(path: Path = EVENTS) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
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
