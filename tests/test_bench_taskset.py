import re
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from fleet.bench import tasks
from fleet.paths import ROOT

# {run} {target} {refs} {root} are the only fleet-bench placeholders; a bare
# "{" is not by itself a sign of an unresolved placeholder since checks/packets
# may legitimately contain literal JSON (e.g. a curl -d payload).
_PLACEHOLDER = re.compile(r"\{(run|target|refs|root)\}")


class TaskSetTests(unittest.TestCase):
    def test_four_lane_tasks_load_and_substitute(self):
        ts = tasks.load_all(ROOT / "bench" / "tasks")
        self.assertEqual(sorted(t.lane for t in ts), ["build", "judge", "lookup", "plan"])
        for t in ts:
            r = tasks.substitute(t, "deadbeefdeadbeef", ROOT)
            for field in ("packet", "target", "check", "expect"):
                value = getattr(r, field)
                if value is None:
                    continue
                self.assertIsNone(
                    _PLACEHOLDER.search(value), f"{t.id}.{field} has an unresolved placeholder: {value!r}"
                )
            if t.judge:
                self.assertTrue((ROOT / t.judge).exists(), t.judge)
            self.assertIn("deadbeefdeadbeef", r.target)
        self.assertTrue((ROOT / "bench" / ".gitignore").read_text().strip() == "work/")

    def test_every_shell_field_parses(self):
        for t in tasks.load_all(ROOT / "bench" / "tasks"):
            r = tasks.substitute(t, "deadbeefdeadbeef", ROOT)
            for field in ("expect", "check", "cleanup"):
                value = getattr(r, field)
                if value is None:
                    continue
                # {expect} is filled in later by with_expect(); stand something in for `sh -n`
                script = value.replace("{expect}", "X")
                rc = subprocess.run(["sh", "-n"], input=script, text=True, capture_output=True)
                self.assertEqual(rc.returncode, 0, f"{t.id}.{field}: {rc.stderr.strip()}")

    def test_lookup_expect_errors_on_an_empty_handoff_tree(self):
        # `ls -t` with no operands lists the cwd, so an unguarded expect would pin a bogus
        # answer and score a correct run a fail; exiting non-zero makes it an error row.
        t = next(t for t in tasks.load_all(ROOT / "bench" / "tasks") if t.id == "lookup-newest-handoff")
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); (root / "ledger" / "handoffs").mkdir(parents=True)
            cmd = tasks.substitute(t, "deadbeefdeadbeef", root).expect
            self.assertNotEqual(subprocess.run(cmd, shell=True, capture_output=True).returncode, 0)
            (root / "ledger" / "handoffs" / "a.md").write_text("x")
            r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            self.assertEqual((r.returncode, r.stdout.strip()), (0, "ledger/handoffs/a.md"))

    def test_expect_placeholder_without_an_expect_command_is_rejected(self):
        # otherwise a literal "{expect}" reaches a shell=True check as if it were the answer
        t = next(t for t in tasks.load_all(ROOT / "bench" / "tasks") if t.id == "lookup-newest-handoff")
        with self.assertRaises(ValueError):
            tasks.substitute(replace(t, expect=None), "deadbeefdeadbeef", ROOT)
        with self.assertRaises(ValueError):
            tasks.substitute(replace(t, expect=None, check="true", cleanup="rm -rf {expect}"), "deadbeefdeadbeef", ROOT)
        tasks.substitute(replace(t, expect=None, check="true", cleanup=None), "deadbeefdeadbeef", ROOT)  # no placeholder: fine

