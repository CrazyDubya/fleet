"""paste() must never concatenate a leftover draft into the next message.

Proven live on 2026-09-03: a pane holding "LEFTOVER DRAFT TEXT" received the
next packet as `LEFTOVER DRAFT TEXT @to haiku-fs2  @from operator ...` - the
protocol header corrupted, and ledger.event's sha256 describing bytes the
thread never actually read.
"""
import unittest

from fleet import tmux


class ParseInputBox(unittest.TestCase):
    def test_empty_box_is_empty_string(self):
        self.assertEqual(tmux.parse_input_box("─── x ─\n\x1b[39m❯ \n───"), "")

    def test_draft_is_returned(self):
        self.assertEqual(tmux.parse_input_box("\x1b[39m❯ do the thing\n───"), "do the thing")

    def test_dim_suggestion_is_not_a_draft(self):
        """Claude Code renders a SUGGESTED next prompt in the box, dimmed. It is
        not in any buffer and sending over it is safe."""
        self.assertEqual(
            tmux.parse_input_box("\x1b[39m❯ \x1b[2mcheck status\x1b[0m\n───"), "")

    def test_last_caret_wins_over_scrollback_echo(self):
        """Submitted prompts echo into scrollback with the same caret; the live
        box is always the last one."""
        pane = "❯ reply with exactly: alpha\n\n⏺ alpha\n── haiku-fs2 ─\n❯ \n──"
        self.assertEqual(tmux.parse_input_box(pane), "")

    def test_no_box_at_all_is_none(self):
        self.assertIsNone(tmux.parse_input_box("$ ls\nfoo\n$ "))


class PasteRefusesDirtyBox(unittest.TestCase):
    def _stub(self, boxes):
        """Drive clear_input/paste off a scripted sequence of pane captures."""
        calls = []
        seq = list(boxes)
        def fake_capture(name, lines=40, join=False, escapes=False):
            return seq[min(len(calls), len(seq) - 1)]
        def fake_run(*a, **kw):
            calls.append(a)
            return None
        return calls, fake_capture, fake_run

    def test_clean_box_pastes_and_presses_enter(self):
        calls, cap, run = self._stub(["\x1b[39m❯ "])
        orig_c, orig_r = tmux.capture, tmux._run
        try:
            tmux.capture, tmux._run = cap, run
            tmux.paste("t", "hello")
        finally:
            tmux.capture, tmux._run = orig_c, orig_r
        self.assertIn(("send-keys", "-t", tmux._target("t"), "Enter"), calls)
        self.assertNotIn(("send-keys", "-t", tmux._target("t"), "C-u"), calls)

    def test_dirty_box_that_clears_then_pastes(self):
        calls, cap, run = self._stub(["\x1b[39m❯ junk", "\x1b[39m❯ "])
        orig_c, orig_r = tmux.capture, tmux._run
        try:
            tmux.capture, tmux._run = cap, run
            tmux.paste("t", "hello")
        finally:
            tmux.capture, tmux._run = orig_c, orig_r
        self.assertIn(("send-keys", "-t", tmux._target("t"), "C-u"), calls)
        self.assertIn(("send-keys", "-t", tmux._target("t"), "Enter"), calls)

    def test_unclearable_box_refuses_and_sends_nothing(self):
        calls, cap, run = self._stub(["\x1b[39m❯ stubborn draft"])
        orig_c, orig_r = tmux.capture, tmux._run
        try:
            tmux.capture, tmux._run = cap, run
            with self.assertRaises(tmux.DirtyInputBox) as ctx:
                tmux.paste("t", "hello")
        finally:
            tmux.capture, tmux._run = orig_c, orig_r
        self.assertIn("stubborn draft", str(ctx.exception))
        self.assertIn("respawn", str(ctx.exception))
        self.assertNotIn(("load-buffer", "-b", "fleet-paste"), [c[:3] for c in calls])
        self.assertNotIn(("send-keys", "-t", tmux._target("t"), "Enter"), calls)


class SendSurfacesRefusal(unittest.TestCase):
    def test_send_packet_raises_SendError(self):
        from fleet import send as send_mod, packet as packet_mod

        def boom(name, text):
            raise tmux.DirtyInputBox("t has unsent text; respawn first")

        p = packet_mod.Packet(to="t", sender="operator", lane="build", effort="med",
                              reply="none", refs=[], done="", id="x", body="b")
        orig = tmux.window_exists
        try:
            tmux.window_exists = lambda n: True
            with self.assertRaises(send_mod.SendError):
                send_mod.send_packet(p, "v2", paste=boom)
        finally:
            tmux.window_exists = orig
