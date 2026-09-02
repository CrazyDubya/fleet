import hashlib
import json
import os
import time
from contextlib import contextmanager
from pathlib import Path

from . import ledger, tmux
from . import packet as packet_mod
from .paths import profile_state


class SendError(RuntimeError):
    pass


def send(thread: str, text: str, sender: str = "operator", events_path: Path | None = None) -> int:
    if not tmux.window_exists(thread):
        raise SendError(f"{thread} is not running (no tmux window); `fleet wake {thread}` first")
    body = f"[fleet:{sender}] {text}"
    tmux.paste(thread, body)
    n = len(body.encode())
    # The `[fleet:<sender>]` prefix is not authenticated - anything that can
    # paste into the pane can claim any sender (briefs/_protocol.md rule 2).
    # Log a digest of the exact bytes delivered so a disputed instruction can
    # be matched against what was actually sent, without copying the message
    # itself into the ledger.
    ledger.event("send", path=events_path, thread=thread, **{"from": sender}, bytes=n,
                 sha256=hashlib.sha256(body.encode()).hexdigest())
    return n


def _send_keys(name: str, keys: str) -> None:
    tmux._run("send-keys", "-t", tmux._target(name), keys, "Enter")


def send_packet(p: packet_mod.Packet, profile: str, events_path: Path | None = None,
                paste=tmux.paste, send_keys=_send_keys, sleep=time.sleep) -> str:
    if not tmux.window_exists(p.to):
        raise SendError(f"{p.to} is not running (no tmux window); `fleet wake {p.to}` first")
    p.id = p.id or packet_mod.new_id()
    # No `/effort` keystroke. It looked like a per-packet routing knob, but
    # Claude Code treats the slash command as a PERSISTENT setting - it answers
    # "saved as your default for new sessions" - so one packet rewrote the
    # operator's own global default (found live, ruling H1). Effort is a thread
    # property now: fleet.toml `effort` -> `--effort` at spawn, and a lane
    # routes to a thread that already runs at the right effort. `@effort` stays
    # in the packet header as advice to the model, not a mode change.
    # send_keys/sleep remain injectable so a test can prove nothing is typed
    # into the pane before the paste.
    text = packet_mod.format_packet(p)
    paste(p.to, text)
    if p.reply == "inline":
        _add_pending(p.sender, p.id, p.to, profile_state(profile))
    ledger.event("send", path=events_path, thread=p.to, id=p.id, lane=p.lane, effort=p.effort,
                 reply=p.reply, bytes=len(text.encode()), sha256=hashlib.sha256(text.encode()).hexdigest(),
                 **{"from": p.sender})
    return p.id


def _pending_path(sender: str, state: Path) -> Path:
    return state / "pending" / f"{sender}.json"


PENDING_LOCK_TIMEOUT = 2.0


@contextmanager
def _pending_lock(path: Path, timeout: float | None = None, sleep=time.sleep):
    """Exclusive-create lock file beside the pending file, same shape as
    registry.Registry.locked.

    _add_pending is a read-modify-write, and two threads of the same sender
    can be inside it at once (a `fleet ask` from a pane while `fleet send`
    runs from the operator's shell). Without the lock the later write is built
    on a list read before the earlier one landed, so one pending entry is
    lost - and a lost entry is a reply the Stop hook stops waiting for.

    Fails open after `timeout`: a stale lock (a process killed between create
    and unlink) must not make sending impossible.
    """
    lock = path.with_name(path.name + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + (PENDING_LOCK_TIMEOUT if timeout is None else timeout)
    fd = None
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                break  # stale lock: proceed unlocked rather than refuse to send
            sleep(0.02)
    try:
        if fd is not None:
            os.write(fd, str(os.getpid()).encode()); os.close(fd)
        yield
    finally:
        if fd is not None:
            try:
                os.unlink(lock)
            except FileNotFoundError:
                pass


def _read_pending(path: Path) -> list[dict]:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _atomic_write(path: Path, text: str) -> None:
    """Write via a sibling .tmp + os.replace, as registry.save and
    prompts.record_decision already do.

    _pending_lock serialises WRITERS, but the reader is hooks/v2/hold.sh - a
    separate bash process that does not take the lock. A plain write_text
    truncates first, and hold.sh's `jq ... 2>/dev/null || echo '[]'` turns a
    half-written read into "no pending replies", silently letting a thread end
    a turn while a reply really is outstanding. os.replace is atomic, so a
    reader sees either the whole old file or the whole new one.
    """
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def _add_pending(sender: str, pid: str, to: str, state: Path) -> None:
    path = _pending_path(sender, state)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _pending_lock(path):
        items = _read_pending(path)
        items.append({"id": pid, "to": to, "t": time.time()})
        _atomic_write(path, json.dumps(items))


def clear_pending(sender: str, pid: str, profile: str, state: Path | None = None) -> bool:
    """Drop `pid` from `sender`'s pending list; True if it was there."""
    path = _pending_path(sender, state or profile_state(profile))
    if not path.exists():
        return False
    with _pending_lock(path):
        items = _read_pending(path)
        keep = [i for i in items if i.get("id") != pid]
        if len(keep) == len(items):
            return False
        _atomic_write(path, json.dumps(keep))
        return True
