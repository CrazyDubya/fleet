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


_WS_RE = re.compile(r"\s+")


def _logical_lines(lines: list[str]) -> list[tuple[int, str]]:
    """Merge a physical line starting with exactly two spaces into the
    previous logical line, joined by a single space, remembering the first
    physical index of each logical line.

    Claude Code's own TUI soft-wraps long lines independently of tmux's pane
    width - continuation lines are rendered with a 2-space indent - so a
    header (or a reply header) that is long enough to wrap arrives as
    several physical lines even after `tmux capture-pane -J`. This collapses
    that back into one logical line, purely for readability; the wrap can
    land anywhere in the source line, including mid-token inside the pid
    itself, so the joining space above is NOT reliable as a token boundary.
    Callers (`@id`/`@re` detection in extract_reply) must strip whitespace
    entirely before matching, rather than searching for the literal joined
    text.
    """
    out: list[tuple[int, str]] = []
    for i, l in enumerate(lines):
        if out and l[:2] == "  " and l[2:3] != " ":
            idx, prev = out[-1]
            out[-1] = (idx, prev + " " + l[2:])
        else:
            out.append((i, l))
    return out


def extract_reply(pane: str, pid: str) -> str | None:
    lines = pane.splitlines()
    logical = _logical_lines(lines)
    start = next((idx for idx, l in logical if f"@id{pid}" in _WS_RE.sub("", l)), None)
    if start is None:
        return None
    # 1. a typed reply header addressed to our id. Header detection above and
    # the @re search below match against a whitespace-stripped form of each
    # logical line, because Claude Code's soft-wrap can break mid-token
    # (including inside the pid itself) - a plain substring search for
    # "@id <pid>" would miss a wrap that lands inside the pid. Body
    # collection below is still line-oriented: a real newline inside a
    # lookup reply is indistinguishable from the TUI's own soft-wrap
    # continuation, so a wrapped reply body can pick up a spurious line
    # break. Known limitation - lookup replies are expected to be short.
    re_start = next((idx for idx, l in logical if idx > start and f"@re{pid}" in _WS_RE.sub("", l)), None)
    if re_start is not None:
        body = []
        for l in lines[re_start + 1:]:
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
        pane = capture(thread, lines=200, join=True)
        reply = extract_reply(pane, pid)
        if reply is not None:
            clear(sender, pid, profile)
            return reply
        if time.monotonic() >= deadline:
            tail = "\n".join(l for l in pane.splitlines() if l.strip())[-2000:]
            raise AskTimeout(f"no reply from {thread} within {timeout:.0f}s; pane tail:\n{tail}")
        sleep(0.2)
