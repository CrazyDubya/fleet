import json
import unittest
from pathlib import Path
from unittest import mock

from fleet import cli
from fleet.bench import report

FIX = Path(__file__).parent / "fixtures" / "bench_runs.jsonl"
ROWS = [json.loads(l) for l in FIX.read_text().splitlines()]


class ReportTests(unittest.TestCase):
    def test_per_arm_stats(self):
        s = report.summarize(ROWS)
        a = s["t1"]["sonnet"]
        self.assertEqual((a["n"], a["pass_rate"], a["wall_med"], a["usd_med"]), (2, 0.5, 85.0, 0.45))
        self.assertEqual(s["t1"]["fleet"]["weekly_med"], 0.32)
        self.assertEqual(s["t1"]["fleet"]["interventions_per_run"], 1.0)
        self.assertEqual(s["t1"]["fable"]["judge_med"], 4.5)

    def test_headline_ratios(self):
        h = report.summarize(ROWS)["headline"]
        self.assertEqual(h["accuracy"]["fleet"], 1.0); self.assertEqual(h["accuracy"]["fleet_vs_sonnet"], 2.0)
        self.assertAlmostEqual(h["cost"]["fleet_vs_fable"], 0.32 / 4.5, places=3)
        self.assertAlmostEqual(h["time"]["fleet_vs_sonnet"], 102.0 / 90.0, places=3)  # per pass: sonnet's only pass took 90 s

    def test_missing_arm_yields_none_not_crash(self):
        h = report.summarize([r for r in ROWS if r["arm"] != "fable"])["headline"]
        self.assertIsNone(h["cost"]["fleet_vs_fable"])

    def test_render_mentions_n(self):
        text = report.render(report.summarize(ROWS))
        self.assertIn("n=2", text); self.assertIn("fleet", text); self.assertIn("accuracy", text.lower())

    def test_judge_cost_is_reported_separately_from_usd(self):
        s = report.summarize(ROWS)
        self.assertEqual(s["t1"]["fable"]["judge_usd_med"], 0.11)   # median of the two judged fable runs
        self.assertEqual(s["t1"]["sonnet"]["judge_usd_med"], 0.08)  # its one judged run
        self.assertEqual(s["t1"]["fable"]["usd_med"], 4.5)          # judge $ is NOT folded into the arm's $
        self.assertIn("judge$", report.render(s))

    def test_unjudged_arm_has_no_judge_cost(self):
        rows = [{**r, "judge": None, "judge_usd": 0.0} for r in ROWS]
        self.assertIsNone(report.summarize(rows)["t1"]["fleet"]["judge_usd_med"])

    def test_mixed_provenance_warns_and_shows_columns(self):
        text = report.render(report.summarize(ROWS))
        self.assertNotIn("rows span", text)
        mixed = [dict(r) for r in ROWS]; mixed[0]["claude_version"] = "9.9.9"
        text = report.render(report.summarize(mixed))
        self.assertIn("rows span 2 claude versions / 1 profiles", text)
        self.assertIn("9.9.9", text)


class BenchCliTests(unittest.TestCase):
    def test_bench_cli_rejects_bad_arm(self):
        # activate_profile() has real global side effects (registry path, tmux session) that
        # must not leak into the rest of the suite - stub it out for this CLI-level test.
        with mock.patch("fleet.cli.activate_profile"), mock.patch("fleet.bench.run.run_many") as m:
            rc = cli.main(["bench", "run", "all", "--arms", "gpt"])
        self.assertEqual(rc, 1)
        m.assert_not_called()

    def test_bench_cli_rejects_unknown_task(self):
        with mock.patch("fleet.cli.activate_profile"), mock.patch("fleet.bench.run.run_many") as m:
            rc = cli.main(["bench", "run", "no-such-task"])
        self.assertEqual(rc, 1)
        m.assert_not_called()

    def test_bench_cli_accepts_a_real_task(self):
        with mock.patch("fleet.cli.activate_profile"), mock.patch("fleet.bench.run.run_many") as m:
            rc = cli.main(["bench", "run", "lookup-newest-handoff", "--arms", "sonnet"])
        self.assertEqual(rc, 0)
        m.assert_called_once()

    def test_bench_cli_rejects_bad_since(self):
        with mock.patch("fleet.cli.activate_profile"), mock.patch("fleet.bench.report.load") as m:
            rc = cli.main(["bench", "report", "--since", "not-a-date"])
        self.assertEqual(rc, 1)
        m.assert_not_called()


if __name__ == "__main__":
    unittest.main()
