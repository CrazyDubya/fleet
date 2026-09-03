import itertools
import json
import os
import subprocess
import tempfile
import unittest
import unittest.mock
from datetime import datetime, timezone
from pathlib import Path

from fleet.bench import run as brun, tasks
from fleet.bench.arms import ArmResult
from fleet.paths import transcript_path


def task(**kw):
    base = dict(id="t1", lane="build", packet="build {target}", refs=[], target="bench/work/{run}/out", done="exists",
                check="test -d {target}", judge=None, timeout_s=10, cleanup="rm -rf {target}", expect=None)
    base.update(kw); return tasks.TaskSpec(**base)


def transcript(path: Path, ts: float, model: str = "claude-sonnet-5", out: int = 7) -> Path:
    """One assistant turn at `ts`, in the shape fleet.transcript.parse reads."""
    stamp = datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "assistant", "timestamp": stamp,
                                "message": {"id": f"m{ts}", "model": model, "usage": {"output_tokens": out}}}) + "\n")
    return path


class RunOneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name); self.runs = self.root / "runs.jsonl"
        self.seen = []

    def tearDown(self):
        self.tmp.cleanup()

    def run_one(self, *a, **kw):
        kw.setdefault("claude_version", "test")  # never shell out to `claude --version` in a unit test
        return brun.run_one(*a, **kw)

    def _exec(self, status="done", by_thread=None):
        """By default the arm produces one transcript with a turn at ts 1.5, so every test
        whose clock window covers 1.5 is a measured run; pass `by_thread={}` for none."""
        if by_thread is None:
            by_thread = {"bench-work-x": transcript(self.root / "tx" / "a.jsonl", 1.5)}

        def execute(resolved, run, arm):
            (self.root / resolved.target).mkdir(parents=True, exist_ok=True)
            self.seen.append(resolved)
            return ArmResult(status, dict(by_thread), stdout_path=None)
        return execute

    def test_pass_row(self):
        row = self.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([1.0, 5.5]).__next__)
        self.assertEqual((row["status"], row["check_rc"], row["arm"], row["task"]), ("pass", 0, "sonnet", "t1"))
        self.assertAlmostEqual(row["wall_s"], 4.5)
        self.assertEqual(sorted(row["pool"]), ["fable", "other", "weekly"])
        self.assertGreater(row["pool"]["weekly"]["sonnet"], 0)  # the arm's one turn was priced
        self.assertIsNone(row["judge"]); self.assertEqual(json.loads(self.runs.read_text())["run"], row["run"])
        self.assertFalse((self.root / "bench/work" / row["run"] / "out").exists())  # cleanup ran

    def test_fail_row_when_check_fails(self):
        row = self.run_one(task(check="test -f {target}/missing"), "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["check_rc"]), ("fail", 1))

    def test_timeout_row_skips_check(self):
        row = self.run_one(task(), "fleet", self.root, self.runs, execute=self._exec("timeout"), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["check_rc"]), ("timeout", None))

    def test_timeout_cleanup_calls_fleet_miss(self):
        # `abandoned-<run>` is the only reason cmd_miss matches to clear pending state.
        calls = []
        real_run = subprocess.run

        def fake_run(args, *a, **kw):
            calls.append(args)
            return real_run(args, *a, **kw)

        with unittest.mock.patch("fleet.bench.run.subprocess.run", side_effect=fake_run):
            row = self.run_one(task(), "fleet", self.root, self.runs, execute=self._exec("timeout"), events=[],
                               clock=iter([1.0, 2.0]).__next__)
        expected = [str(self.root / "bin" / "fleet"), "miss", "sonnet2", f"abandoned-{row['run']}"]
        self.assertIn(expected, calls)
        # bin/fleet does not exist under the tmp root: the failure is recorded, the status stands
        self.assertEqual(row["status"], "timeout"); self.assertIn("fleet miss", row["error"])

    def test_judge_only_on_pass_with_rubric(self):
        calls = []
        def judge_fn(rubric, done, artifacts, run, root):
            calls.append(rubric); return 4, "ledger/handoffs/judge/x.md", 0.07, "claude-opus-5"
        row = self.run_one(task(judge="bench/rubrics/w.md"), "fable", self.root, self.runs, execute=self._exec(), events=[], judge_fn=judge_fn, clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["judge"], row["judge_path"], calls), (4, "ledger/handoffs/judge/x.md", ["bench/rubrics/w.md"]))
        self.assertEqual((row["judge_usd"], row["judge_model"]), (0.07, "claude-opus-5"))
        row = self.run_one(task(judge="bench/rubrics/w.md", check="false"), "fable", self.root, self.runs, execute=self._exec(), events=[], judge_fn=judge_fn, clock=iter([1.0, 2.0]).__next__)
        self.assertIsNone(row["judge"]); self.assertEqual(len(calls), 1)

    def test_provenance_fields(self):
        row = self.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertTrue(row["profile"]); self.assertEqual(row["claude_version"], "test"); self.assertTrue(row["measured"])

    def test_claude_version_comes_from_the_caller_not_a_probe(self):
        with unittest.mock.patch("fleet.bench.run.detect_claude_version", side_effect=AssertionError("probed")) as det:
            row = self.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[],
                               clock=iter([1.0, 2.0]).__next__, claude_version="1.2.3")
        self.assertEqual(row["claude_version"], "1.2.3"); det.assert_not_called()

    def test_interventions_are_scoped_to_threads_that_spoke_in_the_window(self):
        active = transcript(self.root / "tx" / "active.jsonl", 1.5)
        idle = transcript(self.root / "tx" / "idle.jsonl", 50.0)  # a turn, but outside [t0, t1)
        ev = [{"ev": "keypress", "t": 1.5, "thread": "spoke"}, {"ev": "keypress", "t": 1.5, "thread": "silent"},
              {"ev": "keypress", "t": 1.5, "thread": "opus"}]
        row = self.run_one(task(), "sonnet", self.root, self.runs, events=ev, clock=iter([1.0, 2.0]).__next__,
                           execute=self._exec(by_thread={"spoke": active, "silent": idle}))
        self.assertEqual(row["interventions"]["keypress"], 1)

    def test_missing_ref_is_an_error_row_and_skips_execution(self):
        row = self.run_one(task(refs=["maps/gone.md"]), "sonnet", self.root, self.runs, execute=self._exec(), events=[],
                           clock=iter([1.0, 3.0]).__next__)
        self.assertEqual((row["status"], row["measured"], self.seen), ("error", False, []))
        self.assertIn("missing ref: maps/gone.md", row["error"])
        self.assertEqual((row["t1"], row["wall_s"]), (3.0, 2.0))  # an error row still says how long it took

    def test_expect_is_substituted_into_check_before_execution(self):
        t = task(expect="printf 'ledger/handoffs/a.md'", check="test \"{expect}\" = ledger/handoffs/a.md")
        row = self.run_one(t, "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["check_rc"]), ("pass", 0))

    def test_expect_failure_is_an_error_row(self):
        row = self.run_one(task(expect="exit 3"), "sonnet", self.root, self.runs, execute=self._exec(), events=[],
                           clock=iter([1.0, 4.0]).__next__)
        self.assertEqual((row["status"], self.seen), ("error", []))
        self.assertIn("expect: exit 3", row["error"])
        self.assertEqual((row["t1"], row["wall_s"]), (4.0, 3.0))

    def test_done_single_turn_arm_with_no_turns_is_flagged_unmeasured(self):
        row = self.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(by_thread={}), events=[],
                           clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["measured"]), ("pass", False))
        self.assertIn("no transcript turns in window", row["error"])

    def test_judge_failure_degrades_but_keeps_the_run(self):
        def judge_fn(*a):
            raise subprocess.TimeoutExpired("claude", 600)
        row = self.run_one(task(judge="bench/rubrics/w.md"), "fable", self.root, self.runs, execute=self._exec(), events=[],
                           judge_fn=judge_fn, clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["judge"], row["judge_path"]), ("pass", None, None))
        self.assertTrue(row["measured"]); self.assertIn("judge:", row["error"])

    def test_check_timeout_is_a_fail_not_a_pass(self):
        def check_run(*a, **kw):
            raise subprocess.TimeoutExpired("check", 120)
        row = self.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[], check_run=check_run,
                           clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["check_rc"]), ("fail", None))
        self.assertIn("check timed out", row["error"])

    def test_measurement_failure_downgrades_status_to_error(self):
        with unittest.mock.patch("fleet.bench.run.measure.tokens_by_model", side_effect=RuntimeError("no transcript")):
            row = self.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["measured"]), ("error", False))
        self.assertEqual(row["usd"], 0.0); self.assertIn("no transcript", row["error"])

    def test_bad_run_id_raises(self):
        with unittest.mock.patch("fleet.bench.run.packet_mod.new_id", return_value="not-hex"):
            with self.assertRaises(ValueError):
                self.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[])

    def test_error_row_on_exception(self):
        def execute(resolved, run, arm):
            raise RuntimeError("boom")
        row = self.run_one(task(), "sonnet", self.root, self.runs, execute=execute, events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual(row["status"], "error"); self.assertIn("boom", row["error"])


class JudgeTests(unittest.TestCase):
    def test_parse_score_last_line(self):
        self.assertEqual(brun._parse_score("blah\nscore: 4\n3\n"), 3)
        self.assertIsNone(brun._parse_score("no number here"))

    def test_judge_is_hooked_sessioned_and_priced(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "bench" / "rubrics").mkdir(parents=True); (root / "bench" / "rubrics" / "w.md").write_text("score it")
            calls = []
            def spawn(argv, **kw):
                calls.append((argv, kw)); return subprocess.CompletedProcess(argv, 0, stdout="reasons\n4\n", stderr="")
            with unittest.mock.patch("fleet.bench.run.measure.usd_by_model", return_value={"claude-opus-5": 0.25}) as usd:
                score, path, cost, model = brun.judge("bench/rubrics/w.md", "done", ["a"], "f" * 16, root, spawn=spawn,
                                                      clock=iter([1.0, 2.0]).__next__)
            argv, kw = calls[0]
            self.assertEqual(argv[argv.index("--settings") + 1], str(root / "settings" / "v2" / "hot.json"))
            self.assertEqual(argv[argv.index("--model") + 1], brun.JUDGE_MODEL)
            self.assertEqual(len(argv[argv.index("--session-id") + 1]), 36)  # a uuid, so the spend is findable
            # cwd under bench/work/<run> so hooks/v2/_lib.sh derives THREAD bench-work-<run>-judge
            workdir = root / "bench" / "work" / ("f" * 16) / "judge"
            self.assertEqual(kw["cwd"], str(workdir)); self.assertTrue(workdir.is_dir())
            sid = argv[argv.index("--session-id") + 1]
            self.assertEqual(usd.call_args[0][0], [transcript_path(workdir, sid)])  # priced from that cwd's transcript
        self.assertEqual((score, cost, model), (4, 0.25, "claude-opus-5"))
        self.assertIsNone(path)  # the judge never wrote its handoff


class EnsureGuiTests(unittest.TestCase):
    class FakePopen:
        def __init__(self, rc=None):
            self.rc = rc; self.calls = []
        def poll(self):
            return self.rc
        def terminate(self):
            self.calls.append("terminate")
        def wait(self, timeout=None):
            self.calls.append(("wait", timeout))

    def test_a_listening_port_is_left_alone(self):
        def popen(*a, **kw):
            raise AssertionError("must not start a second server")
        stop = brun.ensure_gui(Path("/r"), probe=lambda port: True, popen=popen)
        stop()  # a no-op stopper: the bench did not start it, so it must not stop it

    def test_polls_the_port_then_terminates_on_stop(self):
        proc = self.FakePopen(); slept = []
        probe = iter([False, False, True]).__next__
        stop = brun.ensure_gui(Path("/r"), popen=lambda *a, **kw: proc, probe=lambda port: probe(),
                               clock=itertools.count(0.0, 1.0).__next__, sleep=slept.append)
        self.assertEqual(len(slept), 1)  # polled, not slept for a fixed 2 s
        stop()
        self.assertEqual(proc.calls, ["terminate", ("wait", 5)])

    def test_a_server_that_dies_during_startup_raises(self):
        proc = self.FakePopen(rc=1)
        with self.assertRaises(RuntimeError):
            brun.ensure_gui(Path("/r"), popen=lambda *a, **kw: proc, probe=lambda port: False,
                            clock=itertools.count(0.0, 1.0).__next__, sleep=lambda s: None)


class SweepTests(unittest.TestCase):
    def test_sweep_removes_leftovers_but_not_the_real_widget(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            leftover = root / "gui" / "widgets" / ("bench" + "a" * 16); leftover.mkdir(parents=True)
            widget = root / "gui" / "widgets" / "bench"; widget.mkdir()
            other = root / "gui" / "widgets" / "workspace"; other.mkdir()
            old = root / "bench" / "work" / "old"; old.mkdir(parents=True); os.utime(old, (0, 0))
            fresh = root / "bench" / "work" / "fresh"; fresh.mkdir()
            removed = brun.sweep(root)
            self.assertEqual(sorted(removed), sorted([str(leftover.relative_to(root)), str(old.relative_to(root))]))
            self.assertFalse(leftover.exists()); self.assertFalse(old.exists())
            self.assertTrue(widget.is_dir() and other.is_dir() and fresh.is_dir())

    def test_sweep_of_a_bare_root_is_quiet(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(brun.sweep(Path(d)), [])


if __name__ == "__main__":
    unittest.main()


# Verbatim `tmux capture-pane -e -p` output from the running v2 profile,
# 2026-09-03, SGR codes included. Real TUI frames, not hand-drawn: telling a
# draft from a suggestion is the guard's whole job and it lives in these codes.
PANE_IDLE = (
    "\x1b[38;5;244m\u2500\u2500 haiku-fs2 \u2500\n"
    "\x1b[39m\u276f \n"
    "\u2500\u2500\u2500\n"
)
# A real unsent draft: undimmed. Produced live by pasting without Enter.
PANE_DRAFT = (
    "\x1b[38;5;244m\u2500\u2500 haiku-fs2 \u2500\n"
    "\x1b[39m\u276f REAL DRAFT HERE\n"
    "\u2500\u2500\u2500\n"
)
# Claude Code's dim SUGGESTED next prompt. Renders identically to a draft once
# the escape codes are stripped, which is why the plain capture was misleading:
# it is not in any buffer, no keystroke clears it, and sending is perfectly safe.
PANE_SUGGESTION = (
    "\x1b[38;5;244m\u2500\u2500 sonnet2 \u2500\n"
    "\x1b[39m\u276f \x1b[2mcheck for more bench packets\x1b[0m\n"
    "\u2500\u2500\u2500\n"
)


def test_input_box_distinguishes_draft_from_suggestion():
    from fleet import tmux

    assert tmux.parse_input_box(PANE_IDLE) == ""
    assert tmux.parse_input_box(PANE_DRAFT) == "REAL DRAFT HERE"
    # The regression that cost opus2 a respawn: a dim suggestion is NOT a draft.
    assert tmux.parse_input_box(PANE_SUGGESTION) == ""
    # No input box at all (permission dialog, non-TUI pane) is a third state.
    assert tmux.parse_input_box("$ ls\nfoo bar\n$ ") is None


def test_fleet_arm_skips_when_target_busy():
    """The fleet arm drives the LIVE thread. If the operator has work in flight,
    the arm must skip rather than commandeer it - observed twice in production
    (2026-09-01 and 09-02 3AM runs), both interrupting a pinball-lab experiment."""
    from fleet.bench import arms

    class R:
        def __init__(self, name, state): self.name, self.state = name, state

    import fleet.status as status_mod
    orig = status_mod.rows
    try:
        status_mod.rows = lambda **kw: [R("sonnet2", "busy"), R("opus2", "idle")]
        assert "busy" in arms._target_unavailable({}, capture=lambda: PANE_IDLE)
        status_mod.rows = lambda **kw: [R("sonnet2", "idle")]
        assert arms._target_unavailable({}, capture=lambda: PANE_IDLE) == ""
        # a broken probe must degrade to "available", never silently disable the arm
        def boom(**kw): raise RuntimeError("registry unreadable")
        status_mod.rows = boom
        assert arms._target_unavailable({}, capture=lambda: PANE_DRAFT) == ""
    finally:
        status_mod.rows = orig


def test_fleet_arm_skips_when_target_is_wedged_not_busy():
    """A thread holding a real unsent draft has no open turn, so the transcript
    reports it IDLE - and a paste would concatenate onto that draft."""
    from fleet.bench import arms

    class R:
        def __init__(self, name, state): self.name, self.state = name, state

    import fleet.status as status_mod
    orig = status_mod.rows
    try:
        status_mod.rows = lambda **kw: [R("sonnet2", "idle")]
        why = arms._target_unavailable({}, capture=lambda: PANE_DRAFT)
        assert "wedged" in why and "REAL DRAFT HERE" in why, why
        # a dim suggestion must NOT skip the arm - the thread is healthy
        assert arms._target_unavailable({}, capture=lambda: PANE_SUGGESTION) == ""
        # a dialog on screen leaves no input box; pasting then goes into the dialog
        assert "no input box" in arms._target_unavailable({}, capture=lambda: "$ ls\n$ ")
        # a capture that fails or comes back empty degrades to available
        def blow(): raise RuntimeError("no such window")
        assert arms._target_unavailable({}, capture=blow) == ""
        assert arms._target_unavailable({}, capture=lambda: "  \n") == ""
    finally:
        status_mod.rows = orig


def test_fleet_arm_records_skip_without_sending():
    from fleet.bench import arms
    sent = []
    orig = arms._target_unavailable
    try:
        arms._target_unavailable = lambda entries, capture=None: "wedged: unsubmitted text in the prompt"
        res = arms.run_fleet("body", [], "done", "run1", __import__("pathlib").Path("."), 5,
                             "build", "v2", {}, send=lambda p, prof: sent.append(p))
        assert res.status == "skipped"
        assert sent == [], "a skipped arm must not send a packet to the live thread"
    finally:
        arms._target_unavailable = orig


def _clock_stub(t):
    class S:
        def stat(self_inner): return type("St", (), {"st_mtime": t})()
    return S()


def test_dispatch_in_flight_blocks_the_arm_when_the_operator_owns_the_thread():
    """`state == idle` is not enough. A thread pauses between the steps of a long
    dispatch - on a permission dialog, or just between turns - and reads as idle
    while the operator still owns it. That is how the 03:00 and 03:15 runs on
    2026-09-03 sent into sonnet2 mid-LAB-18, burned $1.75 and $0.31 on 900s
    timeouts, and pulled it onto bench work mid-experiment."""
    import time
    from fleet.bench import arms
    now = time.time()

    owned = arms._dispatch_in_flight(
        events=[{"ev": "send", "thread": arms.FLEET_TARGET, "from": "operator", "t": now}],
        handoff=_clock_stub(now - 600))
    assert "in flight" in owned, owned

    free = arms._dispatch_in_flight(
        events=[{"ev": "send", "thread": arms.FLEET_TARGET, "from": "operator", "t": now - 600}],
        handoff=_clock_stub(now))
    assert free == "", free


def test_the_benchs_own_send_does_not_count_as_operator_ownership():
    # Otherwise the arm would permanently block itself after its first packet.
    import time
    from fleet.bench import arms
    now = time.time()
    assert arms._dispatch_in_flight(
        events=[{"ev": "send", "thread": arms.FLEET_TARGET, "from": "bench", "t": now}],
        handoff=_clock_stub(now - 600)) == ""


def test_dispatch_probe_fails_open():
    from fleet.bench import arms
    assert arms._dispatch_in_flight(events=[], handoff=None) == ""
    class Boom:
        def stat(self): raise OSError("unreadable")
    assert arms._dispatch_in_flight(events=[{"ev": "send", "thread": arms.FLEET_TARGET,
                                             "from": "operator", "t": 1}], handoff=Boom()) == ""
