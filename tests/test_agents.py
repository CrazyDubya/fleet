import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from fleet import agents


def claude_session(root: Path, key: str, sid: str, cwd: str, model="claude-sonnet-5", age_s=0.0):
    d = root / key
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{sid}.jsonl"
    f.write_text("\n".join([
        json.dumps({"type": "last-prompt", "sessionId": sid}),          # no cwd on the first record
        json.dumps({"type": "attachment", "cwd": cwd, "sessionId": sid}),
        json.dumps({"type": "assistant", "message": {"model": model}}),
    ]) + "\n")
    if age_s:
        t = time.time() - age_s
        os.utime(f, (t, t))
    return f


def codex_session(root: Path, sid: str, cwd: str, model="gpt-5.6-sol", age_s=0.0):
    d = root / "2026" / "09" / "03"
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"rollout-2026-09-03T00-00-00-{sid}.jsonl"
    f.write_text("\n".join([
        json.dumps({"type": "session_meta", "payload": {"id": sid, "cwd": cwd, "originator": "codex-tui"}}),
        json.dumps({"type": "turn_context", "payload": {"cwd": cwd, "model": model}}),
    ]) + "\n")
    if age_s:
        t = time.time() - age_s
        os.utime(f, (t, t))
    return f


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cl = self.root / "claude"
        self.cx = self.root / "codex"

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, **kw):
        return agents.scan(claude_root=self.cl, codex_root=self.cx, **kw)

    def test_finds_both_vendors_keyed_by_cwd(self):
        claude_session(self.cl, "-Users-pup-muse", "s1", "/Users/pup/muse")
        codex_session(self.cx, "c1", "/Users/pup/muse")
        by = agents.by_cwd(self.scan())
        self.assertEqual(sorted(a.agent for a in by["/Users/pup/muse"]), ["claude", "codex"])

    def test_cwd_is_read_from_the_record_not_the_directory_name(self):
        # the project-dir name is a lossy encoding of the path (slashes -> dashes),
        # so a real path containing a dash cannot be recovered from it
        claude_session(self.cl, "-Users-pup-my-repo", "s1", "/Users/pup/my-repo")
        self.assertEqual(self.scan()[0].cwd, "/Users/pup/my-repo")

    def test_model_is_captured_for_both(self):
        claude_session(self.cl, "-p", "s1", "/p", model="claude-fable-5")
        codex_session(self.cx, "c1", "/p", model="gpt-5.6-sol")
        self.assertEqual({a.model for a in self.scan()}, {"claude-fable-5", "gpt-5.6-sol"})

    def test_missing_store_is_not_an_error(self):
        codex_session(self.cx, "c1", "/p")
        self.assertEqual(len(self.scan()), 1)  # no claude dir at all

    def test_transcript_with_no_cwd_is_skipped_not_crashed(self):
        d = self.cl / "-p"; d.mkdir(parents=True)
        (d / "s1.jsonl").write_text(json.dumps({"type": "x"}) + "\nnot json at all\n")
        self.assertEqual(self.scan(), [])

    def test_since_bounds_by_mtime(self):
        claude_session(self.cl, "-p", "old", "/p", age_s=10_000)
        claude_session(self.cl, "-p", "new", "/p")
        self.assertEqual([a.session for a in self.scan(since=time.time() - 100)], ["new"])


class InterlockTests(unittest.TestCase):
    """live_on is the dispatch interlock: two writers in one dirty tree lose edits."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cl, self.cx = self.root / "c", self.root / "x"

    def tearDown(self):
        self.tmp.cleanup()

    def acts(self):
        return agents.scan(claude_root=self.cl, codex_root=self.cx)

    def test_recent_foreign_session_blocks(self):
        codex_session(self.cx, "c1", "/Users/pup/muse", age_s=10)
        live = agents.live_on("/Users/pup/muse", time.time(), activities=self.acts())
        self.assertEqual([a.agent for a in live], ["codex"])

    def test_stale_session_does_not_block(self):
        codex_session(self.cx, "c1", "/Users/pup/muse", age_s=agents.LIVE_S + 60)
        self.assertEqual(agents.live_on("/Users/pup/muse", time.time(), activities=self.acts()), [])

    def test_a_different_repo_does_not_block(self):
        codex_session(self.cx, "c1", "/Users/pup/other", age_s=10)
        self.assertEqual(agents.live_on("/Users/pup/muse", time.time(), activities=self.acts()), [])

    def test_our_own_thread_never_blocks_itself(self):
        # a fleet thread steering a project is always live on it; without the
        # exclusion the project would permanently block dispatch to its own thread
        claude_session(self.cl, "-Users-pup-muse", "mine", "/Users/pup/muse", age_s=1)
        now = time.time()
        self.assertTrue(agents.live_on("/Users/pup/muse", now, activities=self.acts()))
        self.assertEqual(agents.live_on("/Users/pup/muse", now, activities=self.acts(),
                                        exclude_sessions={"mine"}), [])


if __name__ == "__main__":
    unittest.main()
