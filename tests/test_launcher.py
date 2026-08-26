import unittest
from pathlib import Path

from fleet import launcher
from fleet.spec import Thread

ROOT = Path("/r")


class ArgvTests(unittest.TestCase):
    def test_fresh_spawn_argv_is_frozen_order(self):
        t = Thread(name="haiku-fs", model="claude-haiku-4-5", tier="tool", persist="respawn",
                   baseline=["briefs/haiku-fs.md", "maps/repo.md"], effort="low")
        argv = launcher.build_argv(t, ROOT, session_id="u1")
        self.assertEqual(argv, [
            "claude", "--model", "claude-haiku-4-5", "--name", "haiku-fs", "--session-id", "u1",
            "--append-system-prompt-file", "/r/briefs/haiku-fs.md",
            "--append-system-prompt-file", "/r/maps/repo.md",
            "--strict-mcp-config",
            "--permission-mode", "default", "--effort", "low",
        ])
        # thread.mcp is None here, but --strict-mcp-config must still be present -
        # it's what stops claude from discovering an ancestor .mcp.json and
        # blocking on a first-run trust dialog.
        self.assertIn("--strict-mcp-config", argv)

    def test_mcp_dirs_and_resume_fork(self):
        t = Thread(name="sonnet", model="claude-sonnet-5", tier="hot", persist="singular",
                   baseline=["briefs/sonnet.md"], mcp="core", dirs=["/Users/pup"])
        argv = launcher.build_argv(t, ROOT, resume_id="p1", fork=True, extra_baseline=["briefs/x.md"])
        self.assertIn("--resume", argv); self.assertIn("p1", argv); self.assertIn("--fork-session", argv)
        self.assertNotIn("--session-id", argv)
        i = argv.index("--mcp-config"); self.assertEqual(argv[i + 1], "/r/mcp/core.json")
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--add-dir") + 1], "/Users/pup")
        # x.md is the last baseline, appended after the thread's own
        self.assertEqual(argv[argv.index("/r/briefs/x.md") - 1], "--append-system-prompt-file")
        self.assertGreater(argv.index("/r/briefs/x.md"), argv.index("/r/briefs/sonnet.md"))


class SettingsArgvTests(unittest.TestCase):
    """--settings is part of the frozen prefix, at a fixed position right
    after --permission-mode (P1: mechanism only; no thread opts in here)."""

    def _thread(self, **kw):
        return Thread(name="opus", model="claude-opus-5", tier="warm", persist="on-demand",
                      baseline=["briefs/opus.md"], **kw)

    def test_absent_by_default(self):
        self.assertNotIn("--settings", launcher.build_argv(self._thread(), ROOT, session_id="u1"))

    def test_sits_immediately_after_permission_mode(self):
        argv = launcher.build_argv(self._thread(settings="settings/unattended.json", effort="low"),
                                   ROOT, session_id="u1")
        i = argv.index("--permission-mode")
        self.assertEqual(argv[i:i + 5], ["--permission-mode", "default",
                                         "--settings", "/r/settings/unattended.json", "--effort"])

    def test_path_is_resolved_against_the_root(self):
        argv = launcher.build_argv(self._thread(settings="settings/unattended.json"), ROOT)
        self.assertEqual(argv[argv.index("--settings") + 1], "/r/settings/unattended.json")


class ThreadNameTests(unittest.TestCase):
    """A thread name becomes a tmux window name, a directory under ROOT, a
    transcript dir key and a TOML bare key. Reject anything that would be a
    surprise in any of those before it reaches the filesystem."""

    GOOD = ["sonnet", "haiku-fs", "expert-test", "a", "a1", "x" * 31]
    BAD = ["", "-lead", "Opus", "has space", "dot.name", "under_score", "../escape",
           "slash/name", "x" * 32, "ünicode"]

    def test_accepts_the_names_the_fleet_actually_uses(self):
        for n in self.GOOD:
            with self.subTest(n=n):
                launcher.validate_name(n)  # must not raise

    def test_rejects_names_that_would_surprise_tmux_the_fs_or_toml(self):
        for n in self.BAD:
            with self.subTest(n=n):
                with self.assertRaises(launcher.LaunchError):
                    launcher.validate_name(n)

    def test_fork_rejects_a_bad_new_name_before_touching_anything(self):
        with self.assertRaises(launcher.LaunchError) as cm:
            launcher.fork("opus", "../escape", "briefs/opus.md")
        self.assertIn("escape", str(cm.exception))
