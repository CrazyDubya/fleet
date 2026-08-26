import unittest
from pathlib import Path

from fleet.paths import ROOT

RULES = [
    "Message = handoff, file = memory",
    "Packets, not transcripts",
    "The prefix is frozen",
    "Deliberate misses are logged",
    "ledger/handoffs/",
    "fleet miss",
]


class BriefTests(unittest.TestCase):
    def test_every_brief_carries_the_protocol(self):
        for name in ("sonnet", "opus", "fable", "haiku-fs"):
            text = (ROOT / "briefs" / f"{name}.md").read_text()
            for rule in RULES:
                self.assertIn(rule, text, f"{name}.md missing rule {rule!r}")
            self.assertNotIn("placeholder", text)

    def test_map_exists_and_is_nontrivial(self):
        self.assertGreater(len((ROOT / "maps" / "repo.md").read_text()), 500)
