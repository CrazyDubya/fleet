import tempfile
import time
import unittest
from pathlib import Path

from fleet import agents, projects


def proj(d, **kw):
    body = dict(name="p", dir=str(d), status_glob="pipeline/status-*.md",
                state_re=r"state:\s*\*\*(\w+)\*\*")
    body.update(kw)
    return projects.Project(**body)


def status(d: Path, name: str, state: str, age_s: float = 0.0):
    p = d / "pipeline"
    p.mkdir(parents=True, exist_ok=True)
    f = p / name
    f.write_text(f"# daily status\n\n- state: **{state}**\n- pending: 3\n")
    if age_s:
        import os
        t = time.time() - age_s
        os.utime(f, (t, t))
    return f


NO_ACTIVITY_STATE_RE = r'state:\s*\*\*([A-Z][A-Z ]*[A-Z]|[A-Z])\*\*'  # fleet.toml's real muse regex


def no_activity_status(d: Path, name: str, *, lock="inactive", pending=0, running=0,
                        backlog_pressure=False, state="NO ACTIVITY", heartbeat="idle"):
    """A status file shaped like muse's real generator output (harness/
    analyze.py), with the fields _classify_no_activity actually reads."""
    p = d / "pipeline"
    p.mkdir(parents=True, exist_ok=True)
    f = p / name
    f.write_text(
        f"# daily status\n\n- state: **{state}**\n"
        f"- pending: {pending}; running: {running}; pending families: 0\n"
        f"- worker lock: {lock}; heartbeat: {heartbeat}\n"
        f"- backlog pressure: {'yes' if backlog_pressure else 'no'}\n"
    )
    return f


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_state_from_the_projects_own_status_file(self):
        status(self.d, "status-2026-09-03.md", "ATTENTION")
        h = projects.health(proj(self.d), now=time.time(), activities=[])
        self.assertEqual(h.state, "ATTENTION")
        self.assertFalse(h.ok)

    def test_newest_status_file_wins(self):
        status(self.d, "status-2026-09-01.md", "ATTENTION", age_s=10_000)
        status(self.d, "status-2026-09-03.md", "OK")
        h = projects.health(proj(self.d), now=time.time(), activities=[])
        self.assertEqual((h.state, h.ok), ("OK", True))

    def test_no_status_file_is_unknown_not_a_crash(self):
        h = projects.health(proj(self.d), now=time.time(), activities=[])
        self.assertEqual((h.state, h.status_file, h.age_s, h.ok), (None, None, None, False))

    def test_project_specific_ok_states_are_honoured(self):
        # the bug this asserts against: Health.ok read the module default, so a
        # project declaring its own vocabulary was unhealthy forever
        status(self.d, "status-1.md", "STEADY")
        p = proj(self.d, ok_states=["STEADY"])
        self.assertTrue(projects.health(p, now=time.time(), activities=[]).ok)
        self.assertFalse(projects.health(proj(self.d), now=time.time(), activities=[]).ok)

    def test_unparseable_state_is_unknown(self):
        (self.d / "pipeline").mkdir()
        (self.d / "pipeline" / "status-1.md").write_text("no state line here\n")
        self.assertIsNone(projects.health(proj(self.d), now=time.time(), activities=[]).state)


class DispatchGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        status(self.d, "status-1.md", "ATTENTION")

    def tearDown(self):
        self.tmp.cleanup()

    def _health(self, live):
        return projects.health(proj(self.d), now=time.time(), activities=live)

    def test_clear_when_no_agent_is_live(self):
        self.assertEqual(projects.dispatch_blocked(self._health([])), "")

    def test_blocked_while_another_agent_is_working_the_tree(self):
        now = time.time()
        a = agents.Activity("codex", "01a0654e", str(self.d), "gpt-5.6-sol", now, Path("/x"))
        why = projects.dispatch_blocked(self._health([a]))
        self.assertIn("codex", why)
        self.assertIn("gpt-5.6-sol", why)

    def test_a_stale_session_does_not_block(self):
        old = time.time() - agents.LIVE_S - 60
        a = agents.Activity("codex", "c1", str(self.d), "gpt-5.6-sol", old, Path("/x"))
        self.assertEqual(projects.dispatch_blocked(self._health([a])), "")


class ConfigTests(unittest.TestCase):
    def test_loads_declared_projects_from_toml(self):
        with tempfile.TemporaryDirectory() as d:
            t = Path(d) / "fleet.toml"
            t.write_text('[[project]]\nname = "muse"\ndir = "/Users/pup/muse"\nthread = "muse2"\n')
            ps = projects.load(t)
            self.assertEqual(ps["muse"].dir, "/Users/pup/muse")
            self.assertEqual(ps["muse"].thread, "muse2")

    def test_no_projects_declared_is_empty_not_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            t = Path(d) / "fleet.toml"
            t.write_text("[settings]\ndefault_profile = \"v2\"\n")
            self.assertEqual(projects.load(t), {})

    def test_the_real_fleet_toml_declares_muse(self):
        ps = projects.load()
        self.assertIn("muse", ps)
        self.assertEqual(ps["muse"].thread, "muse2")


class NoActivityClassificationTests(unittest.TestCase):
    """The vacuous-truth case named live: muse's own generator emits
    NO ACTIVITY whenever zero tasks were attempted, before any of its
    real health checks run - it means two different things and a flat
    classification hides the broken one."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _proj(self):
        return proj(self.d, state_re=NO_ACTIVITY_STATE_RE)

    def test_benign_requires_all_three_positive_conditions(self):
        no_activity_status(self.d, "status-2026-09-07.md",
                            lock="inactive", pending=0, backlog_pressure=False)
        h = projects.health(self._proj(), now=time.time(), activities=[])
        self.assertEqual((h.state, h.no_activity, h.ok), ("NO ACTIVITY", "benign", True))

    def test_pending_with_nothing_running_is_attention(self):
        no_activity_status(self.d, "status-2026-09-07.md",
                            lock="inactive", pending=5, running=0, backlog_pressure=False)
        h = projects.health(self._proj(), now=time.time(), activities=[])
        self.assertEqual((h.no_activity, h.ok), ("attention", False))

    def test_backlog_pressure_is_attention_even_with_no_pending(self):
        no_activity_status(self.d, "status-2026-09-07.md",
                            lock="inactive", pending=0, backlog_pressure=True)
        h = projects.health(self._proj(), now=time.time(), activities=[])
        self.assertEqual((h.no_activity, h.ok), ("attention", False))

    def test_stale_lock_is_attention_a_crashed_worker(self):
        no_activity_status(self.d, "status-2026-09-07.md",
                            lock="stale", pending=0, backlog_pressure=False)
        h = projects.health(self._proj(), now=time.time(), activities=[])
        self.assertEqual((h.no_activity, h.ok), ("attention", False))

    def test_active_lock_holding_nothing_running_is_attention(self):
        # A lock actively held (a live pid) while nothing is running is the
        # same crash signature as "stale" by a different name - the worker
        # locked itself and then produced nothing.
        no_activity_status(self.d, "status-2026-09-07.md",
                            lock="active", pending=0, running=0, backlog_pressure=False)
        h = projects.health(self._proj(), now=time.time(), activities=[])
        self.assertEqual((h.no_activity, h.ok), ("attention", False))

    def test_active_lock_with_fresh_heartbeat_is_benign_even_with_pending(self):
        # The real false positive found live (4c368d7): a worker mid-task
        # with a fresh heartbeat and real pending work queued behind it
        # was flagged attention, because the original rule required an
        # inactive lock unconditionally. Pending > 0 here on purpose - a
        # live, progressing worker must not be penalised for a queue
        # behind it.
        no_activity_status(self.d, "status-2026-09-07.md",
                            lock="active", pending=3, running=1, backlog_pressure=False,
                            heartbeat="oldest update 45s ago")
        h = projects.health(self._proj(), now=time.time(), activities=[])
        self.assertEqual((h.no_activity, h.ok), ("benign", True))

    def test_active_lock_with_stale_heartbeat_is_attention(self):
        no_activity_status(self.d, "status-2026-09-07.md",
                            lock="active", pending=3, running=1, backlog_pressure=False,
                            heartbeat="oldest update 900s ago")  # > STALL_TIMEOUT_S (600)
        h = projects.health(self._proj(), now=time.time(), activities=[])
        self.assertEqual((h.no_activity, h.ok), ("attention", False))

    def test_active_lock_with_uncovered_task_is_attention(self):
        # muse's own logic: a running task contributing no heartbeat file
        # at all is treated as stale unconditionally, not as "fine".
        no_activity_status(self.d, "status-2026-09-07.md",
                            lock="active", pending=0, running=1, backlog_pressure=False,
                            heartbeat="1 task(s) not covered by heartbeat monitoring")
        h = projects.health(self._proj(), now=time.time(), activities=[])
        self.assertEqual((h.no_activity, h.ok), ("attention", False))

    def test_active_lock_with_idle_heartbeat_text_is_attention_not_benign(self):
        # "idle" only tells us running==0 - it is not a freshness claim
        # about a held lock, so it must not be read as confirmed-fresh.
        no_activity_status(self.d, "status-2026-09-07.md",
                            lock="active", pending=0, running=0, backlog_pressure=False,
                            heartbeat="idle")
        h = projects.health(self._proj(), now=time.time(), activities=[])
        self.assertEqual((h.no_activity, h.ok), ("attention", False))

    def test_unparseable_fields_are_unknown_not_benign(self):
        p = self.d / "pipeline"; p.mkdir(parents=True, exist_ok=True)
        (p / "status-2026-09-07.md").write_text("# daily status\n\n- state: **NO ACTIVITY**\n")
        h = projects.health(self._proj(), now=time.time(), activities=[])
        self.assertEqual((h.no_activity, h.ok), ("unknown", False))

    def test_non_no_activity_states_are_unaffected(self):
        no_activity_status(self.d, "status-2026-09-07.md", state="ATTENTION",
                            lock="inactive", pending=0, backlog_pressure=False)
        h = projects.health(self._proj(), now=time.time(), activities=[])
        # Would be "benign" by the same fields if this classifier fired on
        # ATTENTION too - it must not; ATTENTION already carries its own
        # real signal from muse's fuller health checks.
        self.assertEqual((h.state, h.no_activity, h.ok), ("ATTENTION", None, False))

    def test_no_activity_is_not_silently_added_to_ok_states(self):
        # Regression guard for the instruction not to just whitelist the
        # state - ok_states defaults must never include it.
        self.assertNotIn("NO ACTIVITY", [s.upper() for s in projects.DEFAULT_OK])


if __name__ == "__main__":
    unittest.main()
