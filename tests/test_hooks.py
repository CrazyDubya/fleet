import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from fleet import ledger
from fleet.paths import ROOT

HOOKS = ROOT / "hooks" / "v2"


def run(script, payload, env=None):
    e = {**os.environ, "FLEET_PROFILE": "v2", **(env or {})}
    return subprocess.run([str(HOOKS / script)], input=json.dumps(payload), capture_output=True, text=True, env=e, timeout=20)


class GateTests(unittest.TestCase):
    cwd = str(ROOT / "sonnet2")

    def test_blocks_sendmessage_to_haiku(self):
        r = run("gate.sh", {"cwd": self.cwd, "tool_name": "SendMessage", "tool_input": {"to": "haiku-fs2", "message": "x"}})
        self.assertEqual(r.returncode, 2); self.assertIn("fleet ask", r.stderr)

    def test_blocks_opus_without_lane(self):
        r = run("gate.sh", {"cwd": self.cwd, "tool_name": "SendMessage", "tool_input": {"to": "opus2", "message": "@to opus2\nplan?"}})
        self.assertEqual(r.returncode, 2)

    def test_allows_opus_with_plan_lane(self):
        r = run("gate.sh", {"cwd": self.cwd, "tool_name": "SendMessage", "tool_input": {"to": "opus2", "message": "@to opus2  @lane plan\n@done x\nplan"}})
        self.assertEqual(r.returncode, 0)

    def test_ledger_line_written(self):
        run("gate.sh", {"cwd": self.cwd, "tool_name": "Bash", "tool_input": {"command": "ls"}})
        ev = ledger.read_events()[-1]
        self.assertEqual((ev["ev"], ev["hook"], ev["thread"], ev["decision"]), ("hook", "gate", "sonnet2", "allow"))

    def test_non_fleet_cwd_is_noop(self):
        r = run("gate.sh", {"cwd": "/Users/pup/elsewhere", "tool_name": "SendMessage", "tool_input": {"to": "haiku-fs2", "message": "x"}})
        self.assertEqual(r.returncode, 0)

    def test_thread_from_transcript_path_when_cwd_is_root(self):
        r = run("gate.sh", {
            "cwd": str(ROOT),
            "transcript_path": "/Users/pup/.claude/projects/-Users-pup-fleet-sonnet2/x.jsonl",
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
        })
        self.assertEqual(r.returncode, 0)
        ev = ledger.read_events()[-1]
        self.assertEqual(ev["thread"], "sonnet2")

    def test_thread_falls_back_to_cwd_without_transcript_path(self):
        r = run("gate.sh", {"cwd": self.cwd, "tool_name": "Bash", "tool_input": {"command": "ls"}})
        self.assertEqual(r.returncode, 0)
        ev = ledger.read_events()[-1]
        self.assertEqual(ev["thread"], "sonnet2")


class HoldTests(unittest.TestCase):
    def test_blocks_when_pending(self):
        pend = ROOT / "state" / "v2" / "pending" / "holdtest.json"
        pend.parent.mkdir(parents=True, exist_ok=True)
        pend.write_text(json.dumps([{"id": "abc", "to": "haiku-fs2", "t": 0}]))
        try:
            r = run("hold.sh", {"cwd": str(ROOT / "holdtest"), "stop_hook_active": False})
            self.assertEqual(r.returncode, 2); self.assertIn("fleet ask haiku-fs2", r.stderr)
            r = run("hold.sh", {"cwd": str(ROOT / "holdtest"), "stop_hook_active": True})
            self.assertEqual(r.returncode, 0)
        finally:
            pend.unlink()


class PermTests(unittest.TestCase):
    def test_auto_allow_emits_allow_json(self):
        r = run("perm.sh", {"cwd": str(ROOT / "sonnet2"), "tool_name": "Bash", "tool_input": {"command": "ls /Users/pup/fleet/gui"}})
        self.assertEqual(json.loads(r.stdout)["hookSpecificOutput"]["decision"]["behavior"], "allow")

    def test_deny_emits_deny_json(self):
        r = run("perm.sh", {"cwd": str(ROOT / "sonnet2"), "tool_name": "Bash", "tool_input": {"command": "git push origin main"}})
        self.assertEqual(json.loads(r.stdout)["hookSpecificOutput"]["decision"]["behavior"], "deny")

    def test_non_bash_falls_through(self):
        r = run("perm.sh", {"cwd": str(ROOT / "sonnet2"), "tool_name": "Write", "tool_input": {}})
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_perm_decides_when_cwd_is_root(self):
        r = run("perm.sh", {
            "cwd": str(ROOT),
            "transcript_path": "/Users/pup/.claude/projects/-Users-pup-fleet-sonnet2/x.jsonl",
            "tool_name": "Bash",
            "tool_input": {"command": "ls /Users/pup/fleet/gui"},
        })
        self.assertEqual(json.loads(r.stdout)["hookSpecificOutput"]["decision"]["behavior"], "allow")

    def test_perm_script_has_no_diag_line(self):
        self.assertNotIn("TEMP DIAG", (HOOKS / "perm.sh").read_text())


class RouterTests(unittest.TestCase):
    def test_plain_prompt_noop(self):
        r = run("router.sh", {"cwd": str(ROOT / "sonnet2"), "prompt": "hello"})
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_packet_prompt_without_router_logs_allow(self):
        # FLEET_PROFILE=v1 points `fleet ask haiku-router2` at tmux session
        # "fleet" (the live v1 fleet), which has no "haiku-router2" window,
        # so `ask` fails immediately (SendError -> exit 1) via a read-only
        # `tmux list-windows` check - never touching a live window - instead
        # of relying on tmux session "fleet2" not existing, which Task 9
        # brings up. (An invalid profile, e.g. FLEET_PROFILE=nosuchprofile,
        # looks tempting here but does not work: cli.main() calls
        # activate_profile() for every subcommand, so the KeyError it raises
        # also kills the hooks/v2/_lib.sh `ledger()` helper's own
        # `fleet hook-event` call below - no event to assert on. Confirmed
        # by hand: with FLEET_PROFILE=nosuchprofile, running router.sh's
        # `ledger router allow ...` never appends a new ledger line.)
        r = run("router.sh", {"cwd": str(ROOT / "sonnet2"), "prompt": "@to opus2\nplan this"},
                env={"FLEET_PROFILE": "v1"})
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        ev = ledger.read_events()[-1]
        self.assertEqual((ev["hook"], ev["decision"], ev["thread"]), ("router", "allow", "sonnet2"))
