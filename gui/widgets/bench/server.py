"""Bench headlines and last runs (spec: Widget)."""
from datetime import datetime

from fleet.bench import report
from fleet.bench.run import RUNS as _RUNS
from gui.server import HttpError

RUNS = _RUNS
WATCH = ["ledger/bench/runs.jsonl"]


def get(ctx):
    since = None
    if ctx.query.get("since"):
        try:
            since = datetime.strptime(ctx.query["since"], "%Y-%m-%d").timestamp()
        except ValueError:
            raise HttpError(400, "since must be YYYY-MM-DD")
    rows = report.load(RUNS, since)
    return {"summary": report.summarize(rows), "last": list(reversed(rows[-10:]))}


ROUTES = {"": get}
