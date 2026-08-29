import subprocess
import time
import unittest
from pathlib import Path
from unittest import mock

from fleet import tmux

W = "fleet-test-window"
WA = "fleet-t-a"
WAB = "fleet-t-ab"


class PasteArgvTests(unittest.TestCase):
    """`cat` never requests bracketed-paste mode, so the live paste test
    below cannot observe the brackets. Pin the flag structurally instead:
    without -p, Claude Code submits a multi-line packet line by line."""

    def test_paste_uses_bracketed_paste(self):
        argv = tmux.paste_argv("thing")
        self.assertEqual(argv[0], "paste-buffer")
        self.assertIn("-p", argv)
        self.assertEqual(argv[argv.index("-t") + 1], "fleet:=thing")


class CaptureArgsTests(unittest.TestCase):
    """Argument shape only, no live tmux needed (parallels PasteArgvTests)."""

    def test_capture_join_flag(self):
        calls: list[list[str]] = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        with mock.patch("fleet.tmux.subprocess.run", fake_run):
            tmux.capture("thing", join=True)
            tmux.capture("thing")

        self.assertIn("-J", calls[0])
        self.assertNotIn("-J", calls[1])


class TmuxLiveTests(unittest.TestCase):
    def tearDown(self):
        for name in (W, WA, WAB):
            if tmux.window_exists(name):
                tmux.kill_window(name)

    def test_window_lifecycle_and_paste(self):
        tmux.ensure_session()
        self.assertFalse(tmux.window_exists(W))
        tmux.new_window(W, Path("/tmp"), "cat")
        time.sleep(0.5)
        self.assertTrue(tmux.window_exists(W))
        tmux.paste(W, "[fleet:test] hello\nsecond line")
        time.sleep(0.5)
        out = tmux.capture(W)
        self.assertIn("[fleet:test] hello", out)
        self.assertIn("second line", out)
        tmux.kill_window(W)
        self.assertFalse(tmux.window_exists(W))

    def test_kill_window_exact_match_does_not_hit_prefix_match(self):
        tmux.ensure_session()
        tmux.new_window(WA, Path("/tmp"), "cat")
        tmux.new_window(WAB, Path("/tmp"), "cat")
        time.sleep(0.5)
        self.assertTrue(tmux.window_exists(WA))
        self.assertTrue(tmux.window_exists(WAB))
        tmux.kill_window(WA)
        time.sleep(0.5)
        self.assertFalse(tmux.window_exists(WA))
        self.assertTrue(tmux.window_exists(WAB))
