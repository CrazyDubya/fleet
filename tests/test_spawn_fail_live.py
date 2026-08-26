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
        before = len(ledger.read_events())
        with self.assertRaises(launcher.LaunchError):
            self._fail()
        self.assertEqual(len(ledger.read_events()), before)

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
