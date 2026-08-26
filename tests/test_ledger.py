import tempfile
import unittest
from pathlib import Path

from fleet import ledger


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.events = Path(self.tmp.name) / "events.jsonl"
        self.handoffs = Path(self.tmp.name) / "handoffs"

    def tearDown(self):
        self.tmp.cleanup()

    def test_event_appends_and_reads_back(self):
        ledger.event("spawn", path=self.events, thread="sonnet", session_id="s1")
        ledger.event("miss", path=self.events, thread="sonnet", reason="compaction")
        evs = ledger.read_events(self.events)
        self.assertEqual([e["ev"] for e in evs], ["spawn", "miss"])
        self.assertIn("t", evs[0])

    def test_last_miss_per_thread(self):
        ledger.event("miss", path=self.events, thread="fable", reason="fresh-for-independence")
        ledger.event("miss", path=self.events, thread="sonnet", reason="compaction")
        self.assertEqual(ledger.last_miss("fable", self.events)["reason"], "fresh-for-independence")
        self.assertIsNone(ledger.last_miss("opus", self.events))

    def test_last_handoff_is_newest_by_name(self):
        d = self.handoffs / "fable"; d.mkdir(parents=True)
        (d / "20260826T010000-a.md").write_text("a")
        (d / "20260826T020000-b.md").write_text("b")
        self.assertEqual(ledger.last_handoff("fable", self.handoffs).name, "20260826T020000-b.md")
        self.assertIsNone(ledger.last_handoff("opus", self.handoffs))
