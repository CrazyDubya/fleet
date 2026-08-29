"""Tail of hook decisions from the ledger (spec §3 monitoring)."""
from collections import defaultdict

from fleet import ledger
from gui.server import HttpError

WATCH = ["ledger/events.jsonl"]
# The widget polls; events.jsonl is append-only and grows without bound.
# Reading (and json-decoding) the whole file every tick was the single most
# expensive thing the GUI host did. The last 5000 lines are far more than the
# tail this widget renders, and the per-thread counts are explicitly counts
# over that window, not over all history.
MAX_LINES = 5000


def get(ctx):
    raw = ctx.query.get("n", "50")
    try:
        n = int(raw)
    except (TypeError, ValueError):
        raise HttpError(400, "n must be an integer")
    n = max(0, min(n, MAX_LINES))  # negatives asked for a suffix slice of the WHOLE list
    evs = [e for e in ledger.read_events(ledger.EVENTS, tail=MAX_LINES) if e.get("ev") == "hook"]
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for e in evs:
        counts[e.get("thread", "?")][e.get("decision", "?")] += 1
    return {"events": list(reversed(evs[-n:])) if n else [],
            "counts": {t: dict(c) for t, c in counts.items()},
            "window": MAX_LINES}


ROUTES = {"": get}
