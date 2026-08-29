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
                check="test -d {target}", judge=None, timeout_s=10, cleanup="rm -rf {target}")
    base.update(kw); return tasks.TaskSpec(**base)


class RunOneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name); self.runs = self.root / "runs.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def _exec(self, status="done"):
        def execute(resolved, run, arm):
            (self.root / resolved.target).mkdir(parents=True, exist_ok=True)
            return ArmResult(status, transcripts=[], stdout_path=None)
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
        calls = []
        real_run = subprocess.run

        def fake_run(args, *a, **kw):
            calls.append(args)
            return real_run(args, *a, **kw)

        with unittest.mock.patch("fleet.bench.run.subprocess.run", side_effect=fake_run):
            row = brun.run_one(task(), "fleet", self.root, self.runs, execute=self._exec("timeout"), events=[],
                                clock=iter([1.0, 2.0]).__next__)
        expected = [str(self.root / "bin" / "fleet"), "miss", "sonnet2", f"bench-timeout-{row['run']}"]
        self.assertIn(expected, calls)

    def test_judge_only_on_pass_with_rubric(self):
        calls = []
        def judge_fn(rubric, done, artifacts, run, root):
            calls.append(rubric); return 4, "ledger/handoffs/judge/x.md"
        row = brun.run_one(task(judge="bench/rubrics/w.md"), "fable", self.root, self.runs, execute=self._exec(), events=[], judge_fn=judge_fn, clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["judge"], row["judge_path"], calls), (4, "ledger/handoffs/judge/x.md", ["bench/rubrics/w.md"]))
        row = brun.run_one(task(judge="bench/rubrics/w.md", check="false"), "fable", self.root, self.runs, execute=self._exec(), events=[], judge_fn=judge_fn, clock=iter([1.0, 2.0]).__next__)
        self.assertIsNone(row["judge"]); self.assertEqual(len(calls), 1)

    def test_error_row_on_exception(self):
        def execute(resolved, run, arm):
            raise RuntimeError("boom")
        row = brun.run_one(task(), "sonnet", self.root, self.runs, execute=execute, events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual(row["status"], "error"); self.assertIn("boom", row["error"])


class JudgeParseTests(unittest.TestCase):
    def test_parse_score_last_line(self):
        self.assertEqual(brun._parse_score("blah\nscore: 4\n3\n"), 3)
        self.assertIsNone(brun._parse_score("no number here"))


if __name__ == "__main__":
    unittest.main()
