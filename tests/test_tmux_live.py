import time
import unittest
from pathlib import Path

from fleet import tmux

W = "fleet-test-window"


class TmuxLiveTests(unittest.TestCase):
    def tearDown(self):
        if tmux.window_exists(W):
            tmux.kill_window(W)

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
