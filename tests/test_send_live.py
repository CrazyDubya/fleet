import hashlib
import tempfile
import time
import unittest
from pathlib import Path

from fleet import ledger, send, tmux


class SendLiveTests(unittest.TestCase):
    W = "fleet-send-test"

    def setUp(self):
        # Events go to a temp file: this test used to append `send` records to
        # the production ledger/events.jsonl, which telemetry then derives
        # into real per-day handoff counts.
        self.tmp = tempfile.TemporaryDirectory()
        self.events = Path(self.tmp.name) / "events.jsonl"

    def tearDown(self):
        if tmux.window_exists(self.W):
            tmux.kill_window(self.W)
        self.tmp.cleanup()

    def test_send_pastes_prefixed_text_and_logs(self):
        tmux.new_window(self.W, Path("/tmp"), "cat")
        time.sleep(0.5)
        n = send.send(self.W, "ping", sender="test", events_path=self.events)
        time.sleep(0.5)
        self.assertIn("[fleet:test] ping", tmux.capture(self.W))
        self.assertGreater(n, 0)
        [last] = [e for e in ledger.read_events(self.events) if e["ev"] == "send"]
        self.assertEqual((last["thread"], last["from"], last["bytes"]), (self.W, "test", n))
        # the prefix is unauthenticated, so the ledger pins what was delivered
        self.assertEqual(last["sha256"], hashlib.sha256(b"[fleet:test] ping").hexdigest())

    def test_nothing_is_written_to_the_production_ledger(self):
        # Counting total events raced the live fleet: every Bash call a working
        # thread makes writes a `gate` hook event to this same ledger, so the
        # count moved for reasons that have nothing to do with send(). Assert
        # what the test actually means instead - that THIS send left no trace in
        # the production ledger - which is race-free by construction.
        def ours(events):
            return [e for e in events
                    if e.get("thread") == self.W or e.get("from") == "test"]

        before = ours(ledger.read_events())
        tmux.new_window(self.W, Path("/tmp"), "cat")
        time.sleep(0.5)
        send.send(self.W, "ping", sender="test", events_path=self.events)
        self.assertEqual(ours(ledger.read_events()), before,
                         "send() with events_path= must not touch the default ledger")

    def test_send_to_missing_window_raises(self):
        with self.assertRaises(send.SendError):
            send.send("no-such-window", "x", events_path=self.events)


if __name__ == "__main__":
    unittest.main()
