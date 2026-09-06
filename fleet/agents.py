"""Who has been working which repo, across every agent - not just this fleet.

Fleet manages threads it spawned. It had no way to see work done by anything
else: an interactive Claude Code session, another model, a Codex session. That
blind spot has a cost on record. Muse was driven by interactive Claude Code
sessions until 2026-08-31, when the week experiment's lockout fenced them to
force work through fleet; muse's operator went with them, Codex picked it up on
09-02, and nobody noticed for three days because nothing was watching.

Two stores, one shape:

  Claude  ~/.claude/projects/<cwd with / -> ->/<session>.jsonl, `cwd` on a
          record near the head.
  Codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, `cwd` and `model` on
          the `session_meta` first line.

Both are read head-only and mtime-bounded, so a scan stays cheap enough to run
inside `fleet status`.
"""
import json
from dataclasses import dataclass
from pathlib import Path

CLAUDE_ROOT = Path.home() / ".claude" / "projects"
CODEX_ROOT = Path.home() / ".codex" / "sessions"
HEAD_RECORDS = 40  # how far into a transcript to look for its cwd
# A session whose file was written this recently is presumed still in progress.
# Generous: an agent thinking between tool calls writes nothing for a while, and
# a false "live" only defers a dispatch, while a false "idle" collides with it.
LIVE_S = 900


@dataclass
class Activity:
    agent: str            # "claude" | "codex"
    session: str
    cwd: str | None
    model: str | None
    last: float           # mtime: last time this session wrote anything
    path: Path

    def is_live(self, now: float, within_s: float = LIVE_S) -> bool:
        return (now - self.last) < within_s


def _head(path: Path, n: int):
    """First `n` parsed JSON records, skipping unparseable lines.

    Transcripts are appended to while we read and a torn final line is normal,
    so a parse failure is a skip, never an error.
    """
    out = []
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                if len(out) >= n:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return out


def _claude_activity(path: Path) -> Activity | None:
    cwd = model = None
    for r in _head(path, HEAD_RECORDS):
        cwd = cwd or r.get("cwd")
        model = model or ((r.get("message") or {}).get("model") if isinstance(r.get("message"), dict) else None)
        if cwd and model:
            break
    if not cwd:
        return None
    # FLEET-CODE-REVIEW item 4: guarded like every other filesystem touch in this
    # module. A transcript can vanish between root.glob() listing it and this stat -
    # rotated, cleaned up, or owned by a session that just exited. Unguarded, that
    # OSError propagates scan() -> live_on() -> health() -> rows() and lands in
    # cli.py's blanket `except Exception: return []`, where a broken health check
    # becomes indistinguishable from "no projects declared".
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    return Activity("claude", path.stem, cwd, model, mtime, path)


def _codex_activity(path: Path) -> Activity | None:
    cwd = model = sid = None
    for r in _head(path, HEAD_RECORDS):
        body = r.get("payload") if isinstance(r.get("payload"), dict) else r
        cwd = cwd or body.get("cwd")
        model = model or body.get("model")
        sid = sid or body.get("id")
        if cwd and model:
            break
    if not cwd:
        return None
    return Activity("codex", sid or path.stem, cwd, model, path.stat().st_mtime, path)


def scan(since: float | None = None, claude_root: Path | None = None,
         codex_root: Path | None = None) -> list[Activity]:
    """Every agent session, newest last. `since` bounds by mtime.

    Missing stores are not an error - a machine with no Codex installed simply
    contributes no Codex rows.
    """
    out: list[Activity] = []
    cr = CLAUDE_ROOT if claude_root is None else claude_root
    xr = CODEX_ROOT if codex_root is None else codex_root
    for root, glob, parse in ((cr, "*/*.jsonl", _claude_activity),
                              (xr, "**/rollout-*.jsonl", _codex_activity)):
        if not root.is_dir():
            continue
        for p in root.glob(glob):
            try:
                if since is not None and p.stat().st_mtime < since:
                    continue
            except OSError:
                continue
            a = parse(p)
            if a is not None:
                out.append(a)
    return sorted(out, key=lambda a: a.last)


def by_cwd(activities: list[Activity]) -> dict[str, list[Activity]]:
    out: dict[str, list[Activity]] = {}
    for a in activities:
        out.setdefault(a.cwd or "?", []).append(a)
    return out


def live_on(cwd: str, now: float, within_s: float = LIVE_S, activities: list[Activity] | None = None,
            exclude_sessions: set[str] | None = None) -> list[Activity]:
    """Sessions still working `cwd` right now - the dispatch interlock.

    `exclude_sessions` drops fleet's own threads, which are always "live" on a
    project they steer and must not block themselves.
    """
    acts = scan(since=now - within_s) if activities is None else activities
    skip = exclude_sessions or set()
    return [a for a in acts
            if a.cwd == cwd and a.session not in skip and a.is_live(now, within_s)]
