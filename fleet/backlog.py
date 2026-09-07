"""Read the operator's hand-maintained backlog so `fleet watchdog` can tell
two different silences apart: idle because nobody assigned anything (a
backlog exists, nothing was dispatched from it) vs idle because there is
genuinely nothing queued (the backlog is empty, on purpose).

opus2's IDLE-ROOT-CAUSE finding (ledger/handoffs/opus2/20260906T051500Z-
idle-root-cause.md): the fleet does not fail to dispatch when a handoff
lands - it fails to dispatch because nobody is running when it lands.
Twelve of seventeen measured silences ended in a self-started dispatch
with no human input in the preceding ten minutes. `outstanding()` can only
see work that was already sent - a join over `send` events has nothing to
join for work nobody has assigned yet, so unassigned work is invisible to
it by construction, and "nothing outstanding" collapses onto "nothing to
do" even though they call for opposite responses.

`ledger/assignments/OPEN.md` is the backlog that already exists - the
operator keeps it by hand - and nothing machine-readable read it before
this. No new file, no second list to keep in sync: this module parses
OPEN.md directly, in place, in the format the operator already writes it.
The one convention it depends on (already true of the file today, stated
in the file's own header) is that the leading markdown table - before the
first `## ` heading - holds the currently-open items, and anything under a
`## ` heading (Closed, Deferred, standing facts, design notes, ...) is
not: "an entry leaves this file when a handoff lands, not when a thread
goes idle." This module reads that same signal instead of a human being
the only one who ever does.
"""
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import ledger
from .paths import LEDGER

DEFAULT_PATH = LEDGER / "assignments" / "OPEN.md"

_SEPARATOR_ROW = re.compile(r"^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$")


@dataclass
class Item:
    id: str
    thread: str = ""
    expects: str = ""
    notes: str = ""


@dataclass
class Backlog:
    file_status: str  # "missing" | "unreadable" | "ok"
    path: str
    items: list[Item] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.items)


def _split_row(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse_table(text: str) -> list[Item]:
    """The leading markdown table (everything before the first `## `
    heading) whose header row's first cell is "id" - tolerant of the
    thread/expects/notes columns being renamed, reordered, or dropped,
    since it never assumes more than "first cell is the id" when only that
    one is present.
    """
    lines = text.split("\n")
    body: list[str] = []
    for line in lines:
        if line.startswith("## "):
            break
        body.append(line)
    rows = [l for l in body if l.strip().startswith("|")]
    if not rows:
        return []
    header = _split_row(rows[0])
    if not header or header[0].lower() != "id":
        return []
    items: list[Item] = []
    for line in rows[1:]:
        if _SEPARATOR_ROW.match(line):
            continue
        cells = _split_row(line)
        if not cells or not cells[0]:
            continue
        items.append(Item(
            id=cells[0],
            thread=cells[1] if len(cells) > 1 else "",
            expects=cells[2] if len(cells) > 2 else "",
            notes=cells[3] if len(cells) > 3 else "",
        ))
    return items


def read(path: Path = DEFAULT_PATH) -> Backlog:
    status = ledger.status(path)
    if status != "ok":
        return Backlog(file_status=status, path=str(path))
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return Backlog(file_status="unreadable", path=str(path))
    return Backlog(file_status="ok", path=str(path), items=parse_table(text))
