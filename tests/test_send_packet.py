import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fleet import packet, send as send_mod


class SendPacketTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        self.events = self.state / "events.jsonl"
        self.pastes, self.keys = [], []
        self.p = packet.Packet(to="haiku-fs2", sender="sonnet2", lane="lookup", effort="low", reply="inline", body="newest handoff?")

    def tearDown(self):
        self.tmp.cleanup()

    def _send(self, p):
        with mock.patch("fleet.send.profile_state", return_value=self.state), \
             mock.patch("fleet.tmux.window_exists", return_value=True):
            return send_mod.send_packet(p, "v2", events_path=self.events,
                                        paste=lambda name, text: self.pastes.append((name, text)),
                                        send_keys=lambda name, keys: self.keys.append((name, keys)))

    def test_pastes_formatted_packet_with_id(self):
        pid = self._send(self.p)
        name, text = self.pastes[0]
        self.assertEqual(name, "haiku-fs2")
        self.assertIn(f"@id {pid}", text)
        self.assertTrue(text.endswith("newest handoff?"))

    def test_effort_applied_before_paste(self):
        self._send(self.p)
        self.assertEqual(self.keys[0], ("haiku-fs2", "/effort low"))

    def test_inline_reply_records_pending(self):
        pid = self._send(self.p)
        pend = json.loads((self.state / "pending" / "sonnet2.json").read_text())
        self.assertEqual(pend[0]["id"], pid)
        self.assertEqual(pend[0]["to"], "haiku-fs2")
        send_mod.clear_pending("sonnet2", pid, "v2", state=self.state)
        self.assertEqual(json.loads((self.state / "pending" / "sonnet2.json").read_text()), [])

    def test_file_reply_records_nothing(self):
        self.p.reply = "file"
        self._send(self.p)
        self.assertFalse((self.state / "pending").exists())

    def test_ledger_has_id_and_lane(self):
        pid = self._send(self.p)
        ev = json.loads(self.events.read_text().splitlines()[-1])
        self.assertEqual((ev["ev"], ev["id"], ev["lane"], ev["thread"]), ("send", pid, "lookup", "haiku-fs2"))
