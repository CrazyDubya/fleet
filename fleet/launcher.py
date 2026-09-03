import re
import shlex
import time
import uuid
from pathlib import Path

from . import ledger, tmux
from .paths import ROOT, thread_cwd
from .registry import Entry, Registry
from .spec import Thread, active_threads, append_thread, spec_hash

SPAWN_GRACE_SECONDS = 3
SPAWN_TAIL_LINES = 20


class LaunchError(RuntimeError):
    pass


def build_argv(thread: Thread, root: Path, session_id: str | None = None, resume_id: str | None = None,
               fork: bool = False, extra_baseline: list[str] = ()) -> list[str]:
    argv = ["claude", "--model", thread.model, "--name", thread.name]
    if session_id:
        argv += ["--session-id", session_id]
    if resume_id:
        argv += ["--resume", resume_id]
        if fork:
            argv += ["--fork-session"]
    for b in [*thread.baseline, *extra_baseline]:
        argv += ["--append-system-prompt-file", str(root / b)]
    if thread.mcp:
        argv += ["--mcp-config", str(root / "mcp" / f"{thread.mcp}.json")]
    argv += ["--strict-mcp-config"]
    for d in thread.dirs:
        argv += ["--add-dir", d]
    argv += ["--permission-mode", thread.permission_mode]
    if thread.settings:
        argv += ["--settings", str(root / thread.settings)]
    if thread.effort:
        argv += ["--effort", thread.effort]
    return argv


def _spawn(thread: Thread, argv: list[str], events_path: Path | None = None) -> None:
    cwd = thread_cwd(thread)
    cwd.mkdir(parents=True, exist_ok=True)
    if tmux.window_exists(thread.name):
        raise LaunchError(f"{thread.name}: tmux window already exists")
    # remain-on-exit keeps the pane readable if claude dies inside the grace
    # window, so spec §9's "spawn_failed with stderr tail" has something to
    # report - a bad model id or a refused dialog otherwise vanished with the
    # window and the operator saw only "window closed".
    tmux.new_window(thread.name, cwd, shlex.join(argv), remain_on_exit=True)
    time.sleep(SPAWN_GRACE_SECONDS)
    alive = tmux.window_exists(thread.name)
    if not alive or tmux.pane_dead(thread.name):
        tail = _tail(thread.name) if alive else "(window vanished; no output captured)"
        ledger.event("spawn_failed", path=events_path, thread=thread.name, argv=argv, tail=tail)
        tmux.kill_window(thread.name)
        raise LaunchError(f"{thread.name}: claude exited within {SPAWN_GRACE_SECONDS}s\n{tail}")
    # Only the spawn needed the pane pinned; leaving it on would turn a later
    # crash into a zombie window that `up` refuses to replace.
    tmux.clear_remain_on_exit(thread.name)


def _tail(name: str) -> str:
    lines = [l for l in tmux.capture(name, lines=SPAWN_TAIL_LINES).splitlines() if l.strip()]
    return "\n".join(lines[-SPAWN_TAIL_LINES:])


NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")


def validate_name(name: str) -> None:
    """A thread name is a tmux window name, a directory under ROOT, part of a
    transcript directory key and a TOML bare key. Keep it boring."""
    if not NAME_RE.fullmatch(name):
        raise LaunchError(f"invalid thread name {name!r}: must match {NAME_RE.pattern}")


def _thread(name: str) -> Thread:
    validate_name(name)
    from .cli import current_profile  # local: cli imports launcher
    specs = active_threads(current_profile())
    if name not in specs:
        raise LaunchError(f"no thread named {name!r} in fleet.toml (profile {current_profile()})")
    return specs[name]


def up(name: str) -> Entry:
    t = _thread(name)
    reg = Registry()
    with reg.locked():
        entries = reg.load()
        if name in entries and entries[name].status == "running":
            raise LaunchError(f"{name} is already running")
        sid = str(uuid.uuid4())
        _spawn(t, build_argv(t, ROOT, session_id=sid))
        e = Entry(name=name, session_id=sid, cwd=str(thread_cwd(t)), model=t.model, status="running",
                  spec_hash=spec_hash(t), spawned_at=time.time(),
                  lineage=(entries[name].lineage + [entries[name].session_id]) if name in entries else [])
        entries[name] = e
        reg.save(entries)
    ledger.event("spawn", thread=name, session_id=sid, spec_hash=e.spec_hash)
    return e


def park(name: str) -> Entry:
    reg = Registry()
    with reg.locked():
        entries = reg.load()
        if name not in entries:
            raise LaunchError(f"{name} is not registered")
        e = entries[name]
        if e.status == "parked":
            print(f"{name} already parked"); return e
        if tmux.window_exists(name):
            tmux.kill_window(name)
        e.status = "parked"; reg.save(entries)
    ledger.event("park", thread=name, session_id=e.session_id)
    return e


def wake(name: str) -> Entry:
    t = _thread(name)
    reg = Registry()
    with reg.locked():
        entries = reg.load()
        if name not in entries:
            raise LaunchError(f"{name} is not registered; use `fleet up {name}`")
        e = entries[name]
        if e.status == "running" and tmux.window_exists(name):
            print(f"{name} already running"); return e
        if t.resume_policy == "packet-first":
            try:
                from .status import rows  # local import: status does not import launcher
            except ModuleNotFoundError:
                rows = None  # Task 9 not yet landed; advisory warning is skipped, not fatal
            if rows is not None:
                # Pass our own `entries`: we hold the lock (it is not
                # reentrant), and any fork-id resolution rows() performs must
                # land in the dict our own reg.save() below writes back -
                # otherwise that save reverts it to "pending".
                for r in rows(registry=reg, entries=entries):
                    if r.name == name and r.warmth == "cold" and r.resume_usd > r.respawn_usd and r.last_handoff:
                        print(f"warning: {name} is cold; resume ${r.resume_usd:.2f} > respawn ${r.respawn_usd:.2f} "
                              f"and its last handoff is already in {r.last_handoff} - consider `fleet respawn {name}`")
        _spawn(t, build_argv(t, ROOT, resume_id=e.session_id))
        e.status = "running"; reg.save(entries)
    ledger.event("wake", thread=name, session_id=e.session_id)
    return e


def fork(parent: str, new: str, brief: str) -> Entry:
    validate_name(new)
    pt = _thread(parent)
    if not pt.forkable:
        raise LaunchError(f"{parent} is not forkable (set forkable = true in fleet.toml)")
    if not (ROOT / brief).exists():
        raise LaunchError(f"brief not found: {brief}")
    from .cli import current_profile  # local: cli imports launcher
    if new in active_threads(current_profile()):
        raise LaunchError(f"[thread.{new}] already exists in fleet.toml")
    reg = Registry()
    with reg.locked():
        entries = reg.load()
        if parent not in entries:
            raise LaunchError(f"{parent} is not registered")
        if new in entries and entries[new].status == "running":
            raise LaunchError(f"{new} is already running")
        # settings=pt.settings (H2): without it the child spawned with no
        # --settings at all, i.e. no tier allow/deny list and no hooks - a
        # forked expert inherited the parent's model and brief but none of its
        # guard rails. Deferred (spec §4, recorded in the ledger): dirs are
        # copied wholesale from the parent rather than being limited to the
        # brief's @refs directories.
        child = Thread(name=new, model=pt.model, tier=pt.tier, persist="on-demand",
                       baseline=[*pt.baseline, brief], mcp=pt.mcp, dirs=pt.dirs,
                       permission_mode=pt.permission_mode, settings=pt.settings, effort=pt.effort,
                       forkable=False, fork_of=parent, resume_policy=pt.resume_policy)
        # Register the child in fleet.toml BEFORE spawning (spec §4): without
        # a [thread.<new>] (or, under a non-v1 profile, a
        # [profile.<profile>.thread.<new>]) stanza the child lives only in
        # the registry, so wake/respawn answer "no thread named", status
        # shows tier `?` and spec drift is never detected. Rolled back if
        # the spawn fails, so a failed fork does not leave a half-thread
        # behind.
        toml = ROOT / "fleet.toml"
        before = toml.read_text()
        try:
            append_thread(child, toml, profile=current_profile())
        except ValueError as exc:
            # Same-profile name collision the precheck above missed (e.g. a
            # race, or a name that exists in a different profile's namespace
            # and so passed that check) - surface it the same way every
            # other fork precondition failure is surfaced, instead of an
            # unhandled ValueError escaping from inside reg.locked().
            raise LaunchError(str(exc)) from exc
        try:
            _spawn(child, build_argv(child, ROOT, resume_id=entries[parent].session_id, fork=True))
        except LaunchError:
            toml.write_text(before)
            raise
        e = Entry(name=new, session_id="pending", cwd=str(thread_cwd(child)), model=child.model, status="running",
                  spec_hash=spec_hash(child), spawned_at=time.time(), fork_of=parent)
        entries[new] = e; reg.save(entries)
    ledger.event("fork", thread=new, fork_of=parent, parent_session=entries[parent].session_id, brief=brief)
    return e


def respawn(name: str) -> Entry:
    t = _thread(name)
    reg = Registry()
    with reg.locked():
        entries = reg.load()
        old = entries.get(name)
        if old and tmux.window_exists(name):
            tmux.kill_window(name)
        sid = str(uuid.uuid4())
        try:
            _spawn(t, build_argv(t, ROOT, session_id=sid))
        except LaunchError:
            if old:
                # window is gone (or never came up); don't leave the registry
                # claiming "running" for a dead window. Old session id and
                # lineage are untouched - only the status reflects reality.
                old.status = "parked"
                reg.save(entries)
            raise
        e = Entry(name=name, session_id=sid, cwd=str(thread_cwd(t)), model=t.model, status="running",
                  spec_hash=spec_hash(t), spawned_at=time.time(),
                  lineage=(old.lineage + [old.session_id]) if old else [])
        entries[name] = e; reg.save(entries)
    ledger.event("respawn", thread=name, session_id=sid, previous=(old.session_id if old else None))
    return e
