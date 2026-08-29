import unittest

from fleet import ask

PANE_HEADER = """❯ @to haiku-fs2  @from sonnet2  @lane lookup  @effort low  @reply inline  @id abc123
  newest handoff?
⏺ @from haiku-fs2  @re abc123  @status done
  ledger/handoffs/opus/20260829T021451Z-gui-design.md
✻ Cooked for 1s · done 10:13 PM
❯
"""

PANE_BARE = """❯ @to haiku-fs2  @from sonnet2  @lane lookup  @effort low  @reply inline  @id abc123
  newest handoff?
⏺ pong
✻ Cooked for 1s · done 10:13 PM
❯
"""

PANE_WAITING = """❯ @to haiku-fs2  @from sonnet2  @lane lookup  @effort low  @reply inline  @id abc123
  newest handoff?
· Cooking… (1s)
"""

# The header line wraps (Claude Code's own TUI soft-wrap, independent of
# tmux) with the `@id` token landing on a 2-space-continuation line.
PANE_HEADER_WRAPPED_ID = """❯ @to haiku-fs2  @from sonnet2  @lane lookup  @effort low  @reply inline
  @id abc123
  newest handoff?
⏺ @from haiku-fs2  @re abc123  @status done
  ledger/handoffs/opus/20260829T021451Z-gui-design.md
✻ Cooked for 1s · done 10:13 PM
❯
"""

# The wrap lands mid-token, inside the pid itself (Claude Code's soft-wrap
# breaks at a render column, not at token boundaries) - reproduced exactly
# per review round 1 finding 1.
PANE_MID_WRAPPED_ID = """❯ @to haiku-fs2  @from sonnet2  @lane lookup  @effort low  @reply inline  @id 1a04b9ad
  e84c0ffe
  newest handoff?
⏺ @from haiku-fs2  @re 1a04b9ade84c0ffe  @status done
  ledger/handoffs/opus/20260829T021451Z-gui-design.md
✻ Cooked for 1s · done 10:13 PM
❯
"""

# Our own pasted packet's `@id` line is gone - scrolled off the captured
# window, or evicted by a Claude Code TUI redraw (confirmed live, Task 9:
# a Stop-hook round trip over the reply's own "@status done" can redraw the
# pane enough to lose it entirely). The reply's `@re <id>` header is the
# only thing left to match on.
PANE_NO_ID_HEADER = """⏺ @from haiku-fs2  @re abc123  @status ok
  ledger/handoffs/opus/20260829T021451Z-gui-design.md
✻ Cooked for 1s · done 10:13 PM
❯
"""

# The header rendered but nothing after it has yet (poll landed between the
# header line and its body) - must read as "no reply yet", not as an empty
# string that looks like a successful match to a caller checking `is None`.
PANE_HEADER_ONLY = """❯ @to haiku-fs2  @from sonnet2  @lane lookup  @effort low  @reply inline  @id abc123
  newest handoff?
⏺ @from haiku-fs2  @re abc123  @status ok
✻ Cooked for 1s · done 10:13 PM
❯
"""

# The last `⏺` block hasn't hit a terminator yet (Claude Code is still
# streaming it) - confirmed live (Task 9, haiku-router2): a transient
# "Improvising…"-style status line doesn't match any of END_RE's glyphs.
PANE_UNTERMINATED_BLOCK = """❯ @to haiku-fs2  @from sonnet2  @lane lookup  @effort low  @reply inline  @id abc123
  newest handoff?
⏺ Running 1 shell command…

✳ Improvising… (3s · thought for 3s)
"""

# A completed tool-call block (properly terminated) is followed by a SECOND,
# still-streaming block. The first block must never be handed back as "the
# reply" just because the second one hasn't settled - that would return a
# `⏺ Bash(...)` tool-call summary as if it were the answer.
PANE_TOOL_BLOCK_THEN_UNTERMINATED = """❯ @to haiku-fs2  @from sonnet2  @lane lookup  @effort low  @reply inline  @id abc123
  newest handoff?
⏺ Bash(ls gui/widgets)
✻ Ran for 1s
⏺ Running 1 shell command…

✳ Improvising… (2s)
"""


class ExtractTests(unittest.TestCase):
    def test_header_reply(self):
        self.assertEqual(ask.extract_reply(PANE_HEADER, "abc123"), "ledger/handoffs/opus/20260829T021451Z-gui-design.md")

    def test_bare_reply_block(self):
        self.assertEqual(ask.extract_reply(PANE_BARE, "abc123"), "pong")

    def test_no_reply_yet(self):
        self.assertIsNone(ask.extract_reply(PANE_WAITING, "abc123"))

    def test_ignores_blocks_before_our_packet(self):
        pane = "⏺ old answer\n" + PANE_WAITING
        self.assertIsNone(ask.extract_reply(pane, "abc123"))

    def test_wrapped_id_header_still_detected(self):
        self.assertEqual(ask.extract_reply(PANE_HEADER_WRAPPED_ID, "abc123"),
                          "ledger/handoffs/opus/20260829T021451Z-gui-design.md")

    def test_wrapped_mid_id_header_still_detected(self):
        self.assertEqual(ask.extract_reply(PANE_MID_WRAPPED_ID, "1a04b9ade84c0ffe"),
                          "ledger/handoffs/opus/20260829T021451Z-gui-design.md")

    def test_reply_found_without_our_own_id_line_visible(self):
        # Review round 1, finding 1 (Task 9): the anchor is no longer
        # required - @re{pid} alone identifies the reply.
        self.assertEqual(ask.extract_reply(PANE_NO_ID_HEADER, "abc123"),
                          "ledger/handoffs/opus/20260829T021451Z-gui-design.md")

    def test_header_with_no_body_yet_is_not_a_reply(self):
        # Review round 1, minor: `_strip(body) or None`.
        self.assertIsNone(ask.extract_reply(PANE_HEADER_ONLY, "abc123"))

    def test_unterminated_block_is_not_a_reply(self):
        # Review round 1, finding 1 (Task 9): an in-progress ⏺ block must
        # not be returned as if it were the finished reply.
        self.assertIsNone(ask.extract_reply(PANE_UNTERMINATED_BLOCK, "abc123"))

    def test_unterminated_block_does_not_fall_back_to_an_earlier_one(self):
        # Review round 1, minor: a completed tool-call block must never be
        # returned just because a later, still-streaming block exists.
        self.assertIsNone(ask.extract_reply(PANE_TOOL_BLOCK_THEN_UNTERMINATED, "abc123"))


class AskTests(unittest.TestCase):
    def test_returns_reply_and_clears_pending(self):
        frames = iter([PANE_WAITING, PANE_BARE])
        cleared = []
        out = ask.ask("haiku-fs2", "newest handoff?", sender="sonnet2", profile="v2",
                      capture=lambda name, lines=200, join=False: next(frames),
                      send=lambda p, profile, **kw: "abc123",
                      clear=lambda sender, pid, profile: cleared.append(pid),
                      sleep=lambda s: None)
        self.assertEqual(out, "pong")
        self.assertEqual(cleared, ["abc123"])

    def test_timeout_raises_with_tail(self):
        with self.assertRaises(ask.AskTimeout) as cm:
            ask.ask("haiku-fs2", "x", sender="sonnet2", profile="v2", timeout=0.0,
                    capture=lambda name, lines=200, join=False: PANE_WAITING,
                    send=lambda p, profile, **kw: "abc123",
                    clear=lambda *a: None, sleep=lambda s: None)
        self.assertIn("Cooking", str(cm.exception))

    def test_ask_timeout_clears_pending(self):
        # C3: send_packet records a pending entry for every inline-reply
        # packet and hold.sh (Stop) blocks the turn while one is outstanding.
        # A timed-out ask used to leave its entry behind, arming hold.sh
        # forever - the thread could not end any turn again.
        cleared = []
        with self.assertRaises(ask.AskTimeout):
            ask.ask("haiku-fs2", "x", sender="sonnet2", profile="v2", timeout=0.0,
                    capture=lambda name, lines=200, join=False: PANE_WAITING,
                    send=lambda p, profile, **kw: "abc123",
                    clear=lambda sender, pid, profile: cleared.append((sender, pid, profile)),
                    sleep=lambda s: None)
        self.assertEqual(cleared, [("sonnet2", "abc123", "v2")])
