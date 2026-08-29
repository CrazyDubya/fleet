"""Synchronous lookup against a tool-tier thread (spec §2).

Paste a lookup packet, poll the pane until the reply lands, return it as
text. Measured haiku round-trip: 1.5 s. The caller gets the answer inside
its own turn - no cross-session message, nothing to wait for.
"""
import re
import time

from . import packet as packet_mod, send as send_mod, tmux

BLOCK_RE = re.compile(r"^⏺ ?(.*)$")
END_RE = re.compile(r"^(✻|❯|·)")


class AskTimeout(RuntimeError):
    pass


def _strip(lines: list[str]) -> str:
    return "\n".join(l[2:] if l.startswith("  ") else l for l in lines).strip()


def extract_reply(pane: str, pid: str) -> str | None:
    lines = pane.splitlines()
    start = next((i for i, l in enumerate(lines) if f"@id {pid}" in l), None)
    if start is None:
        return None
    # 1. a typed reply header addressed to our id
    for i in range(start + 1, len(lines)):
        if f"@re {pid}" in lines[i]:
            body = []
            for l in lines[i + 1:]:
                if END_RE.match(l):
                    break
                body.append(l)
            return _strip(body)
    # 2. the last bare ⏺ block after our packet
    blocks: list[list[str]] = []
    cur: list[str] | None = None
    for l in lines[start + 1:]:
        m = BLOCK_RE.match(l)
        if m:
            cur = [m.group(1)]; blocks.append(cur)
        elif cur is not None and END_RE.match(l):
            cur = None
        elif cur is not None:
            cur.append(l)
    return _strip(blocks[-1]) if blocks else None


def ask(thread: str, body: str, sender: str, profile: str, timeout: float = 30.0,
        capture=tmux.capture, send=send_mod.send_packet, clear=send_mod.clear_pending, sleep=time.sleep) -> str:
    p = packet_mod.Packet(to=thread, sender=sender, lane="lookup", effort="low", reply="inline", body=body)
    pid = send(p, profile)
    deadline = time.monotonic() + timeout
    while True:
        pane = capture(thread, lines=200)
        reply = extract_reply(pane, pid)
        if reply is not None:
            clear(sender, pid, profile)
            return reply
        if time.monotonic() >= deadline:
            tail = "\n".join(l for l in pane.splitlines() if l.strip())[-2000:]
            raise AskTimeout(f"no reply from {thread} within {timeout:.0f}s; pane tail:\n{tail}")
        sleep(0.2)
