import time
import unittest
from pathlib import Path

from fleet import tmux

W = "fleet-test-window"
WA = "fleet-t-a"
WAB = "fleet-t-ab"


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
