import tempfile
import unittest
from pathlib import Path

from fleet import backlog


class BacklogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "OPEN.md"

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_file_is_missing_not_empty(self):
        b = backlog.read(self.path)
        self.assertEqual(b.file_status, "missing")
        self.assertEqual(b.items, [])

    def test_unreadable_file_is_unreadable_not_empty(self):
        self.path.touch()
        self.path.chmod(0o000)
        try:
            from unittest import mock
            with mock.patch("fleet.ledger.status", return_value="unreadable"):
                b = backlog.read(self.path)
            self.assertEqual(b.file_status, "unreadable")
        finally:
            self.path.chmod(0o644)

    def test_present_with_no_table_is_ok_and_empty(self):
        self.path.write_text("# Open assignments\n\nNothing queued right now.\n")
        b = backlog.read(self.path)
        self.assertEqual(b.file_status, "ok")
        self.assertEqual(b.count, 0)

    def test_table_with_zero_data_rows_is_ok_and_empty(self):
        self.path.write_text("# Open assignments\n\n| id | thread | expects | notes |\n|---|---|---|---|\n")
        b = backlog.read(self.path)
        self.assertEqual(b.file_status, "ok")
        self.assertEqual(b.count, 0)

    def test_table_rows_are_parsed(self):
        self.path.write_text(
            "# Open assignments\n\n"
            "| id | thread | expects | notes |\n"
            "|---|---|---|---|\n"
            "| FOO | sonnet2 | ship it | none |\n"
            "| BAR | opus2 | design it | urgent |\n"
        )
        b = backlog.read(self.path)
        self.assertEqual(b.count, 2)
        self.assertEqual([i.id for i in b.items], ["FOO", "BAR"])
        self.assertEqual(b.items[0].thread, "sonnet2")
        self.assertEqual(b.items[1].notes, "urgent")

    def test_rows_after_a_level2_heading_are_not_counted(self):
        self.path.write_text(
            "# Open assignments\n\n"
            "| id | thread | expects | notes |\n"
            "|---|---|---|---|\n"
            "| FOO | sonnet2 | ship it | none |\n"
            "\n## Closed\n\n"
            "| id | thread | expects | notes |\n"
            "|---|---|---|---|\n"
            "| DONE-ONE | muse2 | already landed | - |\n"
        )
        b = backlog.read(self.path)
        self.assertEqual([i.id for i in b.items], ["FOO"])

    def test_real_file_parses(self):
        # Not a fixture - the actual file this module exists to read, so a
        # format drift in it breaks this test rather than silently reading
        # as "0 open" the next time someone runs the watchdog.
        b = backlog.read(backlog.DEFAULT_PATH)
        if b.file_status != "ok":
            self.skipTest(f"OPEN.md not present in this checkout: {b.file_status}")
        self.assertGreater(b.count, 0)
        self.assertTrue(all(i.id for i in b.items))


class CliBacklogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "OPEN.md"

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, *argv):
        from fleet.cli import cmd_backlog, _build_parser
        args = _build_parser().parse_args(["backlog", *argv])
        return cmd_backlog(args)

    def test_path_flag_reaches_a_missing_file(self):
        self.assertEqual(self._run("--path", str(self.path)), 1)

    def test_path_flag_reaches_an_empty_backlog(self):
        self.path.write_text("# Open assignments\n\n| id | thread | expects | notes |\n|---|---|---|---|\n")
        self.assertEqual(self._run("--path", str(self.path)), 0)

    def test_path_flag_reaches_a_populated_backlog(self):
        self.path.write_text(
            "# Open assignments\n\n| id | thread | expects | notes |\n|---|---|---|---|\n"
            "| FOO | sonnet2 | ship it | - |\n"
        )
        self.assertEqual(self._run("--path", str(self.path)), 0)


if __name__ == "__main__":
    unittest.main()
