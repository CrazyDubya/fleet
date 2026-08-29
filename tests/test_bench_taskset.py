import re
import unittest
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
            for field in ("packet", "target", "check"):
                value = getattr(r, field)
                self.assertIsNone(
                    _PLACEHOLDER.search(value), f"{t.id}.{field} has an unresolved placeholder: {value!r}"
                )
            if t.judge:
                self.assertTrue((ROOT / t.judge).exists(), t.judge)
            self.assertIn("deadbeefdeadbeef", r.target)
        self.assertTrue((ROOT / "bench" / ".gitignore").read_text().strip() == "work/")
