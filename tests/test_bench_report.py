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

    def test_render_has_a_row_per_arm_that_ran(self):
        text = report.render(report.summarize(ROWS))
        self.assertIn("s/pass", text)           # time leads: the metric the bench is for
        for arm in ("fable", "sonnet", "fleet"):
            self.assertIn(arm, text)
        self.assertIn("accuracy", text.lower())  # in the vs-baseline ratio line

    def test_judge_cost_is_reported_separately_from_usd(self):
        s = report.summarize(ROWS)
        self.assertEqual(s["t1"]["fable"]["judge_usd_med"], 0.11)   # median of the two judged fable runs
        self.assertEqual(s["t1"]["sonnet"]["judge_usd_med"], 0.08)  # its one judged run
        self.assertEqual(s["t1"]["fable"]["usd_med"], 4.5)          # judge $ is NOT folded into the arm's $
        self.assertIn("judge$", report.render(s))

    def test_judge_cost_counts_a_judge_whose_score_would_not_parse(self):
        # the score is None but the opus session still spent: keying off `judge` lost it
        rows = [dict(r) for r in ROWS]
        rows[4]["judge"], rows[5]["judge"] = None, None
        self.assertEqual(report.summarize(rows)["t1"]["fleet"]["judge_usd_med"], 0.1)  # median of 0.09 / 0.11

    def test_unjudged_arm_has_no_judge_cost(self):
        rows = [{**r, "judge": None, "judge_usd": 0.0} for r in ROWS]
        self.assertIsNone(report.summarize(rows)["t1"]["fleet"]["judge_usd_med"])

    def test_non_attempts_stay_out_of_the_pass_rate(self):
        # 11 real runs where `claude -p` exited at startup on an inert Write() rule were
        # scored as 11 sonnet failures, which is how the report claimed fleet/sonnet 3.00.
        # A run the arm never attempted must not be a failure by the arm.
        skips = [{**ROWS[0], "run": f"s{i}", "arm": "sonnet", "status": "skipped",
                  "wall_s": 1.1, "usd": 0.0, "measured": True} for i in range(11)]
        base = report.summarize(ROWS)["t1"]["sonnet"]["pass_rate"]
        a = report.summarize(ROWS + skips)["t1"]["sonnet"]
        self.assertEqual(a["pass_rate"], base)          # unchanged by 11 non-attempts
        self.assertEqual((a["n"], a["attempts"], a["skipped"]), (13, 2, 11))  # still visible in n

    def test_headline_n_is_the_pass_rates_own_denominator(self):
        skips = [{**ROWS[0], "run": f"s{i}", "arm": "sonnet", "status": "skipped"} for i in range(11)]
        h = report.summarize(ROWS + skips)["headline"]
        self.assertEqual((h["n"]["sonnet"], h["runs"]["sonnet"], h["skipped"]["sonnet"]), (2, 13, 11))
        st = report.stats_of(report.summarize(ROWS + skips), "sonnet")
        self.assertEqual((st["n"], st["skip"]), (2, 11))  # n is attempts, skips shown beside it

    def test_a_skipped_run_is_not_counted_as_an_error(self):
        skip = {**ROWS[0], "run": "s0", "arm": "sonnet", "status": "skipped"}
        a = report.summarize(ROWS + [skip])["t1"]["sonnet"]
        self.assertEqual((a["errors"], a["skipped"]), (0, 1))
        self.assertIn("skip", report.render(report.summarize(ROWS + [skip])))

    def test_cache_hit_write_and_miss_shares_sum_to_one(self):
        # cache_read/cache_write have been recorded per model since the first run and
        # were never reported; the bench's question is time and cache behaviour, not $.
        row = {**ROWS[0], "run": "c1", "arm": "sonnet", "status": "pass", "measured": True,
               "tokens": {"m1": {"input": 100, "cache_read": 700, "cache_write": 200, "output": 50}}}
        c = report.cache_by_model([row])["sonnet\tm1"]
        self.assertEqual((c["prompt"], c["runs"], c["output"]), (1000, 1, 50))
        self.assertAlmostEqual(c["hit"], 0.7); self.assertAlmostEqual(c["write_share"], 0.2)
        self.assertAlmostEqual(c["hit"] + c["write_share"] + c["miss_share"], 1.0)

    def test_cache_sums_across_runs_and_splits_by_model(self):
        mk = lambda i, m, cr: {**ROWS[0], "run": f"c{i}", "arm": "fleet", "status": "pass", "measured": True,
                               "tokens": {m: {"input": 0, "cache_read": cr, "cache_write": 100, "output": 1}}}
        c = report.cache_by_model([mk(1, "haiku", 900), mk(2, "haiku", 900), mk(3, "sonnet", 400)])
        self.assertEqual(c["fleet\thaiku"]["runs"], 2)
        self.assertEqual(c["fleet\thaiku"]["prompt"], 2000)
        self.assertAlmostEqual(c["fleet\tsonnet"]["hit"], 0.8)

    def test_cache_ignores_non_attempts_and_empty_models(self):
        skip = {**ROWS[0], "run": "s1", "arm": "sonnet", "status": "skipped", "measured": True,
                "tokens": {"<synthetic>": {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0}}}
        self.assertEqual(report.cache_by_model([skip]), {})

    def test_cache_key_is_not_walked_as_a_task(self):
        toks = {"claude-sonnet-5": {"input": 10, "cache_read": 800, "cache_write": 190, "output": 5}}
        rows = [{**r, "tokens": toks} for r in ROWS]
        s = report.summarize(rows)
        self.assertIn("cache", s)
        text = report.render(s)
        self.assertIn("cache by model", text)
        # the reserved key must not appear as a row in the per-task table above it
        self.assertNotIn("cache", text.split("\narm ")[0])

    def test_no_token_data_renders_no_cache_block(self):
        self.assertEqual(report.summarize(ROWS)["cache"], {})
        self.assertNotIn("cache by model", report.render(report.summarize(ROWS)))

    def test_unmeasured_rows_count_in_n_but_not_in_the_medians(self):
        ghost = {**ROWS[0], "run": "r7", "status": "error", "measured": False, "wall_s": 1.0, "usd": 99.0,
                 "judge": None, "judge_usd": 99.0, "pool": {"fable": 99.0, "other": 0.0, "weekly": {"haiku": 0, "opus": 0, "sonnet": 0}},
                 "interventions": {"block": 9, "decide": 0, "escalate": 0, "keypress": 0}}
        a = report.summarize(ROWS + [ghost])["t1"]["fable"]
        self.assertEqual((a["n"], a["errors"]), (3, 1))  # the run happened, so it is in n and in err
        self.assertEqual((a["usd_med"], a["fable_med"], a["judge_usd_med"]), (4.5, 4.5, 0.11))  # $0-by-accident excluded
        self.assertEqual(a["interventions_per_run"], 0.0)
        self.assertIn("err", report.render(report.summarize(ROWS + [ghost])))

    def test_rows_without_the_measured_key_are_taken_at_face_value(self):
        rows = [{k: v for k, v in r.items() if k != "measured"} for r in ROWS]
        self.assertEqual(report.summarize(rows)["t1"]["fable"]["usd_med"], 4.5)

    def test_an_unlabelled_row_mixed_with_labelled_ones_warns(self):
        rows = ROWS + [{k: v for k, v in ROWS[0].items() if k != "profile"} | {"run": "r7"}]
        text = report.render(report.summarize(rows))
        self.assertIn("rows span 1 claude versions / 2 profiles", text)
        self.assertIn("?", text)

    def test_task_column_widens_to_the_longest_id(self):
        long = "a-very-long-bench-task-id"
        text = report.render(report.summarize([{**r, "task": long} for r in ROWS]))
        head, first = text.splitlines()[0], text.splitlines()[1]
        self.assertTrue(head.startswith("task" + " " * (len(long) - 4)))
        self.assertEqual(first.split()[1], "fable")  # the arm column still lines up

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
