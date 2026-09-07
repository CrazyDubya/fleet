"""Parse the operator's decision-tracking docs into a read-only structure
a GUI can render.

Two documents, one status view:

  - `ledger/assignments/DECISIONS.md` - the operator writes each pending
    decision out in full (what / where / options / recommendation / reply
    format), one `## N. TITLE` section per item. When every item has been
    replied to, the file's own first line is rewritten to
    `# Decisions - ANSWERED <date>` with a one-line summary of the
    replies, ahead of the numbered sections - which stay in the file as a
    record, not as something still open. A parser that only looks for
    `## N.` sections would keep reporting an answered file as pending
    forever; this one checks the header first.
  - `ledger/assignments/OPEN.md` - most rows are dispatches to a thread,
    already covered by `fleet.backlog`. Rows whose thread column reads
    `operator -> user` are a second, lighter-weight kind of pending
    decision (see the file's own header note) and are the other half of
    what this module surfaces.

A file marked ANSWERED is not necessarily fully closed forever: a new
`## N. TITLE` section gets appended ABOVE the old ones (verified live,
2026-09-07 - item 7 "GLASS-NEXT-STEP" landed in a file whose header still
read "ANSWERED", summarizing only items 1-6). The header's one-line
summary ("1: b, then a ... 6: fleet drafts it.") names exactly which item
numbers were answered; any numbered section whose number is absent from
that summary is still pending regardless of what the header says. Every
section is always parsed, in other words - the header only narrows which
of them count as still open.

This module only reads. It has no write path, on purpose - the decision
itself is made in the operator's terminal; this is the delivery view.
"""
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import backlog as backlog_mod
from . import ledger
from .paths import LEDGER, ROOT

DECISIONS_PATH = LEDGER / "assignments" / "DECISIONS.md"
OPEN_PATH = LEDGER / "assignments" / "OPEN.md"
HANDOFFS_ROOT = (LEDGER / "handoffs").resolve()

_PATH_RE = re.compile(r"`?(/[\w./-]+\.\w+)`?")
_SECTION_RE = re.compile(r"^##\s+(\d+)\.\s+(.+)$", re.MULTILINE)
_ANSWERED_HEADER_RE = re.compile(r"\bANSWERED\b", re.IGNORECASE)
_ANSWERED_NUM_RE = re.compile(r"(?:^|[·;])\s*(\d+)\s*:")
_FIELD_RE = re.compile(
    r"\*\*(What|Where|Options|Recommendation|Reply with)\.?:?\*\*\s*(.*?)(?=\n\*\*[A-Z][a-z]+(?:\s\w+)?\.?:?\*\*|\Z)",
    re.DOTALL,
)


@dataclass
class Link:
    path: str          # the path exactly as written in the source doc
    rel: str | None     # path relative to the repo root, ONLY when it resolves
                        # under ledger/handoffs/ - the sole tree this module will
                        # ever offer to serve content from. Anything else (a
                        # cognitive-repo path, a /private/tmp scratch file) is
                        # shown as plain text, never a link.


@dataclass
class Decision:
    n: str
    title: str
    what: str = ""
    where: str = ""
    options: str = ""
    recommendation: str = ""
    reply_with: str = ""
    links: list[Link] = field(default_factory=list)


@dataclass
class OpenRow:
    id: str
    expects: str
    notes: str
    links: list[Link] = field(default_factory=list)


@dataclass
class Report:
    decisions_status: str  # "missing" | "unreadable" | "empty" | "answered" | "pending"
    decisions_path: str
    decisions_resolved_note: str | None = None
    decisions: list[Decision] = field(default_factory=list)
    open_status: str = "missing"  # "missing" | "unreadable" | "ok"
    open_path: str = ""
    open_rows: list[OpenRow] = field(default_factory=list)

    @property
    def pending_count(self) -> int:
        return len(self.decisions) + len(self.open_rows)


def _clean_field(v: str) -> str:
    """The last field in a section has no following `**Field**` marker to
    stop at, so its raw capture runs to the end of the section - which,
    for the LAST numbered section in the file, includes the trailing
    `---` rule and any boilerplate after it (the "# Original brief" intro
    that precedes the historical sections, in the real file). Trim at the
    first blank-line-delimited `---` or heading, whichever comes first.
    """
    v = v.strip()
    for marker in ("\n---", "\n#"):
        idx = v.find(marker)
        if idx != -1:
            v = v[:idx]
    return v.strip()


def _extract_links(text: str) -> list[Link]:
    links: list[Link] = []
    seen: set[str] = set()
    for m in _PATH_RE.finditer(text):
        p = m.group(1)
        if p in seen:
            continue
        seen.add(p)
        rel = None
        try:
            resolved = Path(p).resolve()
            resolved.relative_to(HANDOFFS_ROOT)
            rel = str(resolved.relative_to(ROOT))
        except (ValueError, OSError):
            rel = None
        links.append(Link(path=p, rel=rel))
    return links


def read_decisions(path: Path | None = None) -> Report:
    path = path if path is not None else DECISIONS_PATH
    status = ledger.status(path)
    if status != "ok":
        return Report(decisions_status=status, decisions_path=str(path))
    text = path.read_text(errors="replace")
    lines = text.split("\n")
    first_line = lines[0] if lines else ""
    answered_nums: set[str] = set()
    resolved_note = None
    if _ANSWERED_HEADER_RE.search(first_line):
        resolved_note = first_line.lstrip("#").strip()
        # The summary line ("1: b, then a ... 6: fleet drafts it.") is
        # whatever the next non-blank line is - scan a few lines rather
        # than assuming it is exactly line 2, since a blank line or an
        # extra note before it is a formatting choice, not a contract.
        for line in lines[1:6]:
            if line.strip():
                answered_nums = set(_ANSWERED_NUM_RE.findall(line))
                break
    sections = list(_SECTION_RE.finditer(text))
    if not sections:
        if answered_nums:
            return Report(decisions_status="answered", decisions_path=str(path), decisions_resolved_note=resolved_note)
        return Report(decisions_status="empty", decisions_path=str(path))
    items: list[Decision] = []
    for i, m in enumerate(sections):
        n, title = m.group(1), m.group(2).strip()
        if n in answered_nums:
            continue
        start = m.end()
        end = sections[i + 1].start() if i + 1 < len(sections) else len(text)
        body = text[start:end]
        fields = {k.lower(): _clean_field(v) for k, v in _FIELD_RE.findall(body)}
        items.append(Decision(
            n=n, title=title, what=fields.get("what", ""), where=fields.get("where", ""),
            options=fields.get("options", ""), recommendation=fields.get("recommendation", ""),
            reply_with=fields.get("reply with", ""), links=_extract_links(body),
        ))
    if not items:
        return Report(decisions_status="answered", decisions_path=str(path), decisions_resolved_note=resolved_note)
    return Report(decisions_status="pending", decisions_path=str(path), decisions=items)


def _is_operator_to_user(thread: str) -> bool:
    t = thread.lower()
    return "operator" in t and "user" in t


def read_open_rows(path: Path | None = None) -> tuple[str, list[OpenRow]]:
    path = path if path is not None else OPEN_PATH
    status = ledger.status(path)
    if status != "ok":
        return status, []
    text = path.read_text(errors="replace")
    rows = []
    for it in backlog_mod.parse_table(text):
        if not _is_operator_to_user(it.thread):
            continue
        rows.append(OpenRow(id=it.id, expects=it.expects, notes=it.notes,
                            links=_extract_links(it.notes)))
    return "ok", rows


def read(decisions_path: Path | None = None, open_path: Path | None = None) -> Report:
    report = read_decisions(decisions_path)
    report.open_status, report.open_rows = read_open_rows(open_path)
    report.open_path = str(open_path if open_path is not None else OPEN_PATH)
    return report
