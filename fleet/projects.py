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

# muse's own generator (harness_pkg/harness/analyze.py) emits this literal
# state whenever zero tasks were attempted that day, BEFORE any of its real
# health checks run - its own comment there: "every condition below is
# vacuously satisfied when zero tasks were attempted today". That collapses
# a genuinely quiet day and a dead harness into the same three words. Do
# NOT add this to ok_states - that hides the broke case behind a flat
# classification, the exact vacuous-truth shape this fleet keeps finding.
# Sub-classified below from the status file's own other fields instead.
NO_ACTIVITY_STATE = "NO ACTIVITY"

# Verified against muse's source rather than assumed (analyze.py's
# lock_state computation): the lock file has THREE states, not two.
# "inactive" means the lock file was never created - no worker ever tried.
# "stale" means the file exists but its pid is dead - a crashed worker.
# "active pid=N" means a live process holds it. Inactive does NOT mean
# crashed; that is what "stale" specifically means, so "benign" below can
# safely treat an inactive lock as real evidence of nothing having been
# due, not merely the absence of an alarm.
_LOCK_RE = re.compile(r"worker lock:\s*(\w+)")  # "inactive"/"stale"/"active" - stops before " pid=N" or a trailing ";"
_PENDING_RUNNING_RE = re.compile(r"pending:\s*(\d+);\s*running:\s*(\d+)")
_BACKLOG_PRESSURE_RE = re.compile(r"backlog pressure:\s*(yes|no)")


def _classify_no_activity(text: str) -> str:
    """"benign" | "attention" | "unknown" for a NO ACTIVITY status file.

    benign: nothing was due - lock inactive (no worker ever tried), zero
    pending, no backlog pressure. All three are required; this is positive
    evidence of an idle day, not just the absence of a lock.

    attention: something should have run - pending work with nothing
    running to work it, backlog pressure, or a lock that is stale (a
    crashed worker) or held active while nothing is running (a worker that
    locked itself and then produced nothing - the same crash signature by
    a different name). This is the default for anything that is not
    affirmatively benign, per instruction: absence of the alarm is not
    evidence of health.

    unknown: the status file does not carry the fields needed to tell -
    reported distinctly rather than defaulting to "benign", the one
    reading this function must never produce by omission.
    """
    lock_m = _LOCK_RE.search(text)
    pr_m = _PENDING_RUNNING_RE.search(text)
    bp_m = _BACKLOG_PRESSURE_RE.search(text)
    if not (lock_m and pr_m and bp_m):
        return "unknown"
    lock, (pending, running) = lock_m.group(1), (int(pr_m.group(1)), int(pr_m.group(2)))
    backlog_pressure = bp_m.group(1) == "yes"
    if lock == "inactive" and pending == 0 and not backlog_pressure:
        return "benign"
    return "attention"


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
    # "benign" | "attention" | "unknown" | None (None unless state is
    # NO_ACTIVITY_STATE - see _classify_no_activity). A separate field
    # rather than folded into `state` so the raw value muse actually wrote
    # stays visible, with fleet's own sub-classification alongside it.
    no_activity: str | None = None

    @property
    def ok(self) -> bool:
        if self.state is not None and self.state.upper() == NO_ACTIVITY_STATE:
            return self.no_activity == "benign"
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


def _no_activity_of(status: Path | None, state: str | None) -> str | None:
    if status is None or state is None or state.upper() != NO_ACTIVITY_STATE:
        return None
    try:
        text = status.read_text(errors="replace")
    except OSError:
        return "unknown"
    return _classify_no_activity(text)


def health(p: Project, now: float | None = None, activities: list[agents.Activity] | None = None,
           exclude_sessions: set[str] | None = None) -> Health:
    now = time.time() if now is None else now
    status = _newest_status(p)
    state = _state_of(p, status)
    return Health(
        project=p.name, dir=p.dir, state=state, status_file=status,
        age_s=(now - status.stat().st_mtime) if status else None,
        live=agents.live_on(p.dir, now, activities=activities, exclude_sessions=exclude_sessions),
        thread=p.thread, ok_states=list(p.ok_states), no_activity=_no_activity_of(status, state),
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
        state_text = h.state or "?"
        if h.no_activity:
            state_text += f"/{h.no_activity}"
        lines.append(f"{h.project:{w}} {state_text:10} {age:>10} {(h.thread or '-'):10} {live}")
    return "\n".join(lines)
