import tempfile
import time
import unittest
from dataclasses import dataclass
from pathlib import Path

from fleet import activity


@dataclass
class _Entry:
    name: str
    session_id: str
    cwd: str
    fork_of: str | None = None


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_unknown_when_registry_is_none(self):
        a = activity.check("sonnet2", None, since=time.time() - 60)
        self.assertEqual(a.status, "unknown")

    def test_unknown_when_thread_not_registered(self):
        a = activity.check("ghost", {}, since=time.time() - 60)
        self.assertEqual(a.status, "unknown")

    def test_busy_via_a_file_written_under_cwd_after_the_cutoff(self):
        cwd = self.root / "muse2"
        (cwd / "ledger" / "grok-probes-raw").mkdir(parents=True)
        entries = {"muse2": _Entry(name="muse2", session_id="nonexistent-session", cwd=str(cwd))}
        cutoff = time.time() - 60
        (cwd / "ledger" / "grok-probes-raw" / "out.json").write_text("{}")
        a = activity.check("muse2", entries, since=cutoff)
        self.assertEqual(a.status, "busy")
        self.assertIn("out.json", a.evidence)

    def test_quiet_when_nothing_under_cwd_is_newer_than_the_cutoff(self):
        cwd = self.root / "muse2"
        cwd.mkdir()
        old_file = cwd / "stale.txt"
        old_file.write_text("old")
        import os
        old_time = time.time() - 7200
        os.utime(old_file, (old_time, old_time))
        entries = {"muse2": _Entry(name="muse2", session_id="nonexistent-session", cwd=str(cwd))}
        a = activity.check("muse2", entries, since=time.time() - 60)
        self.assertEqual(a.status, "quiet")

    def test_a_truncated_scan_is_unknown_not_quiet(self):
        import os
        cwd = self.root / "muse2"
        cwd.mkdir()
        old_time = time.time() - 7200
        for i in range(5):
            f = cwd / f"f{i}.txt"
            f.write_text("x")
            os.utime(f, (old_time, old_time))
        entries = {"muse2": _Entry(name="muse2", session_id="nonexistent-session", cwd=str(cwd))}
        # cap_files=2 forces the scan to give up after checking 2 of the 5
        # (all old) files - it cannot rule out that one of the unchecked
        # three was newer than the cutoff, so "unknown" is the honest
        # answer even though, in this synthetic case, all five are old.
        a = activity.check("muse2", entries, since=time.time() - 60, cap_files=2)
        self.assertEqual(a.status, "unknown")


if __name__ == "__main__":
    unittest.main()
