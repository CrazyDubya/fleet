import subprocess
import time
import unittest
from pathlib import Path

from fleet import launcher, tmux, paths
from fleet.registry import Registry
from fleet.spec import load_specs


def _live(name: str) -> bool:
    """True when the operator has this thread genuinely running."""
    e = Registry().load().get(name)
    return bool(e and e.status == "running" and tmux.window_exists(name))


# Decided at IMPORT time, on the class. A skipTest() raised inside a test body
# is not enough: unittest still runs tearDown, and this module's tearDown kills
# the window and deletes the registry entry - so merely *running* the suite
# against a live fleet used to destroy it. A class-level skip means unittest
# never enters setUp/tearDown for these cases at all.
HAIKU_LIVE = _live("haiku-fs")
OPUS_LIVE = _live("opus")


class _SpawningTestCase(unittest.TestCase):
    """Cleanup that only fires for threads this test itself spawned."""

    THREADS: tuple[str, ...] = ()

    def setUp(self):
        self._touched = False

    def tearDown(self):
        if not getattr(self, "_touched", False):
            return
        for w in self.THREADS:
            if tmux.window_exists(w):
                tmux.kill_window(w)
        reg = Registry()
        entries = reg.load()
        if [w for w in self.THREADS if entries.pop(w, None) is not None]:
            reg.save(entries)


@unittest.skipIf(HAIKU_LIVE, "haiku-fs is registered running with a live window - not touching it")
class LauncherLiveTests(_SpawningTestCase):
    """Uses the real haiku-fs spec. Leaves no windows behind."""

    THREADS = ("haiku-fs",)

    def test_up_park_wake_respawn_cycle(self):
        reg = Registry()
        self._touched = True
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
        self._touched = True
        launcher.up("haiku-fs")
        with self.assertRaises(launcher.LaunchError):
            launcher.up("haiku-fs")


@unittest.skipIf(OPUS_LIVE, "opus is registered running with a live window - not touching it")
class ForkLiveTests(_SpawningTestCase):
    """Forks the real opus thread. Leaves no windows behind."""

    THREADS = ("expert-test", "opus")

    def setUp(self):
        super().setUp()
        self._toml = (paths.ROOT / "fleet.toml").read_text()

    def tearDown(self):
        super().tearDown()
        if getattr(self, "_touched", False):
            # `fork` appends a [thread.expert-test] stanza (spec §4) - undo it.
            (paths.ROOT / "fleet.toml").write_text(self._toml)
            (paths.ROOT / "briefs" / "expert-test.md").unlink(missing_ok=True)

    def test_fork_opus_child_gets_brief(self):
        self._touched = True
        e = launcher.up("opus")
        # --resume needs a session claude has actually recorded at least one
        # turn for; a freshly-spawned window has no transcript yet (verified
        # by hand: ~/.claude/projects/.../opus/ doesn't exist until the first
        # reply lands), so send a throwaway message and wait for it, the same
        # way test_up_park_wake_respawn_cycle does above.
        tmux.paste("opus", "Reply with just: ready.")
        tp = paths.transcript_path(Path(e.cwd), e.session_id)
        deadline = time.time() + 120
        while time.time() < deadline and not tp.exists():
            time.sleep(2)
        self.assertTrue(tp.exists(), "opus transcript never appeared; claude did not start")
        brief = paths.ROOT / "briefs" / "expert-test.md"
        brief.write_text("# expert-test\nYou are a test expert.\n")
        launcher.fork("opus", "expert-test", "briefs/expert-test.md")
        time.sleep(5)
        from fleet import status
        status.resolve_pending_fork_ids(Registry())
        child = Registry().load()["expert-test"]
        self.assertNotEqual(child.session_id, "pending")
        self.assertEqual(child.fork_of, "opus")
        # fork appends a [thread.expert-test] stanza so wake/respawn find it
        self.assertIn("expert-test", load_specs())
        cmd = subprocess.run(["tmux", "display", "-p", "-t", "fleet:expert-test", "#{pane_start_command}"],
                             capture_output=True, text=True).stdout
        self.assertIn("expert-test.md", cmd)
        self.assertIn("--fork-session", cmd)


if __name__ == "__main__":
    unittest.main()
