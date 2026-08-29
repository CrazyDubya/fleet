import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fleet import prompts

FIX = Path(__file__).parent / "fixtures" / "perm_commands_20260828.txt"


class DecideAutoTests(unittest.TestCase):
    def setUp(self):
        self.root = Path("/Users/pup/fleet")

    def test_all_recorded_prompts_auto_allow(self):
        for cmd in FIX.read_text().splitlines():
            d, why = prompts.decide_auto(cmd, self.root)
            self.assertEqual(d, "allow-auto", f"{cmd!r}: {why}")

    def test_destructive_denied(self):
        for cmd in ["rm -rf /Users/pup/fleet/gui", "git push origin main", "git push --force",
                    "ssh host ls", "curl -X POST http://x -d @file", "sudo ls", "git reset --hard HEAD~1"]:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_rm_inside_state_is_fine(self):
        self.assertEqual(prompts.decide_auto("rm -f state/gui-token", self.root)[0], "allow-auto")
        self.assertEqual(prompts.decide_auto("rm -rf /Users/pup/fleet/state/v2/tmp", self.root)[0], "allow-auto")

    def test_outside_root_escalates(self):
        self.assertEqual(prompts.decide_auto("cat /Users/pup/other/secret.txt", self.root)[0], "escalate")
        self.assertEqual(prompts.decide_auto("ls ~/Documents", self.root)[0], "escalate")

    def test_tmp_is_inside(self):
        self.assertEqual(prompts.decide_auto("echo hi > /tmp/x.log", self.root)[0], "allow-auto")

    def test_bare_relative_traversal_escalates(self):
        d, why = prompts.decide_auto("cat gui/../../../etc/passwd", self.root)
        self.assertEqual(d, "escalate", why)

    def test_rm_decoy_and_case_denied(self):
        for cmd in ["rm -rf state/bar gui/widgets", "rm -Rf /Users/pup/fleet/gui", "rm -RF gui"]:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_rm_rf_inside_state_allowed(self):
        self.assertEqual(prompts.decide_auto("rm -rf state/v2/tmp state/x", self.root)[0], "allow-auto")

    def test_rm_unspaced_separators_denied(self):
        cases = [
            "echo a; " + "rm -rf" + " gui",
            "echo a;" + "rm -rf" + " gui",
            "true&&" + "rm -rf" + " gui",
            "true|" + "rm -rf" + " gui",
            "sleep 1&" + "rm -rf" + " gui",
        ]
        for cmd in cases:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_rm_after_separator_inside_state_allowed(self):
        cmd = "echo a;" + "rm -rf" + " state/x"
        self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "allow-auto")


class PromptFilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.state = Path(self.tmp.name)
        self.patch = mock.patch("fleet.prompts.profile_state", return_value=self.state); self.patch.start()

    def tearDown(self):
        self.patch.stop(); self.tmp.cleanup()

    def test_open_wait_decide_roundtrip(self):
        path = prompts.open_prompt("sonnet2", "Bash", "cat ~/x", "/Users/pup/fleet/sonnet2", "v2")
        rec = json.loads(path.read_text())
        self.assertEqual((rec["thread"], rec["tool"], rec["command"]), ("sonnet2", "Bash", "cat ~/x"))
        self.assertEqual([p["id"] for p in prompts.pending("v2")], [rec["id"]])
        prompts.record_decision("sonnet2", rec["id"], "allow", "v2")
        self.assertEqual(prompts.wait_decision(path, timeout=1.0, sleep=lambda s: None), "allow")
        self.assertFalse(path.exists())

    def test_wait_times_out_and_removes(self):
        path = prompts.open_prompt("sonnet2", "Bash", "x", "/Users/pup/fleet/sonnet2", "v2")
        self.assertIsNone(prompts.wait_decision(path, timeout=0.0, sleep=lambda s: None))
        self.assertFalse(path.exists())

    def test_pending_tolerates_vanished_file(self):
        prompts.open_prompt("sonnet2", "Bash", "x", "/Users/pup/fleet/sonnet2", "v2")
        with mock.patch("pathlib.Path.read_text", side_effect=FileNotFoundError):
            self.assertEqual(prompts.pending("v2"), [])
