import tempfile
import unittest
from pathlib import Path

from fleet import decisions


class DecisionsMdTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "DECISIONS.md"

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_file_is_missing_not_empty(self):
        r = decisions.read_decisions(self.path)
        self.assertEqual(r.decisions_status, "missing")
        self.assertEqual(r.decisions, [])

    def test_present_with_no_sections_is_empty(self):
        self.path.write_text("# Decisions\n\nNothing here yet.\n")
        r = decisions.read_decisions(self.path)
        self.assertEqual(r.decisions_status, "empty")

    def test_fully_answered_with_no_new_sections_is_answered(self):
        self.path.write_text(
            "# Decisions — ANSWERED 2026-09-07\n\n"
            "1: yes · 2: no.\n\n---\n\n"
            "## 1. FIRST\n\n**What.** thing one.\n\n"
            "## 2. SECOND\n\n**What.** thing two.\n"
        )
        r = decisions.read_decisions(self.path)
        self.assertEqual(r.decisions_status, "answered")
        self.assertEqual(r.decisions, [])
        self.assertIn("ANSWERED", r.decisions_resolved_note)

    def test_a_fresh_item_appended_above_an_answered_summary_is_pending(self):
        # The real, observed shape: a header still reading "ANSWERED" with a
        # summary covering items 1-2, but a NEW item 3 has been appended.
        self.path.write_text(
            "# Decisions — ANSWERED 2026-09-07\n\n"
            "1: yes · 2: no.\n\n---\n\n"
            "## 3. THIRD\n\n**What.** a brand new thing.\n\n"
            "**Where.** /Users/pup/fleet/ledger/handoffs/sonnet2/x.md\n\n"
            "**Options.** a or b.\n\n**Recommendation.** a.\n\n**Reply with:** a or b.\n\n"
            "---\n\n# Original brief\n\n"
            "## 1. FIRST\n\n**What.** thing one.\n\n"
            "## 2. SECOND\n\n**What.** thing two.\n"
        )
        r = decisions.read_decisions(self.path)
        self.assertEqual(r.decisions_status, "pending")
        [d] = r.decisions
        self.assertEqual(d.n, "3")
        self.assertEqual(d.title, "THIRD")
        self.assertIn("brand new", d.what)
        self.assertEqual(d.options, "a or b.")
        self.assertEqual(d.reply_with, "a or b.")

    def test_no_answered_header_means_every_section_is_pending(self):
        self.path.write_text(
            "# Decisions\n\n## 1. ONE\n\n**What.** x.\n\n## 2. TWO\n\n**What.** y.\n"
        )
        r = decisions.read_decisions(self.path)
        self.assertEqual(r.decisions_status, "pending")
        self.assertEqual([d.n for d in r.decisions], ["1", "2"])

    def test_links_only_resolve_under_ledger_handoffs(self):
        self.path.write_text(
            "# Decisions\n\n## 1. ONE\n\n"
            "**Where.** /Users/pup/fleet/ledger/handoffs/opus2/x.md and "
            "/Users/pup/cognitive/project1/notes.md\n"
        )
        r = decisions.read_decisions(self.path)
        [d] = r.decisions
        by_path = {l.path: l.rel for l in d.links}
        self.assertEqual(by_path["/Users/pup/fleet/ledger/handoffs/opus2/x.md"],
                          "ledger/handoffs/opus2/x.md")
        self.assertIsNone(by_path["/Users/pup/cognitive/project1/notes.md"])


class OpenRowsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "OPEN.md"

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_file_is_missing(self):
        status, rows = decisions.read_open_rows(self.path)
        self.assertEqual(status, "missing")
        self.assertEqual(rows, [])

    def test_only_operator_to_user_rows_are_kept(self):
        self.path.write_text(
            "# Open\n\n| id | thread | expects | notes |\n|---|---|---|---|\n"
            "| FOO | sonnet2 | ship it | - |\n"
            "| GROK-QUOTA | operator → user | balance | reset unknown |\n"
        )
        status, rows = decisions.read_open_rows(self.path)
        self.assertEqual(status, "ok")
        self.assertEqual([r.id for r in rows], ["GROK-QUOTA"])
        self.assertEqual(rows[0].expects, "balance")

    def test_no_pending_is_a_clean_ok_empty_list(self):
        self.path.write_text(
            "# Open\n\n| id | thread | expects | notes |\n|---|---|---|---|\n"
            "| FOO | sonnet2 | ship it | - |\n"
        )
        status, rows = decisions.read_open_rows(self.path)
        self.assertEqual((status, rows), ("ok", []))


class ReadTests(unittest.TestCase):
    def test_the_real_files_parse(self):
        # Not a fixture - a format drift in either real file should break
        # this test rather than the gui silently reading 0 pending forever.
        r = decisions.read()
        self.assertIn(r.decisions_status, ("missing", "unreadable", "empty", "answered", "pending"))
        self.assertIn(r.open_status, ("missing", "unreadable", "ok"))


if __name__ == "__main__":
    unittest.main()
