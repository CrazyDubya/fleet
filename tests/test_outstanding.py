import json
import tempfile
import time
import unittest
from dataclasses import dataclass
from pathlib import Path

from fleet import outstanding


@dataclass
class _Entry:
    name: str
    session_id: str
    cwd: str
    fork_of: str | None = None


class OutstandingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.events = self.root / "events.jsonl"
        self.handoffs = self.root / "handoffs"

    def tearDown(self):
        self.tmp.cleanup()

    def _write_events(self, *records):
        with open(self.events, "w") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

    def test_missing_ledger_is_not_zero_outstanding(self):
        report = outstanding.outstanding(events_path=self.events, handoffs_root=self.handoffs)
        self.assertEqual(report.ledger_status, "missing")
        self.assertEqual(report.outstanding, [])
        self.assertIn("no ledger at", report.describe())

    def test_empty_ledger_is_distinct_from_zero_outstanding(self):
        self.events.touch()
        report = outstanding.outstanding(events_path=self.events, handoffs_root=self.handoffs)
        self.assertEqual(report.ledger_status, "empty")
        self.assertIn("zero send events", report.describe())

    def test_file_reply_answered_by_handoff(self):
        self._write_events({"ev": "send", "t": 1000.0, "thread": "sonnet2", "from": "operator",
                             "id": "abc123", "lane": "build", "reply": "file", "done": "it runs"})
        d = self.handoffs / "sonnet2"
        d.mkdir(parents=True)
        (d / "reply.md").write_text("- **@from** sonnet2 · **@re** abc123 · **status** done\ndone.")
        report = outstanding.outstanding(events_path=self.events, handoffs_root=self.handoffs)
        self.assertEqual(report.ledger_status, "ok")
        self.assertEqual(report.outstanding, [])
        self.assertEqual(len(report.answered), 1)

    def test_file_reply_with_no_handoff_is_outstanding(self):
        self._write_events({"ev": "send", "t": time.time() - 3600, "thread": "sonnet2", "from": "operator",
                             "id": "abc123", "lane": "build", "reply": "file", "done": "it runs"})
        report = outstanding.outstanding(events_path=self.events, handoffs_root=self.handoffs)
        [item] = report.outstanding
        self.assertEqual(item.d.id, "abc123")
        self.assertAlmostEqual(item.age_s, 3600, delta=5)
        self.assertIn("it runs", report.describe())

    def test_no_id_events_are_counted_not_silently_dropped(self):
        self._write_events(
            {"ev": "send", "t": 1000.0, "thread": "sonnet2", "from": "operator", "bytes": 5, "sha256": "x"},
            {"ev": "send", "t": 1001.0, "thread": "sonnet2", "from": "operator",
             "id": "abc123", "lane": "build", "reply": "file"},
        )
        report = outstanding.outstanding(events_path=self.events, handoffs_root=self.handoffs)
        self.assertEqual(report.no_id, 1)
        self.assertEqual(len(report.items), 1)

    def test_reply_none_is_excluded(self):
        self._write_events({"ev": "send", "t": 1000.0, "thread": "sonnet2", "from": "operator",
                             "id": "abc123", "lane": "consult", "reply": "none"})
        report = outstanding.outstanding(events_path=self.events, handoffs_root=self.handoffs)
        self.assertEqual(report.excluded_no_reply, 1)
        self.assertEqual(report.items, [])

    def test_inline_lookup_answered_via_transcript(self):
        cwd = self.root / "muse2"
        cwd.mkdir()
        proj_key = str(cwd).replace("/", "-")
        proj_dir = Path.home() / ".claude" / "projects" / proj_key
        proj_dir.mkdir(parents=True, exist_ok=True)
        session_id = "sess-outstanding-test"
        transcript = proj_dir / f"{session_id}.jsonl"
        try:
            with open(transcript, "w") as f:
                f.write(json.dumps({"type": "user", "timestamp": "2026-09-06T15:46:46Z",
                                     "message": {"content": "@to muse2 @id deadbeef00001111"}}) + "\n")
                f.write(json.dumps({"type": "assistant", "timestamp": "2026-09-06T15:46:59Z",
                                     "message": {"content": [{"type": "text", "text": "here is the answer"}]}}) + "\n")
            self._write_events({"ev": "send", "t": 1788709606.0, "thread": "muse2", "from": "operator",
                                 "id": "deadbeef00001111", "lane": "lookup", "reply": "inline"})

            class _Registry:
                def load(self):
                    return {"muse2": _Entry(name="muse2", session_id=session_id, cwd=str(cwd))}

            import fleet.registry as registry_mod
            orig = registry_mod.Registry
            registry_mod.Registry = lambda *a, **k: _Registry()
            try:
                report = outstanding.outstanding(events_path=self.events, handoffs_root=self.handoffs)
            finally:
                registry_mod.Registry = orig
            self.assertEqual(report.outstanding, [])
            [item] = report.answered
            self.assertAlmostEqual(item.age_s, 13.0, delta=1)
        finally:
            transcript.unlink(missing_ok=True)

    def test_inline_lookup_with_no_transcript_reply_is_outstanding(self):
        cwd = self.root / "muse2b"
        cwd.mkdir()
        proj_key = str(cwd).replace("/", "-")
        proj_dir = Path.home() / ".claude" / "projects" / proj_key
        proj_dir.mkdir(parents=True, exist_ok=True)
        session_id = "sess-outstanding-test-2"
        transcript = proj_dir / f"{session_id}.jsonl"
        try:
            with open(transcript, "w") as f:
                f.write(json.dumps({"type": "user", "timestamp": "2026-09-06T15:46:46Z",
                                     "message": {"content": "@to muse2 @id deadbeef00002222"}}) + "\n")
            self._write_events({"ev": "send", "t": time.time() - 60, "thread": "muse2b", "from": "operator",
                                 "id": "deadbeef00002222", "lane": "lookup", "reply": "inline"})

            class _Registry:
                def load(self):
                    return {"muse2b": _Entry(name="muse2b", session_id=session_id, cwd=str(cwd))}

            import fleet.registry as registry_mod
            orig = registry_mod.Registry
            registry_mod.Registry = lambda *a, **k: _Registry()
            try:
                report = outstanding.outstanding(events_path=self.events, handoffs_root=self.handoffs)
            finally:
                registry_mod.Registry = orig
            [item] = report.outstanding
            self.assertEqual(item.d.id, "deadbeef00002222")
        finally:
            transcript.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
