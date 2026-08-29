import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from fleet.bench import tasks

TOML = '''
id = "lookup-newest"
lane = "lookup"
packet = "Newest file under {root}/ledger/handoffs and its first line. Refs: {refs}"
refs = ["maps/projects.md"]
target = "bench/work/{run}/out"
done = "the reply names the newest handoff"
check = "grep -q handoffs {target}/reply.txt"
timeout_s = 120
'''


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.dir = Path(self.tmp.name)
        (self.dir / "lookup-newest.toml").write_text(TOML)

    def tearDown(self):
        self.tmp.cleanup()

    def test_load_and_defaults(self):
        t = tasks.load_task(self.dir / "lookup-newest.toml")
        self.assertEqual((t.id, t.lane, t.timeout_s), ("lookup-newest", "lookup", 120))
        self.assertIsNone(t.judge); self.assertIsNone(t.cleanup)
        self.assertEqual(t.refs, ["maps/projects.md"])

    def test_substitute(self):
        t = tasks.load_task(self.dir / "lookup-newest.toml")
        r = tasks.substitute(t, "abc123", Path("/r"))
        self.assertEqual(r.target, "bench/work/abc123/out")
        self.assertEqual(r.check, "grep -q handoffs bench/work/abc123/out/reply.txt")
        self.assertIn("/r/ledger/handoffs", r.packet); self.assertIn("maps/projects.md", r.packet)

    def test_expect_is_optional_and_substituted(self):
        t = tasks.load_task(self.dir / "lookup-newest.toml")
        self.assertIsNone(t.expect)
        (self.dir / "e.toml").write_text(TOML + '\nexpect = "cd {root} && ls -t ledger/handoffs | head -1"\n')
        e = tasks.substitute(tasks.load_task(self.dir / "e.toml"), "abc123", Path("/r"))
        self.assertEqual(e.expect, "cd /r && ls -t ledger/handoffs | head -1")

    def test_with_expect_fills_check_and_cleanup(self):
        t = tasks.load_task(self.dir / "lookup-newest.toml")
        r = tasks.with_expect(tasks.substitute(replace(t, check='test "$(cat {target}/reply.txt)" = "{expect}"',
                                                       cleanup="rm -rf {target}"), "abc123", Path("/r")), "ledger/handoffs/a.md")
        self.assertEqual(r.check, 'test "$(cat bench/work/abc123/out/reply.txt)" = "ledger/handoffs/a.md"')
        self.assertEqual(r.cleanup, "rm -rf bench/work/abc123/out")

    def test_load_all_sorted_and_rejects_bad_lane(self):
        (self.dir / "a-build.toml").write_text(TOML.replace('id = "lookup-newest"', 'id = "a-build"').replace('lane = "lookup"', 'lane = "build"'))
        self.assertEqual([t.id for t in tasks.load_all(self.dir)], ["a-build", "lookup-newest"])
        (self.dir / "bad.toml").write_text(TOML.replace('lane = "lookup"', 'lane = "magic"'))
        with self.assertRaises(ValueError):
            tasks.load_all(self.dir)
