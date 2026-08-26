import os
import shutil
import tempfile
import unittest
from pathlib import Path

from fleet import status, paths
from fleet.registry import Entry, Registry
from fleet.spec import load_specs, spec_hash

FX = Path(__file__).parent / "fixtures" / "small.jsonl"

# Anchor = the fixture's last assistant-turn timestamp (2026-08-26T04:05:00Z,
# the "m2" record), i.e. the timestamp status.rows() actually keys warmth off
# of (turns[-1].ts). Brief's literal constant (1787716701.0) predates this by
# ~6.5 minutes and doesn't correspond to any record in the committed fixture
# (verified against test_transcript.py, which already asserts on this same
# fixture file) - corrected here so "N minutes after the last record" is
# accurate.
LAST_TURN_TS = 1787717100.0


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # Fake a thread cwd whose transcript dir key resolves under CLAUDE_PROJECTS.
        self.cwd = Path(self.tmp.name) / "haiku-fs"
        self.cwd.mkdir()
        tdir = paths.transcript_path(self.cwd, "fx").parent
        tdir.mkdir(parents=True, exist_ok=True)
        shutil.copy(FX, tdir / "fx.jsonl")
        self.tdir = tdir
        self.reg = Registry(Path(self.tmp.name) / "registry.json")
        t = load_specs()["haiku-fs"]
        self.reg.save({"haiku-fs": Entry(name="haiku-fs", session_id="fx", cwd=str(self.cwd), model=t.model,
                                         status="parked", spec_hash=spec_hash(t), spawned_at=0.0)})

    def tearDown(self):
        shutil.rmtree(self.tdir, ignore_errors=True)
        self.tmp.cleanup()

    def test_row_numbers_from_fixture(self):
        now = LAST_TURN_TS + 20 * 60  # 20 min after the last record
        [r] = status.rows(now=now, registry=self.reg)
        self.assertEqual(r.state, "parked")
        self.assertEqual((r.warmth, r.idle_minutes), ("hot", 20))
        self.assertEqual(r.context, 5 + 1000 + 200)
        self.assertEqual((r.read, r.written, r.output), (1000, 1200, 80))
        # haiku: read 1000@0.1 + written 1200@2.0 + uncached 15@1 + out 80@5  (per M)
        self.assertAlmostEqual(r.dollars, (100 + 2400 + 15 + 400) / 1e6, places=9)
        self.assertFalse(r.spec_stale)
        # fixture has two malformed lines ("null" and "not json at all");
        # see test_transcript.py's test_dedupes_by_message_id_and_sums.
        self.assertEqual(r.errors, 2)
        self.assertAlmostEqual(r.resume_usd, 1205 * 1.0 * 2.0 / 1e6, places=9)

    def test_cold_after_ttl(self):
        [r] = status.rows(now=LAST_TURN_TS + 61 * 60, registry=self.reg)
        self.assertEqual(r.warmth, "cold")

    def test_render_has_one_line_per_thread_plus_header(self):
        text = status.render(status.rows(now=1787716701.0, registry=self.reg))
        self.assertEqual(len(text.strip().splitlines()), 2)
        self.assertIn("haiku-fs", text)


class ResolvePendingForkTests(unittest.TestCase):
    """Real `claude --resume <parent> --fork-session` writes the child's
    transcript into the PARENT's project directory (keyed off the parent's
    own cwd), never the child's own cwd - confirmed by hand against a live
    fork (opus -> expert-test): the new session file showed up under
    ~/.claude/projects/-Users-pup-fleet-opus/, not -...-expert-test/.
    resolve_pending_fork_ids must therefore search the parent's directory."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.parent_cwd = Path(self.tmp.name) / "opus"
        self.parent_cwd.mkdir()
        self.child_cwd = Path(self.tmp.name) / "expert-test"
        self.child_cwd.mkdir()
        self.pdir = paths.transcript_path(self.parent_cwd, "x").parent
        self.pdir.mkdir(parents=True, exist_ok=True)
        self.reg = Registry(Path(self.tmp.name) / "registry.json")

    def tearDown(self):
        shutil.rmtree(self.pdir, ignore_errors=True)
        self.tmp.cleanup()

    def _touch(self, path: Path, mtime: float):
        path.write_text("{}\n")
        os.utime(path, (mtime, mtime))

    def test_finds_forked_session_in_parents_project_dir(self):
        self._touch(self.pdir / "parent-session.jsonl", 100.0)
        self._touch(self.pdir / "child-session.jsonl", 200.0)
        self.reg.save({
            "opus": Entry(name="opus", session_id="parent-session", cwd=str(self.parent_cwd),
                          model="claude-opus-5", status="running", spec_hash="x", spawned_at=0.0),
            "expert-test": Entry(name="expert-test", session_id="pending", cwd=str(self.child_cwd),
                                 model="claude-opus-5", status="running", spec_hash="x", spawned_at=1.0,
                                 fork_of="opus"),
        })
        status.resolve_pending_fork_ids(self.reg)
        self.assertEqual(self.reg.load()["expert-test"].session_id, "child-session")

    def test_ignores_parents_own_session_file_even_if_newest(self):
        self._touch(self.pdir / "child-session.jsonl", 100.0)
        self._touch(self.pdir / "parent-session.jsonl", 999.0)  # newer, but it's the parent's own
        self.reg.save({
            "opus": Entry(name="opus", session_id="parent-session", cwd=str(self.parent_cwd),
                          model="claude-opus-5", status="running", spec_hash="x", spawned_at=0.0),
            "expert-test": Entry(name="expert-test", session_id="pending", cwd=str(self.child_cwd),
                                 model="claude-opus-5", status="running", spec_hash="x", spawned_at=1.0,
                                 fork_of="opus"),
        })
        status.resolve_pending_fork_ids(self.reg)
        self.assertEqual(self.reg.load()["expert-test"].session_id, "child-session")


if __name__ == "__main__":
    unittest.main()
