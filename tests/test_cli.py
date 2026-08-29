"""CLI verbs that carry policy of their own: `miss` (drops an abandoned
pending reply, C3) and `perm-check` (the destructive gate's oracle, H4)."""
import io
import json
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


if __name__ == "__main__":
    unittest.main()
