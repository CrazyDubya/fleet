import subprocess
import tempfile
import unittest
from pathlib import Path

from fleet.bench import arms


class SingleTurnTests(unittest.TestCase):
    def test_argv_shape(self):
        a = arms.single_turn_argv("claude-sonnet-5", "sid-1", "do it", Path("/r"))
        self.assertEqual(a[:2], ["claude", "-p"])
        for flag, val in (("--model", "claude-sonnet-5"), ("--session-id", "sid-1"), ("--permission-mode", "acceptEdits"),
                          ("--add-dir", "/r"), ("--settings", "/r/settings/v2/hot.json")):
            self.assertEqual(a[a.index(flag) + 1], val)
        self.assertIn("--strict-mcp-config", a); self.assertEqual(a[-1], "do it")

    def test_run_single_turn_records_transcript_and_stdout(self):
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d) / "w"
            calls = []
            def spawn(argv, **kw):
                calls.append((argv, kw)); return subprocess.CompletedProcess(argv, 0, stdout="hello\n", stderr="")
            r = arms.run_single_turn("claude-sonnet-5", "pkt", "run1", Path("/r"), 30, wd, spawn=spawn)
            self.assertEqual(r.status, "done")
            self.assertEqual((wd / "stdout.txt").read_text(), "hello\n")
            self.assertEqual(calls[0][1]["cwd"], str(wd)); self.assertEqual(calls[0][1]["timeout"], 30)
            self.assertTrue(str(r.transcripts[0]).endswith(".jsonl"))
            self.assertEqual(r.threads, ["bench-work-run1"])  # hooks/v2/_lib.sh derives this from the transcript dir

    def test_run_single_turn_timeout(self):
        def spawn(argv, **kw):
            raise subprocess.TimeoutExpired(argv, kw["timeout"])
        with tempfile.TemporaryDirectory() as d:
            r = arms.run_single_turn("claude-sonnet-5", "pkt", "run1", Path("/r"), 1, Path(d) / "w", spawn=spawn)
        self.assertEqual(r.status, "timeout")


class FleetWaitTests(unittest.TestCase):
    def test_done_by_handoff_file(self):
        with tempfile.TemporaryDirectory() as d:
            hd = Path(d); (hd / "20260829T150000Z-x.md").write_text("@from sonnet2  @re run77  @status done\nok")
            ok = arms.fleet_wait_done("run77", 0.0, 10, hd, capture=lambda: "", sleep=lambda s: None, clock=iter([1.0, 2.0]).__next__)
        self.assertTrue(ok)

    def test_done_by_pane(self):
        pane = "❯ @to sonnet2 … @id run77\n⏺ @from sonnet2  @re run77  @status done  @out x.md\n  built\n✻ done\n❯ \n"
        with tempfile.TemporaryDirectory() as d:
            ok = arms.fleet_wait_done("run77", 0.0, 10, Path(d), capture=lambda: pane, sleep=lambda s: None, clock=iter([1.0]).__next__)
        self.assertTrue(ok)

    def test_timeout(self):
        with tempfile.TemporaryDirectory() as d:
            ok = arms.fleet_wait_done("run77", 0.0, 5, Path(d), capture=lambda: "", sleep=lambda s: None, clock=iter([1.0, 3.0, 6.0]).__next__)
        self.assertFalse(ok)

    def test_poll_is_one_second_so_t1_is_not_quantised(self):
        slept = []
        with tempfile.TemporaryDirectory() as d:
            arms.fleet_wait_done("run77", 0.0, 5, Path(d), capture=lambda: "", sleep=slept.append, clock=iter([1.0, 6.0]).__next__)
        self.assertEqual(slept, [1])

    def test_old_handoff_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            hd = Path(d); f = hd / "old.md"; f.write_text("@re run77"); import os; os.utime(f, (1, 1))
            ok = arms.fleet_wait_done("run77", 100.0, 5, hd, capture=lambda: "", sleep=lambda s: None, clock=iter([101.0, 200.0]).__next__)
        self.assertFalse(ok)
