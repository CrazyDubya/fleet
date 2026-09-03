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


if __name__ == "__main__":
    unittest.main()
