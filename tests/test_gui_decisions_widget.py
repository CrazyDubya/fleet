import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fleet.paths import ROOT
from gui.server import HttpError
from gui.widgets.decisions import server as dsrv


def ctx(method="GET", query=None):
    return SimpleNamespace(method=method, query=query or {})


class DecisionsWidgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.decisions_path = Path(self.tmp.name) / "DECISIONS.md"
        self.open_path = Path(self.tmp.name) / "OPEN.md"
        self.p1 = mock.patch("fleet.decisions.DECISIONS_PATH", self.decisions_path)
        self.p2 = mock.patch("fleet.decisions.OPEN_PATH", self.open_path)
        self.p1.start(); self.p2.start()

    def tearDown(self):
        self.p1.stop(); self.p2.stop(); self.tmp.cleanup()

    def test_get_is_read_only_shaped(self):
        # No POST route exists at all - this is the whole point of the
        # widget (commit 14b4bdc). ROUTES only maps "" and "handoff", both
        # to read functions.
        self.assertEqual(set(dsrv.ROUTES), {"", "handoff"})

    def test_get_rejects_non_get_method(self):
        with self.assertRaises(HttpError) as cm:
            dsrv.get(ctx("POST"))
        self.assertEqual(cm.exception.code, 405)

    def test_handoff_rejects_non_get_method(self):
        with self.assertRaises(HttpError) as cm:
            dsrv.get_handoff(ctx("POST", query={"path": "ledger/handoffs/x/y.md"}))
        self.assertEqual(cm.exception.code, 405)

    def test_watchdog_alert_absent_by_default(self):
        self.decisions_path.write_text("# Decisions\n\nNothing yet.\n")
        self.open_path.write_text("# Open\n\n| id | thread | expects | notes |\n|---|---|---|---|\n")
        out = dsrv.get(ctx())
        self.assertIsNone(out["watchdog_alert"])

    def test_watchdog_alert_surfaces_when_present(self):
        self.decisions_path.write_text("# Decisions\n\nNothing yet.\n")
        self.open_path.write_text("# Open\n\n| id | thread | expects | notes |\n|---|---|---|---|\n")
        wd = Path(self.tmp.name) / "watchdog-ALERT"
        wd.write_text("2026-09-07T04:00:00Z stuck: 3 dispatches open\n")
        with mock.patch("fleet.decisions.WATCHDOG_ALERT_PATH", wd):
            out = dsrv.get(ctx())
        self.assertEqual(out["watchdog_alert"], "2026-09-07T04:00:00Z stuck: 3 dispatches open")

    def test_no_decisions_pending_is_reported_cleanly(self):
        self.decisions_path.write_text("# Decisions\n\nNothing yet.\n")
        self.open_path.write_text("# Open\n\n| id | thread | expects | notes |\n|---|---|---|---|\n")
        out = dsrv.get(ctx())
        self.assertEqual(out["pending_count"], 0)
        self.assertEqual(out["decisions_status"], "empty")
        self.assertEqual(out["open_status"], "ok")

    def test_missing_files_are_reported_not_silently_empty(self):
        out = dsrv.get(ctx())
        self.assertEqual(out["decisions_status"], "missing")
        self.assertEqual(out["open_status"], "missing")

    def test_handoff_outside_the_handoffs_tree_is_rejected(self):
        outside = ROOT / "fleet" / "cli.py"
        self.assertTrue(outside.is_file())
        with self.assertRaises(HttpError) as cm:
            dsrv.get_handoff(ctx(query={"path": "fleet/cli.py"}))
        self.assertEqual(cm.exception.code, 403)

    def test_handoff_path_traversal_is_rejected(self):
        with self.assertRaises(HttpError) as cm:
            dsrv.get_handoff(ctx(query={"path": "ledger/handoffs/../../fleet.toml"}))
        self.assertEqual(cm.exception.code, 403)

    def test_handoff_serves_real_content_when_in_scope(self):
        d = ROOT / "ledger" / "handoffs" / "sonnet4"
        target = None
        for f in sorted(d.glob("*.md")):
            target = f
            break
        self.assertIsNotNone(target, "expected at least one real sonnet4 handoff to test against")
        rel = str(target.relative_to(ROOT))
        out = dsrv.get_handoff(ctx(query={"path": rel}))
        self.assertEqual(out["path"], rel)
        self.assertIn("@from", out["text"])

    def test_handoff_missing_file_is_404(self):
        with self.assertRaises(HttpError) as cm:
            dsrv.get_handoff(ctx(query={"path": "ledger/handoffs/sonnet4/does-not-exist.md"}))
        self.assertEqual(cm.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
