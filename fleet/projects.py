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
_HEARTBEAT_AGE_RE = re.compile(r"heartbeat:\s*oldest update (\d+)s ago")
_HEARTBEAT_UNCOVERED_RE = re.compile(r"heartbeat:\s*\d+\s*task\(s\) not covered by heartbeat monitoring")
# muse's harness_pkg/harness/config.py Config.stall_timeout_s default.
# Verified rather than assumed: grepped harness/harness.yaml and
# harness-morning/harness.yaml (both real configs muse runs) for an
# override - neither sets it, so 600 is the value actually in effect as
# of 2026-09-09. This is a real coupling to a number fleet does not own;
# if muse ever overrides it in a yaml, this drifts silently, because
# there is no live-config path fleet can read without depending on
# muse's own config loader (out of scope for a status-file parser).
STALL_TIMEOUT_S = 600


def _heartbeat_fresh(text: str) -> bool | None:
    """True/False when the printed heartbeat text lets freshness be
    determined against STALL_TIMEOUT_S, else None - "idle" (running==0,
    says nothing about a held lock's own freshness) or text this does not
    recognise."""
    m = _HEARTBEAT_AGE_RE.search(text)
    if m:
        return int(m.group(1)) <= STALL_TIMEOUT_S
    if _HEARTBEAT_UNCOVERED_RE.search(text):
        return False  # muse's own logic: a running task with NO heartbeat file is stale, unconditionally
    return None


def _classify_no_activity(text: str) -> str:
    """"benign" | "attention" | "unknown" for a NO ACTIVITY status file.

    benign, two distinct paths:
      - nothing was due: lock inactive (no worker ever tried), zero
        pending, no backlog pressure. All three required - positive
        evidence of an idle day, not just the absence of a lock.
      - a worker is genuinely alive and progressing: lock active AND the
        heartbeat is confirmed FRESH (age <= STALL_TIMEOUT_S). Found live
        (4c368d7's own false positive): a worker mid-task with a fresh
        heartbeat and real pending work queued behind it was flagged
        attention, because the original rule required an inactive lock
        unconditionally. Mere idleness-at-this-instant (lock held, but the
        printed heartbeat text does not say how old it is - "idle" is
        running==0, not a freshness fact about a held lock) does NOT
        qualify - only a CONFIRMED-fresh heartbeat does; anything else
        falls through to attention below, same "absence of alarm is not
        evidence of health" rule as the rest of this function.

    attention: everything not affirmatively benign - pending work with
    nothing running, backlog pressure, a stale lock (a crashed worker), or
    an active lock whose heartbeat is confirmed stale or cannot be
    confirmed fresh (a worker that locked itself and stopped producing
    progress, or an ambiguous reading - both default to attention, not to
    benign, on the same rule the two benign paths above are built to
    satisfy honestly rather than skip).

    unknown: the status file does not carry the fields needed to tell at
    all - reported distinctly rather than defaulting to "benign", the one
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
    if lock == "active" and _heartbeat_fresh(text) is True:
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
