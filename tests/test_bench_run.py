import json
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from fleet.bench import run as brun, tasks
from fleet.bench.arms import ArmResult


def task(**kw):
    base = dict(id="t1", lane="build", packet="build {target}", refs=[], target="bench/work/{run}/out", done="exists",
                check="test -d {target}", judge=None, timeout_s=10, cleanup="rm -rf {target}", expect=None)
    base.update(kw); return tasks.TaskSpec(**base)


class RunOneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name); self.runs = self.root / "runs.jsonl"
        self.seen = []

    def tearDown(self):
        self.tmp.cleanup()

    def _exec(self, status="done", threads=()):
        def execute(resolved, run, arm):
            (self.root / resolved.target).mkdir(parents=True, exist_ok=True)
            self.seen.append(resolved)
            return ArmResult(status, transcripts=[], stdout_path=None, threads=list(threads))
        return execute

    def test_pass_row(self):
        row = brun.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([100.0, 104.5]).__next__)
        self.assertEqual((row["status"], row["check_rc"], row["arm"], row["task"]), ("pass", 0, "sonnet", "t1"))
        self.assertAlmostEqual(row["wall_s"], 4.5)
        self.assertEqual(row["pool"]["weekly"], {"opus": 0.0, "sonnet": 0.0, "haiku": 0.0})
        self.assertIsNone(row["judge"]); self.assertEqual(json.loads(self.runs.read_text())["run"], row["run"])
        self.assertFalse((self.root / "bench/work" / row["run"] / "out").exists())  # cleanup ran

    def test_fail_row_when_check_fails(self):
        row = brun.run_one(task(check="test -f {target}/missing"), "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["check_rc"]), ("fail", 1))

    def test_timeout_row_skips_check(self):
        row = brun.run_one(task(), "fleet", self.root, self.runs, execute=self._exec("timeout"), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["check_rc"]), ("timeout", None))

    def test_timeout_cleanup_calls_fleet_miss(self):
        # `abandoned-<run>` is the only reason cmd_miss matches to clear pending state.
        calls = []
        real_run = subprocess.run

        def fake_run(args, *a, **kw):
            calls.append(args)
            return real_run(args, *a, **kw)

        with unittest.mock.patch("fleet.bench.run.subprocess.run", side_effect=fake_run):
            row = brun.run_one(task(), "fleet", self.root, self.runs, execute=self._exec("timeout"), events=[],
                                clock=iter([1.0, 2.0]).__next__)
        expected = [str(self.root / "bin" / "fleet"), "miss", "sonnet2", f"abandoned-{row['run']}"]
        self.assertIn(expected, calls)
        # bin/fleet does not exist under the tmp root: the failure is recorded, the status stands
        self.assertEqual(row["status"], "timeout"); self.assertIn("fleet miss", row["error"])

    def test_judge_only_on_pass_with_rubric(self):
        calls = []
        def judge_fn(rubric, done, artifacts, run, root):
            calls.append(rubric); return 4, "ledger/handoffs/judge/x.md", 0.07, "claude-opus-5"
        row = brun.run_one(task(judge="bench/rubrics/w.md"), "fable", self.root, self.runs, execute=self._exec(), events=[], judge_fn=judge_fn, clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["judge"], row["judge_path"], calls), (4, "ledger/handoffs/judge/x.md", ["bench/rubrics/w.md"]))
        self.assertEqual((row["judge_usd"], row["judge_model"]), (0.07, "claude-opus-5"))
        row = brun.run_one(task(judge="bench/rubrics/w.md", check="false"), "fable", self.root, self.runs, execute=self._exec(), events=[], judge_fn=judge_fn, clock=iter([1.0, 2.0]).__next__)
        self.assertIsNone(row["judge"]); self.assertEqual(len(calls), 1)

    def test_provenance_fields(self):
        row = brun.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertTrue(row["profile"]); self.assertTrue(row["claude_version"]); self.assertTrue(row["measured"])

    def test_interventions_only_count_this_run_threads(self):
        ev = [{"ev": "keypress", "t": 1.5, "thread": "bench-work-x"}, {"ev": "keypress", "t": 1.5, "thread": "opus"}]
        row = brun.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(threads=["bench-work-x"]), events=ev,
                           clock=iter([1.0, 2.0]).__next__)
        self.assertEqual(row["interventions"]["keypress"], 1)

    def test_missing_ref_is_an_error_row_and_skips_execution(self):
        row = brun.run_one(task(refs=["maps/gone.md"]), "sonnet", self.root, self.runs, execute=self._exec(), events=[],
                           clock=iter([1.0]).__next__)
        self.assertEqual((row["status"], row["measured"], self.seen), ("error", False, []))
        self.assertIn("missing ref: maps/gone.md", row["error"])

    def test_expect_is_substituted_into_check_before_execution(self):
        t = task(expect="printf 'ledger/handoffs/a.md'", check="test \"{expect}\" = ledger/handoffs/a.md")
        row = brun.run_one(t, "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["check_rc"]), ("pass", 0))

    def test_expect_failure_is_an_error_row(self):
        row = brun.run_one(task(expect="exit 3"), "sonnet", self.root, self.runs, execute=self._exec(), events=[],
                           clock=iter([1.0]).__next__)
        self.assertEqual((row["status"], self.seen), ("error", []))
        self.assertIn("expect: exit 3", row["error"])

    def test_judge_failure_degrades_but_keeps_the_run(self):
        def judge_fn(*a):
            raise subprocess.TimeoutExpired("claude", 600)
        row = brun.run_one(task(judge="bench/rubrics/w.md"), "fable", self.root, self.runs, execute=self._exec(), events=[],
                           judge_fn=judge_fn, clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["judge"], row["judge_path"]), ("pass", None, None))
        self.assertTrue(row["measured"]); self.assertIn("judge:", row["error"])

    def test_check_timeout_is_a_fail_not_a_pass(self):
        def check_run(*a, **kw):
            raise subprocess.TimeoutExpired("check", 120)
        row = brun.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[], check_run=check_run,
                           clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["check_rc"]), ("fail", None))
        self.assertIn("check timed out", row["error"])

    def test_measurement_failure_downgrades_status_to_error(self):
        with unittest.mock.patch("fleet.bench.run.measure.tokens_by_model", side_effect=RuntimeError("no transcript")):
            row = brun.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["measured"]), ("error", False))
        self.assertEqual(row["usd"], 0.0); self.assertIn("no transcript", row["error"])

    def test_bad_run_id_raises(self):
        with unittest.mock.patch("fleet.bench.run.packet_mod.new_id", return_value="not-hex"):
            with self.assertRaises(ValueError):
                brun.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[])

    def test_error_row_on_exception(self):
        def execute(resolved, run, arm):
            raise RuntimeError("boom")
        row = brun.run_one(task(), "sonnet", self.root, self.runs, execute=execute, events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual(row["status"], "error"); self.assertIn("boom", row["error"])


class JudgeParseTests(unittest.TestCase):
    def test_parse_score_last_line(self):
        self.assertEqual(brun._parse_score("blah\nscore: 4\n3\n"), 3)
        self.assertIsNone(brun._parse_score("no number here"))

    def test_judge_is_hooked_sessioned_and_priced(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "bench" / "rubrics").mkdir(parents=True); (root / "bench" / "rubrics" / "w.md").write_text("score it")
            calls = []
            def spawn(argv, **kw):
                calls.append(argv); return subprocess.CompletedProcess(argv, 0, stdout="reasons\n4\n", stderr="")
            with unittest.mock.patch("fleet.bench.run.measure.usd_by_model", return_value={"claude-opus-5": 0.25}):
                score, path, usd, model = brun.judge("bench/rubrics/w.md", "done", ["a"], "f" * 16, root, spawn=spawn,
                                                     clock=iter([1.0, 2.0]).__next__)
        argv = calls[0]
        self.assertEqual(argv[argv.index("--settings") + 1], str(root / "settings" / "v2" / "hot.json"))
        self.assertEqual(argv[argv.index("--model") + 1], brun.JUDGE_MODEL)
        self.assertEqual(len(argv[argv.index("--session-id") + 1]), 36)  # a uuid, so the spend is findable
        self.assertEqual((score, usd, model), (4, 0.25, "claude-opus-5"))
        self.assertIsNone(path)  # the judge never wrote its handoff


if __name__ == "__main__":
    unittest.main()
