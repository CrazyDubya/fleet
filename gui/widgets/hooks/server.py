"""Tail of hook decisions from the ledger (spec §3 monitoring)."""
from collections import defaultdict

from fleet import ledger

WATCH = ["ledger/events.jsonl"]


def get(ctx):
    n = int(ctx.query.get("n", 50))
    evs = [e for e in ledger.read_events(ledger.EVENTS) if e.get("ev") == "hook"]
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for e in evs:
        counts[e.get("thread", "?")][e.get("decision", "?")] += 1
    return {"events": list(reversed(evs[-n:])), "counts": {t: dict(c) for t, c in counts.items()}}


ROUTES = {"": get}
