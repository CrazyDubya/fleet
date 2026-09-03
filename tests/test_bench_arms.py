import subprocess
import tempfile
import unittest
from pathlib import Path

from fleet import send as send_mod
from fleet.bench import arms
from fleet.registry import Entry


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
            # keyed by thread: hooks/v2/_lib.sh derives this name from the transcript dir
            self.assertEqual(list(r.transcripts_by_thread), ["bench-work-run1"])
            self.assertEqual(r.threads, ["bench-work-run1"])

    def test_startup_refusal_is_skipped_not_error(self):
        # exit non-zero with NO stdout: the CLI rejected its own invocation before a
        # single turn, so the arm never attempted the task. Scored as `error` for three
        # days this read as sonnet failing 11 tasks (real cause: an inert Write() rule).
        def spawn(argv, **kw):
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="Write(...) is not matched")
        with tempfile.TemporaryDirectory() as d:
            r = arms.run_single_turn("claude-sonnet-5", "pkt", "run1", Path("/r"), 30, Path(d) / "w", spawn=spawn)
        self.assertEqual(r.status, "skipped")
        self.assertIn("exit 1", r.note)

    def test_nonzero_exit_after_output_is_still_an_error(self):
        # the arm DID run and produced a turn, so its failure is its own
        def spawn(argv, **kw):
            return subprocess.CompletedProcess(argv, 1, stdout="partial answer\n", stderr="boom")
        with tempfile.TemporaryDirectory() as d:
            r = arms.run_single_turn("claude-sonnet-5", "pkt", "run1", Path("/r"), 30, Path(d) / "w", spawn=spawn)
        self.assertEqual(r.status, "error")

    def test_run_single_turn_timeout(self):
        def spawn(argv, **kw):
            raise subprocess.TimeoutExpired(argv, kw["timeout"])
        with tempfile.TemporaryDirectory() as d:
            r = arms.run_single_turn("claude-sonnet-5", "pkt", "run1", Path("/r"), 1, Path(d) / "w", spawn=spawn)
        self.assertEqual(r.status, "timeout")


class SwarmTests(unittest.TestCase):
    """N workers race one task; the first CORRECT one wins, judged by the task's check."""

    class FakeProc:
        def __init__(self, out_dir=None, content="answer", rc=0, running=False):
            self.out_dir, self.content, self.rc = out_dir, content, rc
            self.running = running
            self.terminated = False
            self.returncode = None if running else rc
            if out_dir is not None:
                out_dir.mkdir(parents=True, exist_ok=True)
                (out_dir / "reply.txt").write_text(content)

        def poll(self):
            return None if self.running else self.rc

        def terminate(self):
            self.terminated = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, factory, n=3, timeout_s=5, check=None, shell_run=None):
        d = Path(self.tmp.name)
        tgt = str(d / "canonical")
        # the check must NAME the target, because _worker_correct re-points it at
        # each worker's dir by substituting that exact string
        check = check.format(target=tgt) if check else None
        made = []

        def popen(argv, cwd=None, **kw):
            pr = factory(len(made), Path(cwd))
            made.append(pr)
            return pr

        res = arms.run_swarm("claude-haiku-4-5", f"write to {tgt} please", "run1", Path("/r"),
                             timeout_s, d / "work", target=tgt, check=check, n=n, popen=popen,
                             sleep=lambda s: None, clock=iter([float(i) for i in range(500)]).__next__,
                             shell_run=shell_run or (lambda *a, **k: None))
        return res, made, Path(tgt)

    # --- worker isolation -------------------------------------------------
    def test_each_worker_gets_its_own_target_or_they_race_on_one_file(self):
        seen = []

        def popen(argv, cwd=None, **kw):
            seen.append(argv[-1])
            return self.FakeProc(rc=1)

        arms.run_swarm("m", "write to OUT please", "run1", Path("/r"), 1,
                       Path(self.tmp.name) / "work", target="OUT", n=3, popen=popen,
                       sleep=lambda s: None, clock=iter([0.0, 9.0]).__next__)
        self.assertEqual(len(set(seen)), 3, "workers must not share a target path")
        for i, pkt in enumerate(seen):
            self.assertIn(f"w{i}", pkt)

    def test_every_worker_transcript_is_measured_not_just_the_winner(self):
        # a swarm's cost is what ALL workers spent; that is the trade being priced
        res, _, _ = self._run(lambda i, cwd: self.FakeProc(cwd / "out" if i == 2 else None), n=4)
        self.assertEqual(sorted(res.transcripts_by_thread),
                         [f"bench-work-run1-w{i}" for i in range(4)])

    # --- selection --------------------------------------------------------
    def test_the_first_CORRECT_worker_wins_not_the_first_to_finish(self):
        """The measured flaw in first-to-finish: 2 of 4 live tasks came back `fail`
        because every worker produced an artifact and the quickest one was wrong."""
        def factory(i, cwd):
            return self.FakeProc(cwd / "out", content="WRONG" if i == 0 else "RIGHT")

        calls = []

        def shell_run(cmd, **kw):
            calls.append(cmd)
            wdir = cmd.split()[-1]
            ok = (Path(wdir) / "reply.txt").read_text() == "RIGHT"
            return type("R", (), {"returncode": 0 if ok else 1})()

        res, _, tgt = self._run(factory, n=3, check="verify {target}", shell_run=shell_run)
        self.assertEqual(res.status, "done")
        self.assertIn("passed the task check", res.note)
        self.assertEqual((tgt / "reply.txt").read_text(), "RIGHT")

    def test_when_no_worker_is_correct_the_run_records_a_fail_not_a_timeout(self):
        def shell_run(cmd, **kw):
            return type("R", (), {"returncode": 1})()

        res, _, tgt = self._run(lambda i, cwd: self.FakeProc(cwd / "out", content="WRONG"),
                                n=3, check="verify {target}", shell_run=shell_run)
        self.assertEqual(res.status, "done")           # an artifact exists ...
        self.assertIn("no worker", res.note)           # ... but none passed
        self.assertEqual((tgt / "reply.txt").read_text(), "WRONG")

    def test_a_still_running_worker_is_never_judged(self):
        # judging a half-written file would score a slow-but-correct worker as wrong
        judged = []

        def shell_run(cmd, **kw):
            judged.append(cmd)
            return type("R", (), {"returncode": 0})()

        self._run(lambda i, cwd: self.FakeProc(cwd / "out", running=(i != 1)),
                  n=3, check="verify {target}", shell_run=shell_run)
        self.assertEqual(len(judged), 1, "only the exited worker may be judged")

    def test_no_check_means_any_artifact_wins(self):
        res, _, _ = self._run(lambda i, cwd: self.FakeProc(cwd / "out" if i == 1 else None))
        self.assertEqual(res.status, "done")
        self.assertIn("w1", res.note)

    # --- lifecycle --------------------------------------------------------
    def test_losers_still_running_are_terminated(self):
        res, made, _ = self._run(
            lambda i, cwd: self.FakeProc(cwd / "out") if i == 0 else self.FakeProc(running=True))
        self.assertEqual(res.status, "done")
        # every still-running worker is reaped, the winner included: once the
        # artifact exists, more tokens buy nothing
        self.assertTrue(all(p.terminated for p in made if p.running))

    def test_all_workers_failing_to_start_is_skipped_not_a_failure(self):
        res, _, _ = self._run(lambda i, cwd: self.FakeProc(rc=1))
        self.assertEqual(res.status, "skipped")

    def test_workers_that_ran_and_produced_nothing_is_a_timeout(self):
        res, _, _ = self._run(lambda i, cwd: self.FakeProc(rc=0))
        self.assertEqual(res.status, "timeout")


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

    def test_handoff_in_the_repos_house_markdown_style_is_detected(self):
        """The exact line that cost 2 of the fleet arm's 9 bench timeouts.

        sonnet2 answered correctly and on time - the 09-03 handoff landed 2 min into a
        15 min window - but the detector folded whitespace only, so markdown bold left
        `**@re**1a066...` and the literal `@re<run>` never matched. The run was then
        scored as the fleet failing the task."""
        line = "- **@from** sonnet2 · **@re** 1a06611465c9bf6a · **status** done\n"
        with tempfile.TemporaryDirectory() as d:
            hd = Path(d); (hd / "h.md").write_text("# GUI widget build\n\n" + line)
            self.assertTrue(arms._handoff_done("1a06611465c9bf6a", 0.0, hd))
            # a different run's handoff must still not satisfy ours
            self.assertFalse(arms._handoff_done("1a0661f095f6df30", 0.0, hd))

    def test_bolded_reply_header_in_the_pane_is_detected(self):
        pane = ("⏺ **@from** sonnet2 · **@re** run77 · **status** done\n"
                "  the answer\n✻ Sauteed for 1s · done\n❯ \n")
        ok = arms.fleet_wait_done("run77", 0.0, 5, Path("/nonexistent"),
                                  capture=lambda: pane, sleep=lambda s: None,
                                  clock=iter([1.0, 2.0]).__next__)
        self.assertTrue(ok)

    def test_artifact_written_to_the_tasks_target_counts_as_done(self):
        """sonnet2 answered lookup-newest-handoff in 4 s by writing the file the packet
        asked for, then replying in prose with no @re header. The arm waited another
        176 s and recorded a timeout. The task states where its answer goes; nothing
        looked there."""
        with tempfile.TemporaryDirectory() as d:
            tgt = Path(d) / "out"; tgt.mkdir()
            self.assertFalse(arms._artifact_done(tgt, 0.0))          # empty dir
            (tgt / "reply.txt").write_text("")
            self.assertFalse(arms._artifact_done(tgt, 0.0))          # zero-byte: not yet
            (tgt / "reply.txt").write_text("ledger/handoffs/x.md")
            self.assertTrue(arms._artifact_done(tgt, 0.0))
            self.assertFalse(arms._artifact_done(None, 0.0))         # arm with no target
            self.assertFalse(arms._artifact_done(Path(d) / "nope", 0.0))

    def test_artifact_predating_the_run_does_not_count(self):
        import os
        with tempfile.TemporaryDirectory() as d:
            tgt = Path(d) / "out"; tgt.mkdir()
            f = tgt / "reply.txt"; f.write_text("stale"); os.utime(f, (1, 1))
            self.assertFalse(arms._artifact_done(tgt, 100.0))

    def test_wait_returns_on_artifact_without_any_reply_header(self):
        with tempfile.TemporaryDirectory() as d:
            tgt = Path(d) / "out"; tgt.mkdir(); (tgt / "reply.txt").write_text("answer")
            ok = arms.fleet_wait_done("run77", 0.0, 5, Path(d) / "handoffs",
                                      capture=lambda: "no header here at all",
                                      sleep=lambda s: None, clock=iter([1.0, 2.0]).__next__,
                                      target=tgt)
        self.assertTrue(ok)

    def test_old_handoff_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            hd = Path(d); f = hd / "old.md"; f.write_text("@re run77"); import os; os.utime(f, (1, 1))
            ok = arms.fleet_wait_done("run77", 100.0, 5, hd, capture=lambda: "", sleep=lambda s: None, clock=iter([101.0, 200.0]).__next__)
        self.assertFalse(ok)


def entry(name, cwd, session="s-" + "0" * 8, fork_of=None):
    return Entry(name=name, session_id=f"{session}-{name}", cwd=cwd, model="claude-sonnet-5", status="up",
                 spec_hash="h", spawned_at=0.0, fork_of=fork_of)


class RunFleetTests(unittest.TestCase):
    ENTRIES = {"sonnet2": entry("sonnet2", "/r/sonnet2"), "haiku2": entry("haiku2", "/r/haiku2")}

    def _run(self, send, **kw):
        # the availability guard is stubbed AVAILABLE by default: unstubbed it reads live
        # tmux and the live ledger, which made these three tests pass or fail on whatever
        # the fleet was doing at that second (they broke on 2026-09-03 for exactly that).
        with tempfile.TemporaryDirectory() as d:
            return arms.run_fleet("do it", ["maps/a.md"], "done when x", "run77", Path(d), 5, "lookup",
                                  "v2", self.ENTRIES, send=send, capture=kw.pop("capture", lambda: ""),
                                  sleep=lambda s: None, clock=kw.pop("clock", iter([0.0, 1.0, 9.0]).__next__),
                                  unavailable=kw.pop("unavailable", lambda entries, capture=None: ""))

    def test_unavailable_target_skips_without_sending(self):
        sent = []
        r = self._run(lambda p, profile: sent.append(p),
                      unavailable=lambda entries, capture=None: "busy with operator work")
        self.assertEqual(r.status, "skipped")
        self.assertIn("busy with operator work", r.note)
        self.assertEqual(sent, [])  # the whole point: no packet reaches a busy thread

    def test_packet_is_addressed_to_the_front_door_with_a_file_reply(self):
        sent = []
        def send(p, profile):
            sent.append((p, profile)); return "ok"
        pane = "❯ @to sonnet2 … @id run77\n⏺ @from sonnet2  @re run77  @status done  @out x.md\n  built\n✻ done\n❯ \n"
        r = self._run(send, capture=lambda: pane, clock=iter([0.0, 1.0]).__next__)
        p, profile = sent[0]
        self.assertEqual((p.to, p.reply, p.id, p.sender, p.lane), ("sonnet2", "file", "run77", "bench", "lookup"))
        self.assertEqual((p.refs, p.done, profile), (["maps/a.md"], "done when x", "v2"))
        self.assertEqual(r.status, "done")
        # every registered thread is a candidate window; the runner narrows it to those that spoke
        self.assertEqual(sorted(r.transcripts_by_thread), ["haiku2", "sonnet2"])

    def test_send_error_is_an_error_result_not_a_raise(self):
        def send(p, profile):
            raise send_mod.SendError("sonnet2 is not running")
        r = self._run(send)
        self.assertEqual(r.status, "error"); self.assertIn("not running", r.note)
        self.assertEqual(sorted(r.transcripts_by_thread), ["haiku2", "sonnet2"])  # still worth measuring

    def test_no_reply_within_timeout_is_a_timeout(self):
        r = self._run(lambda p, profile: "ok")
        self.assertEqual(r.status, "timeout"); self.assertIn("no @re reply", r.note)
