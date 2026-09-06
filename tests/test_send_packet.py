import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from fleet import packet, send as send_mod


class SendPacketTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        self.events = self.state / "events.jsonl"
        self.pastes, self.keys, self.sleeps = [], [], []
        self.p = packet.Packet(to="haiku-fs2", sender="sonnet2", lane="lookup", effort="low", reply="inline", body="newest handoff?")

    def tearDown(self):
        self.tmp.cleanup()

    def _send(self, p):
        # send_keys= and sleep= are captured so the tests below can assert that
        # send_packet types NOTHING into the pane before the paste (H1).
        with mock.patch("fleet.send.profile_state", return_value=self.state), \
             mock.patch("fleet.tmux.window_exists", return_value=True):
            return send_mod.send_packet(p, "v2", events_path=self.events,
                                        paste=lambda name, text: self.pastes.append((name, text)),
                                        send_keys=lambda name, keys: self.keys.append((name, keys)),
                                        sleep=lambda s: self.sleeps.append(s))

    def test_pastes_formatted_packet_with_id(self):
        pid = self._send(self.p)
        name, text = self.pastes[0]
        self.assertEqual(name, "haiku-fs2")
        self.assertIn(f"@id {pid}", text)
        self.assertTrue(text.endswith("newest handoff?"))

    def test_no_effort_keystroke_is_sent(self):
        # H1 (found live): `/effort <level>` is a PERSISTENT Claude Code
        # setting - "saved as your default for new sessions" - so sending it
        # per packet rewrote the operator's own global default. Effort is set
        # at spawn (--effort from fleet.toml); @effort in the header is advice.
        self._send(self.p)
        self.assertEqual(self.keys, [])
        self.assertEqual(self.sleeps, [])

    def test_effort_still_appears_in_the_header(self):
        self._send(self.p)
        self.assertIn("@effort low", self.pastes[0][1])

    def test_no_settle_sleep_without_effort(self):
        self.p.effort = None
        self._send(self.p)
        self.assertEqual(self.sleeps, [])

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

    def test_ledger_has_done(self):
        self.p.done = "gui serves /w/status/"
        self._send(self.p)
        ev = json.loads(self.events.read_text().splitlines()[-1])
        self.assertEqual(ev["done"], "gui serves /w/status/")


class PendingLockTests(unittest.TestCase):
    """_add_pending is a read-modify-write: two senders in it at once used to
    lose one entry, and a lost entry is a reply the Stop hook stops waiting
    for."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        self.path = send_mod._pending_path("sonnet2", self.state)

    def tearDown(self):
        self.tmp.cleanup()

    def _items(self):
        return json.loads(self.path.read_text())

    def test_two_concurrent_adds_both_land(self):
        real = send_mod._read_pending

        def slow_read(path):
            out = real(path)
            time.sleep(0.05)  # widen the read-modify-write window
            return out

        ready = threading.Barrier(2)

        def add(pid):
            ready.wait()
            send_mod._add_pending("sonnet2", pid, "haiku-fs2", self.state)

        with mock.patch("fleet.send._read_pending", slow_read):
            ts = [threading.Thread(target=add, args=(pid,)) for pid in ("a" * 16, "b" * 16)]
            for t in ts:
                t.start()
            for t in ts:
                t.join(10)
        self.assertEqual(sorted(i["id"] for i in self._items()), ["a" * 16, "b" * 16])

    def test_lock_file_is_released(self):
        send_mod._add_pending("sonnet2", "a" * 16, "haiku-fs2", self.state)
        self.assertFalse(self.path.with_name(self.path.name + ".lock").exists())

    def test_a_stale_lock_fails_open_rather_than_blocking_forever(self):
        # A process killed between creating the lock and unlinking it must not
        # make sending impossible for everyone after it.
        lock = self.path.with_name(self.path.name + ".lock")
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text("99999")
        with mock.patch.object(send_mod, "PENDING_LOCK_TIMEOUT", 0.05):
            send_mod._add_pending("sonnet2", "c" * 16, "haiku-fs2", self.state)
        self.assertEqual([i["id"] for i in self._items()], ["c" * 16])
        self.assertTrue(lock.exists())  # someone else's lock is left alone
