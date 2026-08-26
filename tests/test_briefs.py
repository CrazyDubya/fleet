import unittest
from pathlib import Path

from fleet.paths import ROOT

THREADS = ("sonnet", "opus", "fable", "haiku-fs")

RULES = [
    "Message = handoff, file = memory",
    "Packets, not transcripts",
    "The prefix is frozen",
    "Deliberate misses are logged",
    "Tier rules",
    "Independence when it matters",
    "ledger/handoffs/",
    "fleet miss",
    "not authentication",
]


def _protocol_block(text: str) -> str:
    """Everything a brief carries before its own `## Role:` heading."""
    return text.split("\n## Role:")[0]


class BriefTests(unittest.TestCase):
    def test_every_brief_carries_the_protocol(self):
        for name in THREADS:
            text = (ROOT / "briefs" / f"{name}.md").read_text()
            for rule in RULES:
                self.assertIn(rule, text, f"{name}.md missing rule {rule!r}")
            self.assertNotIn("placeholder", text)

    def test_the_protocol_block_is_byte_identical_everywhere(self):
        # The block is the shared, cached prefix of every thread. A brief that
        # drifts by one byte is a different prefix - threads would be working
        # from different rules while status still called the prefix frozen.
        canonical = (ROOT / "briefs" / "_protocol.md").read_text().rstrip("\n")
        for name in THREADS:
            block = _protocol_block((ROOT / "briefs" / f"{name}.md").read_text()).rstrip("\n")
            self.assertEqual(block, canonical, f"{name}.md's protocol block has drifted")

    def test_every_brief_has_its_own_role_section(self):
        for name in THREADS:
            self.assertIn(f"## Role: {name}", (ROOT / "briefs" / f"{name}.md").read_text())

    def test_map_exists_and_is_nontrivial(self):
        self.assertGreater(len((ROOT / "maps" / "repo.md").read_text()), 500)
