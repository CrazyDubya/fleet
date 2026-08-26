import unittest
from pathlib import Path

from fleet import transcript

FX = Path(__file__).parent / "fixtures" / "small.jsonl"


class TranscriptTests(unittest.TestCase):
    def test_dedupes_by_message_id_and_sums(self):
        p = transcript.parse(FX)
        self.assertEqual([t.msg_id for t in p.turns], ["m1", "m2"])
        self.assertEqual(p.turns[0].cache_1h, 1000)
        self.assertEqual(p.turns[1].cache_read, 1000)
        self.assertEqual(p.turns[1].stop_reason, "tool_use")
        self.assertEqual(p.errors, 2)

    def test_last_record_state(self):
        p = transcript.parse(FX)
        self.assertEqual(p.last_type, "user")
        self.assertAlmostEqual(p.last_ts, 1787717101.0, places=0)

    def test_missing_file_is_empty(self):
        p = transcript.parse(Path("/nonexistent/x.jsonl"))
        self.assertEqual(p.turns, []); self.assertIsNone(p.last_type)

    def test_parses_a_real_transcript_without_error(self):
        real = sorted(Path.home().glob(".claude/projects/*/*.jsonl"), key=lambda q: q.stat().st_size)
        if not real:
            self.skipTest("no real transcripts on this machine")
        p = transcript.parse(real[-1])
        self.assertGreaterEqual(len(p.turns), 1)
        self.assertEqual(len({t.msg_id for t in p.turns}), len(p.turns))
