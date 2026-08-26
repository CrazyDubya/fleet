import shlex
import time
import uuid
from pathlib import Path

from . import ledger, tmux
from .paths import ROOT, thread_dir
from .registry import Entry, Registry
from .spec import Thread, load_specs, spec_hash

SPAWN_GRACE_SECONDS = 3


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
    if thread.effort:
        argv += ["--effort", thread.effort]
    return argv


def _spawn(thread: Thread, argv: list[str]) -> None:
    cwd = thread_dir(thread.name)
    cwd.mkdir(parents=True, exist_ok=True)
    if tmux.window_exists(thread.name):
        raise LaunchError(f"{thread.name}: tmux window already exists")
    tmux.new_window(thread.name, cwd, shlex.join(argv))
    time.sleep(SPAWN_GRACE_SECONDS)
    if not tmux.window_exists(thread.name):
        ledger.event("spawn_failed", thread=thread.name, argv=argv)
        raise LaunchError(f"{thread.name}: claude exited within {SPAWN_GRACE_SECONDS}s (window closed)")


def _thread(name: str) -> Thread:
    specs = load_specs()
    if name not in specs:
        raise LaunchError(f"no thread named {name!r} in fleet.toml")
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
        e = Entry(name=name, session_id=sid, cwd=str(thread_dir(name)), model=t.model, status="running",
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
    pt = _thread(parent)
    if not pt.forkable:
        raise LaunchError(f"{parent} is not forkable (set forkable = true in fleet.toml)")
    if not (ROOT / brief).exists():
        raise LaunchError(f"brief not found: {brief}")
    reg = Registry()
    with reg.locked():
        entries = reg.load()
        if parent not in entries:
            raise LaunchError(f"{parent} is not registered")
        if new in entries and entries[new].status == "running":
            raise LaunchError(f"{new} is already running")
        child = Thread(name=new, model=pt.model, tier=pt.tier, persist="on-demand",
                       baseline=[*pt.baseline, brief], mcp=pt.mcp, dirs=pt.dirs,
                       permission_mode=pt.permission_mode, effort=pt.effort, fork_of=parent)
        _spawn(child, build_argv(child, ROOT, resume_id=entries[parent].session_id, fork=True))
        e = Entry(name=new, session_id="pending", cwd=str(thread_dir(new)), model=child.model, status="running",
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
        e = Entry(name=name, session_id=sid, cwd=str(thread_dir(name)), model=t.model, status="running",
                  spec_hash=spec_hash(t), spawned_at=time.time(),
                  lineage=(old.lineage + [old.session_id]) if old else [])
        entries[name] = e; reg.save(entries)
    ledger.event("respawn", thread=name, session_id=sid, previous=(old.session_id if old else None))
    return e
