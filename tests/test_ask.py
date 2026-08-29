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
