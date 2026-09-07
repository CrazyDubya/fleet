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
        self.backlog = self.root / "OPEN.md"  # deliberately absent unless a test writes it

    def tearDown(self):
        self.tmp.cleanup()

    def _write_events(self, *records):
        with open(self.events, "w") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

    # --- the watchdog's own input going away is the exact failure it exists to catch ---

    def test_missing_ledger_is_degraded_not_quiet(self):
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs, backlog_path=self.backlog)
        self.assertEqual(status.ledger_status, "missing")
        self.assertEqual(status.alert, "degraded")
        self.assertIn("DEGRADED", status.describe())

    def test_empty_ledger_is_degraded_not_quiet(self):
        self.events.touch()
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs, backlog_path=self.backlog)
        self.assertEqual(status.alert, "degraded")
        self.assertIn("DEGRADED", status.describe())

    def test_unreadable_ledger_is_degraded_not_quiet(self):
        self.events.touch()
        self.events.chmod(0o000)
        try:
            with mock.patch("fleet.ledger.status", return_value="unreadable"):
                status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs, backlog_path=self.backlog)
            self.assertEqual(status.alert, "degraded")
        finally:
            self.events.chmod(0o644)

    def test_events_with_no_timestamp_field_is_degraded(self):
        self._write_events({"ev": "send", "thread": "sonnet2"})
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs, backlog_path=self.backlog)
        self.assertEqual(status.alert, "degraded")

    # --- ordinary timer behaviour ---

    def test_recent_event_is_quiet(self):
        self._write_events({"ev": "hook", "t": time.time() - 30, "thread": "sonnet2"})
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs, backlog_path=self.backlog, threshold_min=10)
        self.assertIsNone(status.alert)
        self.assertIn("quiet", status.describe())

    # --- the distinction the whole brief is about ---

    def test_silence_with_open_dispatch_and_no_activity_evidence_is_stuck(self):
        now = time.time()
        self._write_events(
            {"ev": "send", "t": now - 3600, "thread": "sonnet2", "from": "operator",
             "id": "abc123", "lane": "build", "reply": "file", "done": "ship it"},
            {"ev": "hook", "t": now - 900, "thread": "sonnet2"},
        )
        # registry_entries={}: sonnet2 is not resolvable, so activity.check
        # reports "unknown" for it, not "quiet" - this still verifies the
        # alert stays "stuck" (an unresolvable thread is not proof of busy)
        # while staying isolated from the real, currently-active production
        # registry (sonnet2 genuinely is busy right now, which would
        # otherwise flip this test's expected verdict for reasons that have
        # nothing to do with the code under test).
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs,
                                 backlog_path=self.backlog, threshold_min=10, registry_entries={})
        self.assertEqual(status.alert, "stuck")
        self.assertIn("ALERT (stuck)", status.describe())
        self.assertIn("abc123", status.describe())
        self.assertIn("could not confirm activity", status.describe())

    def test_silence_with_open_dispatch_but_confirmed_no_activity_is_stuck(self):
        from fleet.registry import Entry
        now = time.time()
        cwd = self.root / "sonnet2"
        cwd.mkdir()
        stale = cwd / "old.txt"
        stale.write_text("x")
        import os
        os.utime(stale, (now - 7200, now - 7200))
        self._write_events(
            {"ev": "send", "t": now - 3600, "thread": "sonnet2", "from": "operator",
             "id": "abc123", "lane": "build", "reply": "file", "done": "ship it"},
            {"ev": "hook", "t": now - 900, "thread": "sonnet2"},
        )
        entries = {"sonnet2": Entry(name="sonnet2", session_id="no-such-session", cwd=str(cwd),
                                     model="x", status="running", spec_hash="x", spawned_at=0)}
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs,
                                 backlog_path=self.backlog, threshold_min=10, registry_entries=entries)
        self.assertEqual(status.alert, "stuck")
        self.assertIn("confirmed: no transcript growth or file activity", status.describe())

    def test_silence_with_open_dispatch_but_real_activity_is_not_stuck(self):
        from fleet.registry import Entry
        now = time.time()
        cwd = self.root / "sonnet2"
        cwd.mkdir()
        fresh = cwd / "grok-probes-raw.json"
        self._write_events(
            {"ev": "send", "t": now - 3600, "thread": "sonnet2", "from": "operator",
             "id": "abc123", "lane": "build", "reply": "file", "done": "ship it"},
            {"ev": "hook", "t": now - 900, "thread": "sonnet2"},
        )
        fresh.write_text("{}")  # written now - after the ledger's last event (now - 900)
        entries = {"sonnet2": Entry(name="sonnet2", session_id="no-such-session", cwd=str(cwd),
                                     model="x", status="running", spec_hash="x", spawned_at=0)}
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs,
                                 backlog_path=self.backlog, threshold_min=10, registry_entries=entries)
        self.assertIsNone(status.alert)
        self.assertIn("quiet (not stopped)", status.describe())
        self.assertIn("grok-probes-raw.json", status.describe())
        self.assertIn("still working", status.describe())

    def test_silence_with_no_backlog_file_is_idle_backlog_unknown(self):
        now = time.time()
        self._write_events(
            {"ev": "send", "t": now - 3600, "thread": "sonnet2", "from": "operator",
             "id": "abc123", "lane": "build", "reply": "none"},
            {"ev": "hook", "t": now - 900, "thread": "sonnet2"},
        )
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs,
                                 backlog_path=self.backlog, threshold_min=10)
        self.assertEqual(status.alert, "idle_backlog_unknown")
        self.assertIn("ALERT (idle, backlog unknown)", status.describe())

    def test_silence_with_empty_backlog_is_idle_empty(self):
        now = time.time()
        self._write_events(
            {"ev": "send", "t": now - 3600, "thread": "sonnet2", "from": "operator",
             "id": "abc123", "lane": "build", "reply": "none"},
            {"ev": "hook", "t": now - 900, "thread": "sonnet2"},
        )
        self.backlog.write_text("# Open assignments\n\n| id | thread | expects | notes |\n|---|---|---|---|\n")
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs,
                                 backlog_path=self.backlog, threshold_min=10)
        self.assertEqual(status.alert, "idle_empty")
        self.assertIn("ALERT (idle, backlog empty)", status.describe())
        self.assertIn("genuinely finished", status.describe())

    def test_silence_with_a_populated_backlog_is_idle_backlog(self):
        now = time.time()
        self._write_events(
            {"ev": "send", "t": now - 3600, "thread": "sonnet2", "from": "operator",
             "id": "abc123", "lane": "build", "reply": "none"},
            {"ev": "hook", "t": now - 900, "thread": "sonnet2"},
        )
        self.backlog.write_text(
            "# Open assignments\n\n| id | thread | expects | notes |\n|---|---|---|---|\n"
            "| FOO | sonnet2 | ship it | - |\n"
        )
        status = watchdog.check(events_path=self.events, handoffs_root=self.handoffs,
                                 backlog_path=self.backlog, threshold_min=10)
        self.assertEqual(status.alert, "idle_backlog")
        self.assertIn("ALERT (idle, backlog waiting)", status.describe())
        self.assertIn("FOO", status.describe())
        self.assertIn("You have not run.", status.describe())


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
