"""Spawn failure carries a stderr tail (spec §9).

Real tmux, no mocks, no `claude`: the argv is a shell one-liner that writes
to stderr and exits non-zero, which is exactly the shape of the failure this
has to report (bad model id, missing brief, refused permission dialog). The
window name is not a fleet thread, so this is safe against a live fleet.
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from fleet import launcher, ledger, tmux
from fleet.paths import ROOT
from fleet.spec import Thread

NAME = "fleet-spawnfail-test"
MARKER = "BOOM-MARKER-XYZ"


class SpawnFailureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.events = Path(self.tmp.name) / "events.jsonl"
        self.thread = Thread(name=NAME, model="claude-haiku-4-5", tier="tool", persist="respawn")

    def tearDown(self):
        if tmux.window_exists(NAME):
            tmux.kill_window(NAME)
        shutil.rmtree(ROOT / NAME, ignore_errors=True)
        self.tmp.cleanup()

    def _fail(self):
        return launcher._spawn(self.thread, ["sh", "-c", f"echo {MARKER} >&2; exit 3"],
                               events_path=self.events)

    def test_failure_reports_the_tail_and_logs_it(self):
        with self.assertRaises(launcher.LaunchError) as cm:
            self._fail()
        self.assertIn(MARKER, str(cm.exception), "LaunchError must carry the tail")

        [rec] = [e for e in ledger.read_events(self.events) if e["ev"] == "spawn_failed"]
        self.assertEqual(rec["thread"], NAME)
        self.assertIn(MARKER, rec["tail"])
        self.assertIn("sh", rec["argv"])

    def test_the_dead_window_is_not_left_behind(self):
        with self.assertRaises(launcher.LaunchError):
            self._fail()
        self.assertFalse(tmux.window_exists(NAME))

    def test_nothing_is_written_to_the_production_ledger(self):
        # Counts the PRODUCTION ledger on purpose: the hazard this test exists to
        # catch is a failed spawn writing into it. But every other thread in the
        # fleet appends to that same file - measured median 7 events/min while the
        # fleet is active, p90 21, peak 80 - so comparing a global before/after made
        # the assertion depend on whether anyone else happened to write during this
        # test's own body. Roughly a 25% flake with the fleet busy (opus2,
        # 20260906T063000Z-live-test-correlation.md §1), and it fails toward red,
        # which trains people to ignore a red board.
        #
        # Fixed by comparing this file's own bytes rather than a line count of a file
        # everyone shares: an unrelated append from another thread moves the length
        # but not our claim, while a spawn writing here still moves both.
        prod = ledger.EVENTS
        before = prod.read_bytes() if prod.exists() else b""
        with self.assertRaises(launcher.LaunchError):
            self._fail()
        after = prod.read_bytes() if prod.exists() else b""
        # Our own failed spawn must not have appended. Another thread's concurrent
        # append is allowed to extend the tail; what is forbidden is any line
        # mentioning this test's throwaway thread name.
        added = after[len(before):] if after.startswith(before) else after
        self.assertNotIn(NAME.encode(), added,
                         f"failed spawn wrote to the production ledger: {added!r}")

    def test_a_healthy_spawn_leaves_no_remain_on_exit_behind(self):
        # remain-on-exit is switched on only to keep the dead pane readable;
        # if it survived a successful spawn, a later crash would leave a
        # zombie window and `fleet up` would refuse to restart the thread.
        launcher._spawn(self.thread, ["sleep", "30"], events_path=self.events)
        self.addCleanup(tmux.kill_window, NAME)
        self.assertTrue(tmux.window_exists(NAME))
        self.assertFalse(tmux.pane_dead(NAME))
        self.assertEqual(tmux.remain_on_exit(NAME), "off")


if __name__ == "__main__":
    unittest.main()
