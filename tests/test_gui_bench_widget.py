import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from gui.widgets.bench import server as bsrv

FIX = Path(__file__).parent / "fixtures" / "bench_runs.jsonl"


class BenchWidgetTests(unittest.TestCase):
    def test_get_returns_summary_and_last(self):
        with mock.patch("gui.widgets.bench.server.RUNS", FIX):
            out = bsrv.get(SimpleNamespace(method="GET", query={}, json=lambda: {}, publish=lambda *a: None))
        self.assertEqual(out["summary"]["headline"]["accuracy"]["fleet"], 1.0)
        self.assertEqual(len(out["last"]), 6); self.assertEqual(out["last"][0]["run"], "r6")

    def test_bad_since_is_400(self):
        from gui.server import HttpError
        with self.assertRaises(HttpError):
            bsrv.get(SimpleNamespace(method="GET", query={"since": "yesterday"}, json=lambda: {}, publish=lambda *a: None))
