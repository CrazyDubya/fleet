import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from fleet import watchdog


class WatchdogTests(unittest.TestCase):
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

    # --- the watchdog's own input going away is the exact failure it exists to catch ---

    def test_missing_ledger_is_degraded_not_quiet(self):
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs)
        self.assertEqual(status.ledger_status, "missing")
        self.assertEqual(status.alert, "degraded")
        self.assertIn("DEGRADED", status.describe())

    def test_empty_ledger_is_degraded_not_quiet(self):
        self.events.touch()
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs)
        self.assertEqual(status.alert, "degraded")
        self.assertIn("DEGRADED", status.describe())

    def test_unreadable_ledger_is_degraded_not_quiet(self):
        self.events.touch()
        self.events.chmod(0o000)
        try:
            with mock.patch("fleet.ledger.status", return_value="unreadable"):
                status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs)
            self.assertEqual(status.alert, "degraded")
        finally:
            self.events.chmod(0o644)

    def test_events_with_no_timestamp_field_is_degraded(self):
        self._write_events({"ev": "send", "thread": "sonnet2"})
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs)
        self.assertEqual(status.alert, "degraded")

    # --- ordinary timer behaviour ---

    def test_recent_event_is_quiet(self):
        self._write_events({"ev": "hook", "t": time.time() - 30, "thread": "sonnet2"})
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs, threshold_min=10)
        self.assertIsNone(status.alert)
        self.assertIn("quiet", status.describe())

    # --- the distinction the whole brief is about ---

    def test_silence_with_open_dispatch_is_stuck(self):
        now = time.time()
        self._write_events(
            {"ev": "send", "t": now - 3600, "thread": "sonnet2", "from": "operator",
             "id": "abc123", "lane": "build", "reply": "file", "done": "ship it"},
            {"ev": "hook", "t": now - 900, "thread": "sonnet2"},
        )
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs, threshold_min=10)
        self.assertEqual(status.alert, "stuck")
        self.assertIn("ALERT (stuck)", status.describe())
        self.assertIn("abc123", status.describe())

    def test_silence_with_empty_queue_is_idle_queue(self):
        now = time.time()
        self._write_events(
            {"ev": "send", "t": now - 3600, "thread": "sonnet2", "from": "operator",
             "id": "abc123", "lane": "build", "reply": "none"},
            {"ev": "hook", "t": now - 900, "thread": "sonnet2"},
        )
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs, threshold_min=10)
        self.assertEqual(status.alert, "idle_queue")
        self.assertIn("ALERT (idle queue)", status.describe())
        self.assertIn("waiting on a dispatch from you", status.describe())


class FleetWideGapsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.events = Path(self.tmp.name) / "events.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def test_gaps_over_threshold_are_found(self):
        base = 1_000_000.0
        with open(self.events, "w") as f:
            for t in (base, base + 5, base + 700, base + 705, base + 2000):
                f.write(json.dumps({"ev": "hook", "t": t}) + "\n")
        gaps = watchdog.fleet_wide_gaps(self.events, min_gap_s=600)
        self.assertEqual(sorted(round(g) for g in gaps), [695, 1295])

    def test_window_restricts_to_trailing_seconds(self):
        base = 1_000_000.0
        with open(self.events, "w") as f:
            for t in (base, base + 5000, base + 5700, base + 5705):
                f.write(json.dumps({"ev": "hook", "t": t}) + "\n")
        gaps = watchdog.fleet_wide_gaps(self.events, window_s=1000, min_gap_s=600)
        self.assertEqual(gaps, [700.0])


class CliWatchdogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.events = Path(self.tmp.name) / "events.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, *argv):
        from fleet.cli import cmd_watchdog, _build_parser
        args = _build_parser().parse_args(["watchdog", *argv])
        return cmd_watchdog(args)

    def test_events_path_flag_reaches_a_missing_ledger(self):
        rc = self._run("--events-path", str(self.events))
        self.assertEqual(rc, 1)

    def test_minutes_flag_overrides_the_default_threshold(self):
        with open(self.events, "w") as f:
            f.write(json.dumps({"ev": "hook", "t": time.time() - 120}) + "\n")
        # 120s idle: alerts at a 1-minute threshold, quiet at the 10-minute default.
        self.assertEqual(self._run("--events-path", str(self.events), "--minutes", "1"), 1)
        self.assertEqual(self._run("--events-path", str(self.events)), 0)


if __name__ == "__main__":
    unittest.main()
