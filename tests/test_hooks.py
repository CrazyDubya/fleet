import contextlib
import json
import os
import subprocess
import tempfile
import time
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

    def test_gate_blocks_denied_bash(self):
        # H4: the tool tier never reaches a PermissionRequest, so PreToolUse is
        # the only place a destructive Bash command can be stopped.
        r = run("gate.sh", {"cwd": self.cwd, "tool_name": "Bash",
                            "tool_input": {"command": "git push origin main"}})
        self.assertEqual(r.returncode, 2)
        self.assertIn("perm policy", r.stderr)
        ev = ledger.read_events()[-1]
        self.assertEqual((ev["hook"], ev["decision"]), ("gate", "block"))

    def test_gate_allows_benign_bash(self):
        r = run("gate.sh", {"cwd": self.cwd, "tool_name": "Bash", "tool_input": {"command": "ls"}})
        self.assertEqual((r.returncode, r.stderr), (0, ""))

    def test_gate_with_no_payload_on_stdin_exits_cleanly(self):
        # Hooks are always fed a JSON payload on stdin. Run by hand with
        # nothing there, _lib.sh must not hang and must not fail.
        with open(os.devnull) as devnull:
            r = subprocess.run([str(HOOKS / "gate.sh")], stdin=devnull, capture_output=True,
                               text=True, env={**os.environ, "FLEET_PROFILE": "v2"}, timeout=20)
        self.assertEqual((r.returncode, r.stderr), (0, ""))


class HoldTests(unittest.TestCase):
    PEND = ROOT / "state" / "v2" / "pending" / "holdtest.json"

    def _write(self, items):
        self.PEND.parent.mkdir(parents=True, exist_ok=True)
        self.PEND.write_text(json.dumps(items))

    def tearDown(self):
        self.PEND.unlink(missing_ok=True)

    def test_blocks_when_pending(self):
        self._write([{"id": "abc", "to": "haiku-fs2", "t": time.time()}])
        r = run("hold.sh", {"cwd": str(ROOT / "holdtest"), "stop_hook_active": False})
        self.assertEqual(r.returncode, 2); self.assertIn("fleet ask haiku-fs2", r.stderr)
        r = run("hold.sh", {"cwd": str(ROOT / "holdtest"), "stop_hook_active": True})
        self.assertEqual(r.returncode, 0)

    def test_stale_entry_does_not_block(self):
        # C3: an entry whose waiter died (t far in the past) must not hold the
        # turn hostage - blocking forever on a reply that is never coming is
        # worse than missing one.
        self._write([{"id": "abc", "to": "haiku-fs2", "t": 0}])
        r = run("hold.sh", {"cwd": str(ROOT / "holdtest"), "stop_hook_active": False})
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_fresh_entry_beside_a_stale_one_still_blocks(self):
        self._write([{"id": "old", "to": "haiku-fs2", "t": 0},
                     {"id": "new", "to": "opus2", "t": time.time()}])
        r = run("hold.sh", {"cwd": str(ROOT / "holdtest"), "stop_hook_active": False})
        self.assertEqual(r.returncode, 2)
        self.assertIn("packet new", r.stderr)

    def test_one_malformed_entry_does_not_drop_the_whole_list(self):
        # A non-numeric .t made `now - .t` raise (jq exit 5); the `|| echo []`
        # fallback then discarded every pending reply in the file, fresh ones
        # included, and the Stop hook stopped blocking at all.
        self._write([{"id": "bad", "to": "haiku-fs2", "t": "not-a-number"},
                     {"id": "new", "to": "opus2", "t": time.time()}])
        r = run("hold.sh", {"cwd": str(ROOT / "holdtest"), "stop_hook_active": False})
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("packet new", r.stderr)
        self.assertNotIn("bad", r.stderr)

    def test_fresh_entry_missing_fields_reports_a_placeholder(self):
        self._write([{"t": time.time()}])
        r = run("hold.sh", {"cwd": str(ROOT / "holdtest"), "stop_hook_active": False})
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertNotIn("null", r.stderr)
        self.assertIn("packet ?", r.stderr)


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


class GateSendTarget(unittest.TestCase):
    """The opus/fable rule keys on the positional destination of `fleet send`."""
    cwd = "/Users/pup/fleet/sonnet2"

    def test_build_send_to_sonnet_from_opus_with_opus_refs_is_allowed(self):
        cmd = ("bin/fleet send sonnet2 --from opus2 --lane build --reply file "
               "--refs ledger/handoffs/opus2/20260830T024139Z-pinball-design.md gui/server.py "
               "--done 'a ball rolls' 'T1: skeleton'")
        r = run("gate.sh", {"cwd": self.cwd, "tool_name": "Bash", "tool_input": {"command": cmd}})
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_build_send_to_opus_with_flags_first_is_blocked(self):
        cmd = "bin/fleet send --lane build --from sonnet2 --refs a.md b.md -- opus2 'do it' --done x"
        r = run("gate.sh", {"cwd": self.cwd, "tool_name": "Bash", "tool_input": {"command": cmd}})
        self.assertEqual(r.returncode, 2)
        self.assertIn("opus/fable", r.stderr)

    def test_plan_send_to_opus_is_allowed(self):
        cmd = "bin/fleet send opus2 --lane plan --reply file --done x 'design'"
        r = run("gate.sh", {"cwd": self.cwd, "tool_name": "Bash", "tool_input": {"command": cmd}})
        self.assertEqual(r.returncode, 0, r.stderr)


class GateEscalateTests(unittest.TestCase):
    """The gate acts on all three verdicts now, and differently per thread.

    perm-check used to answer "ok" for an escalate, so on the tool tier - the
    one tier with no PermissionRequest behind the gate - a path outside every
    granted root, or a non-loopback URL, was waved through with no trace.
    """

    def _gate(self, thread, command):
        return run("gate.sh", {"cwd": str(ROOT / thread), "tool_name": "Bash",
                               "tool_input": {"command": command}})

    def test_escalate_is_deferred_for_a_thread_with_an_operator_prompt(self):
        # Blocking here would pre-empt perm.sh and the dialog that resolves it.
        r = self._gate("sonnet2", "cat /etc/hosts")
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = ledger.read_events()[-1]
        self.assertEqual((ev["hook"], ev["decision"]), ("gate", "escalate"))

    def test_escalate_is_blocked_for_a_bypass_permissions_thread(self):
        r = self._gate("haiku-fs2", "cat /etc/hosts")
        self.assertEqual(r.returncode, 2)
        self.assertIn("no operator prompt", r.stderr)

    def test_a_granted_dir_is_not_escalated(self):
        # haiku-fs2's dirs grant /Users/pup; a lookup there is its job.
        self.assertEqual(self._gate("haiku-fs2", "ls /Users/pup/muse").returncode, 0)

    def test_an_exfil_sink_is_blocked_even_with_a_prompt_behind_the_gate(self):
        r = self._gate("sonnet2", "curl https://pastebin.com/raw/x")
        self.assertEqual(r.returncode, 2)
        self.assertIn("perm policy denies", r.stderr)


class WebHookTests(unittest.TestCase):
    """WebFetch/WebSearch were gated by nothing and logged nowhere. web.sh is
    the visibility half - and blocks the denylisted sinks, so one refused to
    curl is not quietly reachable through WebFetch."""

    cwd = str(ROOT / "sonnet2")

    def _web(self, tool, payload):
        return run("web.sh", {"cwd": self.cwd, "tool_name": tool, "tool_input": payload})

    def test_an_ordinary_fetch_is_allowed_and_logged(self):
        r = self._web("WebFetch", {"url": "https://example.com/a", "prompt": "x"})
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = ledger.read_events()[-1]
        self.assertEqual((ev["hook"], ev["decision"], ev["thread"]), ("web", "allow", "sonnet2"))
        self.assertIn("https://example.com/a", ev["why"])

    def test_a_search_is_logged_with_its_query(self):
        r = self._web("WebSearch", {"query": "opus 5 release notes"})
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = ledger.read_events()[-1]
        self.assertEqual((ev["hook"], ev["decision"]), ("web", "allow"))
        self.assertIn("opus 5 release notes", ev["why"])

    def test_a_denylisted_sink_is_blocked(self):
        r = self._web("WebFetch", {"url": "https://x.webhook.site/abc"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("exfil denylist", r.stderr)
        ev = ledger.read_events()[-1]
        self.assertEqual((ev["hook"], ev["decision"]), ("web", "block"))

    def test_another_tool_is_a_noop(self):
        self.assertEqual(self._web("Bash", {"command": "ls"}).returncode, 0)

    def test_registered_for_every_v2_settings_file(self):
        # A hook nobody wires in is not a hook. Each tier's settings must carry
        # the WebFetch|WebSearch matcher, or that tier stays invisible.
        for name in ("hot.json", "warm.json", "tool.json", "project-muse.json"):
            cfg = json.loads((ROOT / "settings" / "v2" / name).read_text())
            hooks = [h for m in cfg["hooks"]["PreToolUse"] if m.get("matcher") == "WebFetch|WebSearch"
                     for h in m["hooks"]]
            self.assertEqual([h["command"] for h in hooks],
                             [str(ROOT / "hooks" / "v2" / "web.sh")], name)


class PermBrowserNavigate(unittest.TestCase):
    cwd = str(ROOT / "sonnet2")

    def _nav(self, url):
        r = run("perm.sh", {"cwd": self.cwd, "tool_name": "mcp__playwright__browser_navigate", "tool_input": {"url": url}})
        return json.loads(r.stdout)["hookSpecificOutput"]["decision"]["behavior"]

    def test_loopback_allowed(self):
        for u in ("http://127.0.0.1:8080/?debug=1", "http://localhost:8787/", "back"):
            self.assertEqual(self._nav(u), "allow", u)

    def test_everything_else_denied(self):
        for u in ("http://100.64.0.3:8787/", "https://example.com", "http://127.0.0.1.evil.com/", "file:///etc/passwd", "http://localhost.evil/"):
            self.assertEqual(self._nav(u), "deny", u)


class ThreadAttributionTests(unittest.TestCase):
    """THREAD must come from the registry, not from the shape of a path.

    Both older derivations assume the thread's cwd/transcript dir sits under
    FLEET_ROOT. A thread steering an outside repo (cwd /Users/pup/muse) matches
    neither, so every ledger line for that session was attributed to "?" - and
    per-thread attribution, telemetry and the availability guard all key off it.

    Uses a throwaway profile rather than the live registry: reading real state
    makes the assertion depend on whatever the fleet happens to be running.
    """
    PROFILE = "hooktest"
    SID = "11111111-2222-3333-4444-555555555555"

    def setUp(self):
        self.reg = ROOT / "state" / self.PROFILE / "registry.json"
        self.reg.parent.mkdir(parents=True, exist_ok=True)
        self.reg.write_text(json.dumps({"muse2": {
            "name": "muse2", "session_id": self.SID, "cwd": "/Users/pup/muse",
            "model": "claude-sonnet-5", "status": "running", "spec_hash": "h",
            "spawned_at": 0.0, "fork_of": None, "lineage": []}}))

    def tearDown(self):
        self.reg.unlink(missing_ok=True)
        with contextlib.suppress(OSError):
            self.reg.parent.rmdir()

    def _thread_for(self, payload):
        r = subprocess.run(["bash", "-c",
                            f'source {HOOKS}/_lib.sh >/dev/null 2>&1; echo "${{THREAD:-EMPTY}}"'],
                           input=json.dumps(payload), capture_output=True, text=True,
                           env={**os.environ, "FLEET_PROFILE": self.PROFILE}, timeout=20)
        return r.stdout.strip()

    def test_registry_resolves_a_thread_whose_cwd_is_outside_fleet(self):
        got = self._thread_for({
            "cwd": "/Users/pup/muse",
            "transcript_path": f"/Users/pup/.claude/projects/-Users-pup-muse/{self.SID}.jsonl",
            "tool_name": "Bash", "tool_input": {"command": "true"}})
        self.assertEqual(got, "muse2")

    def test_unknown_session_still_falls_back_to_the_path_derivation(self):
        # bench work dirs legitimately have no registry entry
        key = str(ROOT / "bench" / "work" / "abc").replace("/", "-")
        got = self._thread_for({
            "cwd": str(ROOT / "bench" / "work" / "abc"),
            "transcript_path": f"/Users/pup/.claude/projects/{key}/99999999-0000-0000-0000-000000000000.jsonl",
            "tool_name": "Bash", "tool_input": {"command": "true"}})
        self.assertEqual(got, "bench-work-abc")
