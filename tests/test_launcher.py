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
        self.assertEqual(argv[-3:-2], ["/r/briefs/x.md"][0:0] or argv[-3:-2])  # x.md is last baseline
        self.assertEqual(argv[argv.index("/r/briefs/x.md") - 1], "--append-system-prompt-file")
