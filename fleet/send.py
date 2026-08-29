import hashlib
import json
import time
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
    if p.effort:
        # Effort is a per-packet routing decision (spec §1); /effort changes the
        # receiving session before the packet lands. Confirmed live against a
        # real Claude Code session (Task 9): pasting the packet immediately
        # after this send-keys races the TUI's own handling of the /effort
        # slash command and the paste is silently dropped - the pane shows
        # only the effort confirmation, never the packet. A brief settle
        # delay avoids the race; 0.5s was enough in the reproduction and
        # costs nothing on the timeout budget of a lookup (~2s round trip).
        send_keys(p.to, f"/effort {packet_mod.normalize_effort(p.effort)}")
        sleep(0.5)
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


def _add_pending(sender: str, pid: str, to: str, state: Path) -> None:
    path = _pending_path(sender, state)
    path.parent.mkdir(parents=True, exist_ok=True)
    items = json.loads(path.read_text()) if path.exists() else []
    items.append({"id": pid, "to": to, "t": time.time()})
    path.write_text(json.dumps(items))


def clear_pending(sender: str, pid: str, profile: str, state: Path | None = None) -> None:
    path = _pending_path(sender, state or profile_state(profile))
    if not path.exists():
        return
    items = [i for i in json.loads(path.read_text()) if i["id"] != pid]
    path.write_text(json.dumps(items))
