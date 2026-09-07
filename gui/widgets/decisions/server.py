"""Read-only view of what is waiting on the operator (spec: DECISIONS-DASHBOARD).

Parses ledger/assignments/DECISIONS.md and the operator -> user rows of
ledger/assignments/OPEN.md via fleet.decisions, and serves the text of a
cited handoff so a link can actually be opened from another device.

READ ONLY. No POST route, on purpose - see commit 14b4bdc: the last GUI
prototype that could reach `bin/fleet send` from an unauthenticated route
was reverted for exactly that shape of defect. This widget cannot decide
anything, cannot send anything, and cannot write anything; both routes
below reject anything but GET even though they are only ever registered
under GET_PREFIXES/_widget_route's shared dispatch (which also accepts
POST) - the check is redundant with how the widget is actually reached
today, and deliberately kept anyway so a future change to that dispatch
does not silently turn this into a write path by accident.
"""
from dataclasses import asdict
from pathlib import Path

from fleet import decisions as decisions_mod
from fleet.paths import ROOT
from gui.server import HttpError

WATCH = ["ledger/assignments/DECISIONS.md", "ledger/assignments/OPEN.md", "state/v2/watchdog-ALERT"]

HANDOFFS_ROOT = (ROOT / "ledger" / "handoffs").resolve()
MAX_HANDOFF_BYTES = 200_000  # a render target, not a security boundary - handoffs are prose


def _require_get(ctx) -> None:
    if ctx.method != "GET":
        raise HttpError(405, "read-only: GET only")


def get(ctx):
    _require_get(ctx)
    r = decisions_mod.read()
    return {
        "watchdog_alert": decisions_mod.read_watchdog_alert(),
        "decisions_status": r.decisions_status,
        "decisions_path": r.decisions_path,
        "decisions_resolved_note": r.decisions_resolved_note,
        "decisions": [asdict(d) for d in r.decisions],
        "open_status": r.open_status,
        "open_path": r.open_path,
        "open_rows": [asdict(row) for row in r.open_rows],
        "pending_count": r.pending_count,
    }


def get_handoff(ctx):
    _require_get(ctx)
    rel = ctx.query.get("path", "")
    if not rel:
        raise HttpError(400, "missing path")
    target = (ROOT / rel).resolve()
    try:
        target.relative_to(HANDOFFS_ROOT)
    except ValueError:
        raise HttpError(403, "path must be under ledger/handoffs/")
    if not target.is_file():
        raise HttpError(404, "not found")
    text = target.read_text(errors="replace")
    truncated = len(text) > MAX_HANDOFF_BYTES
    if truncated:
        text = text[:MAX_HANDOFF_BYTES]
    return {"path": rel, "text": text, "truncated": truncated}


ROUTES = {"": get, "handoff": get_handoff}
