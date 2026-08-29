"""Live checks for the v2 profile (Task 9). Skipped unless tmux session
"fleet2" is actually up - same guard pattern as test_launcher_live_guard.py's
sibling test_launcher_live.py: these touch a real, running fleet, so they
must not run (and must not fail) in an environment where fleet2 was never
brought up.
"""
import os
import subprocess
import time
import unittest

from fleet import ask, prompts, tmux
from fleet.paths import ROOT

LIVE = subprocess.run(["tmux", "has-session", "-t", "fleet2"], capture_output=True).returncode == 0


@unittest.skipUnless(LIVE, "tmux session fleet2 not running")
class V2LiveTests(unittest.TestCase):
    def setUp(self):
        tmux.use_session("fleet2")

    def tearDown(self):
        tmux.use_session("fleet")

    def test_ask_round_trip_under_5s(self):
        t0 = time.monotonic()
        out = ask.ask("haiku-fs2", "reply with exactly: pong", sender="operator", profile="v2")
        self.assertLess(time.monotonic() - t0, 5.0)
        self.assertIn("pong", out)

    def test_router_returns_a_lane(self):
        out = ask.ask("haiku-router2", "list the files under gui/widgets", sender="operator", profile="v2")
        self.assertIn("@lane lookup", out)

    def test_perm_escalate_then_decide(self):
        # Inherit the ambient PATH (rather than a hand-picked minimal one):
        # on this machine /usr/bin/python3 is a Python 3.9 stuck ahead of
        # the working 3.12 on a short PATH, and fleet's modules use PEP 604
        # `X | Y` annotations that 3.9 cannot even import - a narrow PATH
        # list resolves `python3` to that copy and every subprocess call
        # below crashes before it does anything profile- or tmux-related.
        env = {**os.environ, "FLEET_PROFILE": "v2"}
        r = subprocess.Popen([str(ROOT / "bin/fleet"), "perm-decide", "sonnet2", str(ROOT / "sonnet2"), "cat /Users/pup/elsewhere/x"],
                             stdout=subprocess.PIPE, text=True, env=env)
        time.sleep(1.0)
        pend = prompts.pending("v2")
        self.assertEqual(pend[-1]["command"], "cat /Users/pup/elsewhere/x")
        subprocess.run([str(ROOT / "bin/fleet"), "decide", "sonnet2", pend[-1]["id"], "allow"], check=True, env=env)
        self.assertEqual(r.communicate(timeout=10)[0].strip(), "allow")


if __name__ == "__main__":
    unittest.main()
