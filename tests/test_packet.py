import unittest

from fleet import packet


class PacketTests(unittest.TestCase):
    def test_round_trip(self):
        p = packet.Packet(to="sonnet2", sender="operator", lane="build", effort="med", reply="file",
                          refs=["ledger/handoffs/opus/x.md"], done="gui serves /w/status/", id="01ABC", body="Build it.")
        text = packet.format_packet(p)
        self.assertTrue(text.startswith("@to sonnet2  @from operator  @lane build  @effort med  @reply file  @id 01ABC\n"))
        self.assertIn("@refs ledger/handoffs/opus/x.md\n", text)
        self.assertIn("@done gui serves /w/status/\n", text)
        self.assertTrue(text.endswith("Build it."))
        self.assertEqual(packet.parse(text), p)

    def test_parse_plain_text_is_none(self):
        self.assertIsNone(packet.parse("just a message"))

    def test_parse_reply(self):
        text = "@from sonnet2  @re 01ABC  @status done  @out ledger/handoffs/sonnet2/x.md\nURL is http://x"
        r = packet.parse(text)
        self.assertEqual(r, packet.Reply(sender="sonnet2", re="01ABC", status="done",
                                         out="ledger/handoffs/sonnet2/x.md", body="URL is http://x"))
        self.assertEqual(packet.format_reply(r), text)

    def test_lane_defaults_fill_missing_fields(self):
        p = packet.parse("@to haiku-fs2  @from sonnet2  @lane lookup\nnewest handoff?")
        self.assertEqual(p.effort, "low")
        self.assertEqual(p.reply, "inline")
        self.assertEqual(p.refs, [])
        self.assertIsNone(p.done)

    def test_lane_table(self):
        self.assertEqual(set(packet.LANES), {"lookup", "build", "plan", "judge", "consult"})
        self.assertEqual(packet.LANES["build"], packet.Lane(target="sonnet2", effort="med", tier="hot", reply="file"))
        self.assertEqual(packet.LANES["lookup"].tier, "tool")

    def test_normalize_effort(self):
        self.assertEqual(packet.normalize_effort("med"), "medium")
        self.assertEqual(packet.normalize_effort("low"), "low")
        with self.assertRaises(ValueError):
            packet.normalize_effort("max")

    def test_new_id_is_sortable_and_unique(self):
        a, b = packet.new_id(), packet.new_id()
        self.assertEqual(len(a), 16)
        self.assertNotEqual(a, b)
