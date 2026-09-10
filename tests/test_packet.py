import time
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
        self.assertEqual(set(packet.LANES), {"lookup", "build", "plan", "judge", "consult", "verify"})
        self.assertEqual(packet.LANES["build"], packet.Lane(target="sonnet2", effort="med", tier="hot", reply="file"))
        self.assertEqual(packet.LANES["lookup"].tier, "tool")

    def test_verify_lane_routes_to_a_fresh_judge_agent(self):
        # Not muse2's own standing context - a verify packet routes exactly
        # like judge: fresh judge-lane agent, tool tier, file reply.
        self.assertEqual(packet.LANES["verify"], packet.Lane(target="judge", effort="med", tier="tool", reply="file"))

    def test_verify_packet_parses_without_raising(self):
        p = packet.parse("@to muse2  @from operator  @lane verify\nverify the glass re-grade")
        self.assertEqual((p.lane, p.effort, p.reply), ("verify", "med", "file"))

    def test_normalize_effort(self):
        self.assertEqual(packet.normalize_effort("med"), "medium")
        self.assertEqual(packet.normalize_effort("low"), "low")
        with self.assertRaises(ValueError):
            packet.normalize_effort("max")

    def test_new_id_is_sortable_and_unique(self):
        a, b = packet.new_id(), packet.new_id()
        self.assertEqual(len(a), 16)
        self.assertNotEqual(a, b)

    def test_new_id_sorts_by_time(self):
        a = packet.new_id()
        time.sleep(0.002)
        b = packet.new_id()
        self.assertLess(a, b)

    def test_new_id_keeps_the_whole_millisecond_prefix(self):
        # The prefix used to be truncated to its last 10 hex digits, so ids
        # either side of a carry into the 11th digit sorted backwards.
        i = packet.new_id()
        self.assertAlmostEqual(int(i[:11], 16), int(time.time() * 1000), delta=100)

    def test_unknown_lane_raises(self):
        with self.assertRaises(ValueError):
            packet.parse("@to sonnet2  @from operator  @lane plann\nbuild it")

    def test_missing_lane_still_defaults_to_build(self):
        p = packet.parse("@to sonnet2  @from operator\nbuild it")
        self.assertEqual((p.lane, p.effort, p.reply), ("build", "med", "file"))

    def test_normalize_effort_does_not_chain_the_keyerror(self):
        with self.assertRaises(ValueError) as cm:
            packet.normalize_effort("max")
        self.assertIsNone(cm.exception.__cause__)
        self.assertTrue(cm.exception.__suppress_context__)


    def test_extract_ledger_fields_recovers_hand_typed_packet(self):
        text = "@to sonnet4  @from operator  @lane build  @effort medium  @reply handoff  @id DISPATCH-LEDGER\n@done fleet outstanding exists\nbody"
        self.assertEqual(packet.extract_ledger_fields(text),
                          {"id": "DISPATCH-LEDGER", "lane": "build", "effort": "medium",
                           "reply": "handoff", "done": "fleet outstanding exists"})

    def test_extract_ledger_fields_on_plain_text_is_empty(self):
        self.assertEqual(packet.extract_ledger_fields("just a message"), {})
