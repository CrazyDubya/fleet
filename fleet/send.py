from . import ledger, tmux


class SendError(RuntimeError):
    pass


def send(thread: str, text: str, sender: str = "operator") -> int:
    if not tmux.window_exists(thread):
        raise SendError(f"{thread} is not running (no tmux window); `fleet wake {thread}` first")
    body = f"[fleet:{sender}] {text}"
    tmux.paste(thread, body)
    n = len(body.encode())
    ledger.event("send", thread=thread, **{"from": sender}, bytes=n)
    return n
