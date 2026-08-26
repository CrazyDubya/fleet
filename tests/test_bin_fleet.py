"""`bin/fleet` must work from any cwd.

Threads run from /Users/pup/fleet/<thread>/, and protocol rule 4 tells every
thread to run `fleet miss ...` from there. The shim used to `exec python3 -m
fleet.cli` and rely on cwd being on sys.path, so it only worked from the repo
root. `ls` is read-only, so this is safe against a live fleet.
"""

import subprocess
import tempfile
import unittest

from fleet.paths import ROOT

SHIM = ROOT / "bin" / "fleet"


class BinFleetTests(unittest.TestCase):
    def _run(self, cwd):
        return subprocess.run([str(SHIM), "ls"], cwd=cwd, capture_output=True, text=True)

    def test_runs_from_an_unrelated_cwd(self):
        with tempfile.TemporaryDirectory() as d:
            r = self._run(d)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("No module named", r.stderr)

    def test_runs_from_a_thread_dir(self):
        r = self._run(ROOT / "haiku-fs")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("No module named", r.stderr)

    def test_runs_from_the_repo_root(self):
        r = self._run(ROOT)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
