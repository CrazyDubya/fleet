"""Repos fleet watches but does not own (spec: Project).

A project is a directory other agents work in. Fleet reads its health from
whatever that project already publishes - it never instruments the project, so
fleet stays a reader of the project's own truth rather than a second source of
it that can disagree.

Declared in fleet.toml:

    [[project]]
    name = "muse"
    dir = "/Users/pup/muse"
    thread = "muse2"                       # optional steering thread
    status_glob = "pipeline/status-*.md"   # newest match is today's health
    state_re = 'state:\\s*\\*\\*(\\w+)\\*\\*'
    ok_states = ["OK", "GREEN"]

Adding the next project is a config edit, not a code change - which is the
point, because muse is the first of several (cognitive/project1 already has
221 agent sessions across two vendors).
"""
import re
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from . import agents
from .paths import ROOT

DEFAULT_OK = ("OK", "GREEN", "HEALTHY")


@dataclass
class Project:
    name: str
    dir: str
    thread: str | None = None
    status_glob: str | None = None
    state_re: str | None = None
    ok_states: list[str] = field(default_factory=lambda: list(DEFAULT_OK))

    @property
    def path(self) -> Path:
        return Path(self.dir)


@dataclass
class Health:
    project: str
    dir: str
    state: str | None           # None when no status file was found
    status_file: Path | None
    age_s: float | None         # how stale the status file is
    live: list[agents.Activity] = field(default_factory=list)
    thread: str | None = None
    # carried from the Project, not re-read from the module default: a project
    # that declares its own ok_states must have them honoured or the setting is
    # decorative and every non-default project reads as unhealthy forever.
    ok_states: list[str] = field(default_factory=lambda: list(DEFAULT_OK))

    @property
    def ok(self) -> bool:
        return self.state is not None and self.state.upper() in {s.upper() for s in self.ok_states}


def load(path: Path | None = None) -> dict[str, Project]:
    with open(path or ROOT / "fleet.toml", "rb") as f:
        data = tomllib.load(f)
    return {b["name"]: Project(**b) for b in data.get("project", [])}


def _newest_status(p: Project) -> Path | None:
    if not p.status_glob:
        return None
    try:
        files = [f for f in p.path.glob(p.status_glob) if f.is_file()]
    except OSError:
        return None
    return max(files, key=lambda f: f.stat().st_mtime, default=None)


def _state_of(p: Project, status: Path | None) -> str | None:
    if status is None or not p.state_re:
        return None
    try:
        m = re.search(p.state_re, status.read_text(errors="replace"))
    except OSError:
        return None
    return m.group(1) if m else None


def health(p: Project, now: float | None = None, activities: list[agents.Activity] | None = None,
           exclude_sessions: set[str] | None = None) -> Health:
    now = time.time() if now is None else now
    status = _newest_status(p)
    return Health(
        project=p.name, dir=p.dir, state=_state_of(p, status), status_file=status,
        age_s=(now - status.stat().st_mtime) if status else None,
        live=agents.live_on(p.dir, now, activities=activities, exclude_sessions=exclude_sessions),
        thread=p.thread, ok_states=list(p.ok_states),
    )


def dispatch_blocked(h: Health) -> str:
    """Why a packet must not be sent into this project now, or "" if it may.

    Another agent mid-session in the same tree is the whole hazard: muse
    carries uncommitted work across harness_pkg/ and a Codex session has been
    steering it since 09-02. Two writers in one dirty tree lose edits. This is
    the same shape as the bench's own collision guard, which exists because
    the bench commandeered a live thread three times before it was written.
    """
    if not h.live:
        return ""
    a = h.live[-1]
    return f"{a.agent} session live on {h.dir} ({a.model or 'unknown model'}, {a.session[:8]})"


def rows(now: float | None = None, projects: dict[str, Project] | None = None,
         exclude_sessions: set[str] | None = None) -> list[Health]:
    now = time.time() if now is None else now
    ps = load() if projects is None else projects
    acts = agents.scan(since=now - agents.LIVE_S)
    return [health(p, now, activities=acts, exclude_sessions=exclude_sessions) for p in ps.values()]


def render(hs: list[Health]) -> str:
    if not hs:
        return ""
    w = max(len("project"), *(len(h.project) for h in hs))
    lines = [f"{'project':{w}} {'state':10} {'status age':>10} {'thread':10} live"]
    for h in hs:
        age = "-" if h.age_s is None else f"{h.age_s / 3600:.1f}h"
        live = ", ".join(f"{a.agent}:{a.model or '?'}" for a in h.live) or "-"
        lines.append(f"{h.project:{w}} {(h.state or '?'):10} {age:>10} {(h.thread or '-'):10} {live}")
    return "\n".join(lines)
