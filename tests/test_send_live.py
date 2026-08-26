import time
import unittest
from pathlib import Path

from fleet import send, tmux, ledger


class SendLiveTests(unittest.TestCase):
    W = "fleet-send-test"

    def tearDown(self):
        if tmux.window_exists(self.W):
            tmux.kill_window(self.W)

    def test_send_pastes_prefixed_text_and_logs(self):
        tmux.new_window(self.W, Path("/tmp"), "cat")
        time.sleep(0.5)
        n = send.send(self.W, "ping", sender="test")
        time.sleep(0.5)
        self.assertIn("[fleet:test] ping", tmux.capture(self.W))
        self.assertGreater(n, 0)
        last = [e for e in ledger.read_events() if e["ev"] == "send"][-1]
        self.assertEqual((last["thread"], last["from"], last["bytes"]), (self.W, "test", n))

    def test_send_to_missing_window_raises(self):
        with self.assertRaises(send.SendError):
            send.send("no-such-window", "x")
