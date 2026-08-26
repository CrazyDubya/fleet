import hashlib
from pathlib import Path

from . import ledger, tmux


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
