import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from fleet import cli as cli_mod
from fleet import ledger, prompts


class CmdDecideTests(unittest.TestCase):
    """`fleet decide` must not report success unless the decision both
    landed in the ledger AND was actually consumed by a live waiter -
    reproduced live 2026-09-06: a `wait_decision` poll loop killed before
    its own `finally: path.unlink()` ran left an orphaned, undecided
    prompt file that `fleet decide` would happily "decide" again and
    again, printing an identical success line each time while the thread
    it was meant to unblock sat stuck.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name) / "state"
        self.events = Path(self.tmp.name) / "events.jsonl"
        self.patches = [
            mock.patch("fleet.prompts.profile_state", return_value=self.state),
            mock.patch("fleet.cli.current_profile", return_value="v2"),
            mock.patch("fleet.cli.ledger.EVENTS", self.events),
            mock.patch("fleet.cli.DECIDE_CONFIRM_TIMEOUT_S", 1.0),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _decide_events(self):
        if not self.events.exists():
            return []
        return [json.loads(l) for l in self.events.read_text().splitlines() if '"ev": "decide"' in l]

    def _args(self, thread, pid, decision):
        ns = mock.Mock()
        ns.thread, ns.id, ns.decision = thread, pid, decision
        return ns

    def test_no_pending_prompt_is_an_error(self):
        rc = cli_mod.cmd_decide(self._args("sonnet2", "0" * 16, "allow"))
        self.assertEqual(rc, 1)
        self.assertEqual(self._decide_events(), [])

    def test_a_live_waiter_makes_decide_succeed(self):
        path = prompts.open_prompt("sonnet2", "Bash", "cat ~/x", "/Users/pup/fleet/sonnet2", "v2")
        pid = json.loads(path.read_text())["id"]
        result = {}

        def waiter():
            result["decision"] = prompts.wait_decision(path, timeout=5.0)

        t = threading.Thread(target=waiter)
        t.start()
        try:
            rc = cli_mod.cmd_decide(self._args("sonnet2", pid, "allow"))
        finally:
            t.join(timeout=5)
        self.assertEqual(rc, 0)
        self.assertEqual(result.get("decision"), "allow")
        self.assertFalse(path.exists())
        self.assertEqual(len(self._decide_events()), 1)

    def test_an_orphaned_prompt_reports_failure_not_silent_success(self):
        # No wait_decision anywhere - simulates its process having died
        # (a hook timeout killing it before its own `finally` ran) before
        # ever writing a decision, exactly as reproduced live.
        path = prompts.open_prompt("sonnet2", "Bash", "cat ~/x", "/Users/pup/fleet/sonnet2", "v2")
        pid = json.loads(path.read_text())["id"]
        rc = cli_mod.cmd_decide(self._args("sonnet2", pid, "allow"))
        self.assertEqual(rc, 1)
        # The decision DOES land in the ledger - that half of the old
        # "silent noop" is real and was never in question. What must not
        # happen is a success line printed over it.
        self.assertEqual(len(self._decide_events()), 1)
        self.assertTrue(path.exists())
        self.assertEqual(json.loads(path.read_text())["decision"], "allow")

    def test_a_second_decide_on_the_same_orphan_is_also_reported_as_failure(self):
        # Confirmed live: re-issuing the identical `fleet decide` command
        # on an orphaned prompt printed the same misleading success line
        # a second time. Must now fail loudly both times, not just once.
        path = prompts.open_prompt("sonnet2", "Bash", "cat ~/x", "/Users/pup/fleet/sonnet2", "v2")
        pid = json.loads(path.read_text())["id"]
        rc1 = cli_mod.cmd_decide(self._args("sonnet2", pid, "allow"))
        rc2 = cli_mod.cmd_decide(self._args("sonnet2", pid, "allow"))
        self.assertEqual((rc1, rc2), (1, 1))
        self.assertEqual(len(self._decide_events()), 2)


if __name__ == "__main__":
    unittest.main()
