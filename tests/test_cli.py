"""CLI verbs that carry policy of their own: `miss` (drops an abandoned
pending reply, C3) and `perm-check` (the destructive gate's oracle, H4)."""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fleet import cli, send as send_mod


class MissTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.state = Path(self.tmp.name)
        self.ps = mock.patch("fleet.send.profile_state", return_value=self.state); self.ps.start()
        self.ev = mock.patch("fleet.cli.ledger.event"); self.ev.start()
        self.pid = "0123456789abcdef"
        send_mod._add_pending("sonnet2", self.pid, "haiku-fs2", self.state)

    def tearDown(self):
        self.ev.stop(); self.ps.stop(); self.tmp.cleanup()

    def _pending(self):
        return json.loads((self.state / "pending" / "sonnet2.json").read_text())

    def _miss(self, *reason):
        with redirect_stdout(io.StringIO()):
            return cli.cmd_miss(SimpleNamespace(thread="sonnet2", reason=list(reason)))

    def test_miss_abandoned_clears_pending(self):
        # hold.sh prints exactly this command as the way out of a stuck turn.
        self.assertEqual(self._miss(f"abandoned-{self.pid}"), 0)
        self.assertEqual(self._pending(), [])

    def test_ordinary_miss_leaves_pending_alone(self):
        self.assertEqual(self._miss("compacting", "before", "handoff"), 0)
        self.assertEqual([i["id"] for i in self._pending()], [self.pid])

    def test_malformed_id_is_not_treated_as_abandoned(self):
        self._miss("abandoned-nothex")
        self.assertEqual([i["id"] for i in self._pending()], [self.pid])

    def _miss_out(self, *reason):
        out = io.StringIO()
        with redirect_stdout(out):
            cli.cmd_miss(SimpleNamespace(thread="sonnet2", reason=list(reason)))
        return out.getvalue()

    def test_dropped_line_printed_only_when_something_was_dropped(self):
        self.assertIn("dropped pending reply", self._miss_out(f"abandoned-{self.pid}"))
        # second time round the entry is already gone: claiming to have
        # dropped it again is a fix that did not happen
        self.assertNotIn("dropped pending reply", self._miss_out(f"abandoned-{self.pid}"))

    def test_clear_pending_reports_whether_it_removed_anything(self):
        self.assertTrue(send_mod.clear_pending("sonnet2", self.pid, "v2", state=self.state))
        self.assertFalse(send_mod.clear_pending("sonnet2", self.pid, "v2", state=self.state))
        self.assertFalse(send_mod.clear_pending("nobody", self.pid, "v2", state=self.state))


class SendArgvTests(unittest.TestCase):
    """`fleet send` argparse wiring: the flags must land on the Packet."""

    def _main(self, argv):
        with mock.patch("fleet.cli.activate_profile"), \
                mock.patch("fleet.cli.send_mod.send_packet", return_value="deadbeef") as sp, \
                mock.patch("fleet.cli.send_mod.send", return_value=7) as plain, \
                redirect_stdout(io.StringIO()):
            rc = cli.main(argv)
        return rc, sp, plain

    def test_flags_land_on_the_packet(self):
        rc, sp, plain = self._main(["send", "sonnet2", "hello", "world", "--lane", "plan",
                                    "--effort", "high", "--reply", "file", "--done", "ship it",
                                    "--refs", "a", "b"])
        self.assertEqual(rc, 0)
        plain.assert_not_called()
        p = sp.call_args.args[0]
        self.assertEqual((p.to, p.sender, p.lane, p.effort, p.reply), ("sonnet2", "operator", "plan", "high", "file"))
        self.assertEqual((p.done, p.refs, p.body), ("ship it", ["a", "b"], "hello world"))

    def test_lane_alone_fills_the_rest_from_the_lane_table(self):
        _, sp, _ = self._main(["send", "haiku-fs2", "newest handoff?", "--lane", "lookup"])
        p = sp.call_args.args[0]
        self.assertEqual((p.lane, p.effort, p.reply), ("lookup", "low", "inline"))

    def test_no_flags_uses_the_plain_send_path(self):
        rc, sp, plain = self._main(["send", "sonnet2", "just", "text"])
        self.assertEqual(rc, 0)
        sp.assert_not_called()
        self.assertEqual(plain.call_args.args, ("sonnet2", "just text"))

    def test_packet_module_is_imported_at_module_level(self):
        from fleet import packet as packet_mod
        self.assertIs(cli.packet_mod, packet_mod)


class SettingsCacheTests(unittest.TestCase):
    def test_settings_is_parsed_once_per_process(self):
        with mock.patch.object(cli, "_SETTINGS", None), \
                mock.patch("fleet.cli.spec_mod.load_settings",
                           return_value={"default_profile": "v2", "cache_ttl_minutes": 60}) as ls:
            self.assertEqual(cli.settings()["default_profile"], "v2")
            cli.settings()
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("FLEET_PROFILE", None)
                self.assertEqual(cli.current_profile(), "v2")
                self.assertEqual(cli.current_profile(), "v2")
            self.assertEqual(ls.call_count, 1)
            cli.settings(refresh=True)
            self.assertEqual(ls.call_count, 2)


class PermCheckTests(unittest.TestCase):
    def _check(self, command):
        out = io.StringIO()
        with redirect_stdout(out):
            cli.cmd_perm_check(SimpleNamespace(command=command))
        return out.getvalue().strip()

    def test_denies_the_deny_class(self):
        self.assertEqual(self._check("git push origin main"), "deny")

    def test_allows_benign(self):
        self.assertEqual(self._check("ls"), "ok")

    def test_escalate_is_reported_as_ok(self):
        # perm-check answers the policy question only: escalation belongs to
        # perm-decide (PermissionRequest), which has an operator to wait for.
        self.assertEqual(self._check("cat /Users/pup/other/secret.txt"), "ok")


class SendLaneChoicesTests(unittest.TestCase):
    """The plumbing for the verify lane (MUSE-FLEET-MEMBER): --lane must
    accept "verify" the same way it accepts the other five, and must
    reject anything else - that a typo like "verifyy" still errors is
    what makes the choices list a real guard, not a suggestion."""

    def test_lane_verify_is_a_valid_choice(self):
        args = cli._build_parser().parse_args(["send", "muse2", "check", "it", "--lane", "verify"])
        self.assertEqual(args.lane, "verify")

    def test_an_unknown_lane_is_still_rejected(self):
        with self.assertRaises(SystemExit):
            cli._build_parser().parse_args(["send", "muse2", "x", "--lane", "verifyy"])


if __name__ == "__main__":
    unittest.main()
