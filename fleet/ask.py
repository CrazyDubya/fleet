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
    # 1. a typed reply header addressed to our id, searched across the WHOLE
    # pane rather than only after `start`. Header detection above and the
    # @re search below match against a whitespace-stripped form of each
    # logical line, because Claude Code's soft-wrap can break mid-token
    # (including inside the pid itself) - a plain substring search for
    # "@id <pid>" would miss a wrap that lands inside the pid. Body
    # collection below is still line-oriented: a real newline inside a
    # lookup reply is indistinguishable from the TUI's own soft-wrap
    # continuation, so a wrapped reply body can pick up a spurious line
    # break. Known limitation - lookup replies are expected to be short.
    #
    # Not anchored on `idx > start`: confirmed live (Task 9, haiku-router2)
    # that Claude Code's TUI can redraw/clear the pane once a turn produces
    # enough output (there, a Stop-hook round trip over its own "@status
    # done"), which can push our own pasted `@id` line out of the captured
    # pane - or out of tmux's scrollback entirely - before the reply itself
    # has rendered, permanently orphaning `start` and hanging every later
    # poll until AskTimeout even though the reply is sitting right there.
    # `@re{pid}` on its own already uniquely identifies a reply to THIS
    # packet (ids are fresh per packet_mod.new_id()), so it does not need
    # `start` to still be visible; `test_ignores_blocks_before_our_packet`
    # keeps the ordering requirement for step 2 below, where a bare block
    # carries no id to disambiguate it by.
    re_start = next((idx for idx, l in logical if f"@re{pid}" in _WS_RE.sub("", l)), None)
    if re_start is not None:
        body = []
        for l in lines[re_start + 1:]:
            if END_RE.match(l):
                break
            body.append(l)
        # A header line with nothing after it (capture landed between the
        # header rendering and its body) must not read as "a reply came
        # back" - an empty string is truthy-adjacent enough to fool a caller
        # that only checks `is not None`, so normalize it to None and let
        # the poll loop try again.
        return _strip(body) or None
    if start is None:
        return None
    # 2. the last bare ⏺ block after our packet
    blocks: list[list[str]] = []
    cur: list[str] | None = None
    def _drop_if_status(b):
        # A single-line block ending in the TUI's ellipsis is a tool-status
        # line ("Running 1 shell command…"), not an answer. Confirmed live:
        # haiku-fs2 running a delegated grep (T6/T7 "empty capture").
        if b and len(b) == 1 and b[0].rstrip().endswith("…"):
            blocks.pop()

    for l in lines[start + 1:]:
        m = BLOCK_RE.match(l)
        if m:
            if cur is not None:
                _drop_if_status(cur)
            cur = [m.group(1)]; blocks.append(cur)
        elif cur is not None and END_RE.match(l):
            # A single-line block ending in the TUI's ellipsis is a tool-status
            # line ("Running 1 shell command…", "Bash(node --test …)…"), not an
            # answer - it terminates cleanly and then the real reply renders
            # later, so treating it as the reply returns status text to the
            # caller. Drop it and keep polling. Confirmed live: haiku-fs2
            # running a delegated grep (T6/T7 handoffs' "empty capture").
            _drop_if_status(cur)
            cur = None
        elif cur is not None:
            cur.append(l)
    if cur is not None:
        # The most recently started block never hit an END_RE terminator
        # before the capture ended, i.e. Claude Code is still streaming it -
        # confirmed live (Task 9, haiku-router2): polling can catch a ⏺
        # block that has only a transient "thinking/working" status line in
        # it so far, and returning that as "the reply" hands back spinner
        # text instead of the real answer that renders a moment later. Treat
        # an unterminated block as not-yet-a-reply and keep polling, rather
        # than one more terminator glyph in END_RE - the busy indicator
        # isn't a fixed single character. Return None outright rather than
        # falling back to an earlier, already-terminated block: that earlier
        # block could be a tool-call summary (e.g. "⏺ Bash(...)") the model
        # produced before the real answer, which must never be handed back
        # as if it were the reply just because a later block hasn't settled
        # yet.
        return None
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
            # Drop the pending entry we just created. send_packet records one
            # for every reply == "inline" packet and hold.sh (the Stop hook)
            # blocks the caller's turn while one is outstanding - so a lookup
            # that timed out used to arm hold.sh permanently, leaving the
            # thread unable to end any turn until the operator ran
            # `fleet miss`. The reply is no longer being waited for, so the
            # entry has to go before the exception leaves.
            clear(sender, pid, profile)
            tail = "\n".join(l for l in pane.splitlines() if l.strip())[-2000:]
            raise AskTimeout(f"no reply from {thread} within {timeout:.0f}s; pane tail:\n{tail}")
        sleep(0.2)
