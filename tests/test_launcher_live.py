import json
import subprocess
import time
import unittest
from pathlib import Path

from fleet import launcher, tmux, paths
from fleet.registry import Registry
from fleet.spec import load_specs


class LauncherLiveTests(unittest.TestCase):
    """Uses the real haiku-fs spec. Leaves no windows behind."""

    def tearDown(self):
        for w in ("haiku-fs",):
            if tmux.window_exists(w):
                tmux.kill_window(w)
        # brief's tearDown kills the window but leaves the registry entry as
        # "running"; clear it so independent test methods don't see stale
        # state from each other when the whole module runs together.
        reg = Registry()
        entries = reg.load()
        if "haiku-fs" in entries:
            del entries["haiku-fs"]
            reg.save(entries)

    def test_up_park_wake_respawn_cycle(self):
        reg = Registry()
        e = launcher.up("haiku-fs")
        self.assertTrue(tmux.window_exists("haiku-fs"))
        self.assertEqual(reg.load()["haiku-fs"].status, "running")
        tmux.paste("haiku-fs", "Remember the codeword PELICAN-42. Reply with just: noted.")
        deadline = time.time() + 120
        tp = paths.transcript_path(Path(e.cwd), e.session_id)
        while time.time() < deadline and not tp.exists():
            time.sleep(2)
        self.assertTrue(tp.exists(), "transcript never appeared; claude did not start")
        self.assertIn("PELICAN-42", tp.read_text())

        launcher.park("haiku-fs")
        self.assertFalse(tmux.window_exists("haiku-fs"))
        self.assertEqual(reg.load()["haiku-fs"].status, "parked")

        launcher.wake("haiku-fs")
        self.assertTrue(tmux.window_exists("haiku-fs"))
        tmux.paste("haiku-fs", "What was the codeword? Reply with just the codeword.")
        deadline = time.time() + 120
        while time.time() < deadline and tp.read_text().count("PELICAN-42") < 3:
            time.sleep(2)
        self.assertGreaterEqual(tp.read_text().count("PELICAN-42"), 3, "resumed session did not recall the fact")

        old = reg.load()["haiku-fs"].session_id
        launcher.respawn("haiku-fs")
        new = reg.load()["haiku-fs"]
        self.assertNotEqual(new.session_id, old)
        self.assertIn(old, new.lineage)

    def test_up_twice_is_an_error(self):
        launcher.up("haiku-fs")
        with self.assertRaises(launcher.LaunchError):
            launcher.up("haiku-fs")

    @unittest.skip("needs Task 9")
    def test_fork_opus_child_gets_brief(self):
        launcher.up("opus")
        brief = paths.ROOT / "briefs" / "expert-test.md"
        brief.write_text("# expert-test\nYou are a test expert.\n")
        try:
            launcher.fork("opus", "expert-test", "briefs/expert-test.md")
            time.sleep(5)
            from fleet import status
            status.resolve_pending_fork_ids(Registry())
            child = Registry().load()["expert-test"]
            self.assertNotEqual(child.session_id, "pending")
            self.assertEqual(child.fork_of, "opus")
            cmd = subprocess.run(["tmux", "display", "-p", "-t", "fleet:expert-test", "#{pane_start_command}"],
                                 capture_output=True, text=True).stdout
            self.assertIn("expert-test.md", cmd); self.assertIn("--fork-session", cmd)
        finally:
            for w in ("expert-test", "opus"):
                if tmux.window_exists(w): tmux.kill_window(w)
            brief.unlink(missing_ok=True)
            reg = Registry(); entries = reg.load(); entries.pop("expert-test", None); reg.save(entries)
