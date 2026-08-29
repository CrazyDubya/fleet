import subprocess
import tempfile
import unittest
from pathlib import Path

from fleet import registry as registry_mod, tmux
from fleet.bench import run as brun, tasks
from fleet.paths import ROOT, profile_state

LIVE = subprocess.run(["tmux", "has-session", "-t", "fleet2"], capture_output=True).returncode == 0


@unittest.skipUnless(LIVE, "tmux session fleet2 not running")
class BenchLiveTests(unittest.TestCase):
    def setUp(self):
        # Same guard pattern as test_v2_live.py: fleet.bench.run talks to tmux
        # and the registry directly (not through the CLI's activate_profile()),
        # so point both at the live v2/fleet2 profile ourselves rather than
        # the "fleet"/v1 defaults.
        tmux.use_session("fleet2")
        self._registry_path = registry_mod.DEFAULT_PATH
        registry_mod.DEFAULT_PATH = profile_state("v2") / "registry.json"

    def tearDown(self):
        tmux.use_session("fleet")
        registry_mod.DEFAULT_PATH = self._registry_path

    def test_lookup_task_on_fleet_arm(self):
        t = tasks.load_task(ROOT / "bench/tasks/lookup-newest-handoff.toml")
        with tempfile.TemporaryDirectory() as d:
            row = brun.run_one(t, "fleet", ROOT, Path(d) / "runs.jsonl")
        self.assertIn(row["status"], ("pass", "fail"), row.get("error"))
        self.assertIn("claude-sonnet-5", row["tokens"])  # sonnet2 answered; tokens attributed

    def test_lookup_task_on_sonnet_arm(self):
        t = tasks.load_task(ROOT / "bench/tasks/lookup-newest-handoff.toml")
        with tempfile.TemporaryDirectory() as d:
            row = brun.run_one(tasks.TaskSpec(**{**t.__dict__, "timeout_s": 120}), "sonnet", ROOT, Path(d) / "runs.jsonl")
        self.assertIn(row["status"], ("pass", "fail", "timeout"), row.get("error"))
        if row["status"] != "timeout":
            self.assertTrue(row["tokens"], "headless claude -p produced no transcript turns in the window")
