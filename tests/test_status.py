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
        # hit_ratio = read / (read + uncached-input): 1000 / (1000 + 15)
        self.assertAlmostEqual(r.hit_ratio, 1000 / 1015, places=6)

    def test_cold_after_ttl(self):
        [r] = status.rows(now=LAST_TURN_TS + 61 * 60, registry=self.reg)
        self.assertEqual(r.warmth, "cold")

    def test_render_has_one_line_per_thread_plus_header(self):
        text = status.render(status.rows(now=1787716701.0, registry=self.reg))
        self.assertEqual(len(text.strip().splitlines()), 2)
        self.assertIn("haiku-fs", text)

    def test_render_shows_model_and_cache_hit_percent(self):
        # haiku-fs7's COST-CACHE-VISIBILITY audit: Row.model existed but
        # was never in the render() line, and hit_ratio was only ever
        # visible after the fact in the telemetry report.
        rows = status.rows(now=1787716701.0, registry=self.reg)
        text = status.render(rows)
        header, row_line = text.strip().splitlines()
        self.assertIn("model", header)
        self.assertIn("hit%", header)
        self.assertIn(rows[0].model, row_line)
        # 1000 / 1015 rounds to 99% at the column's own precision
        self.assertIn(" 99% ", row_line)

    def test_zero_input_and_zero_read_is_a_zero_hit_ratio_not_a_division_error(self):
        # A "new" thread (no turns at all) must not raise ZeroDivisionError.
        empty_cwd = Path(self.tmp.name) / "empty"
        empty_cwd.mkdir()
        reg = Registry(Path(self.tmp.name) / "registry-empty.json")
        t = load_specs()["haiku-fs"]
        reg.save({"haiku-fs": Entry(name="haiku-fs", session_id="nope", cwd=str(empty_cwd), model=t.model,
                                    status="parked", spec_hash=spec_hash(t), spawned_at=0.0)})
        [r] = status.rows(now=1787716701.0, registry=reg)
        self.assertEqual(r.hit_ratio, 0.0)


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


class UnknownModelTests(unittest.TestCase):
    """A model id with no published rate must not crash `fleet status`, and
    must not render as $0.00 (which reads as "free") - it renders as `?`."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name) / "haiku-fs"; self.cwd.mkdir()
        self.tdir = paths.transcript_path(self.cwd, "fx").parent
        self.tdir.mkdir(parents=True, exist_ok=True)
        shutil.copy(FX, self.tdir / "fx.jsonl")
        self.reg = Registry(Path(self.tmp.name) / "registry.json")
        self.reg.save({"haiku-fs": Entry(name="haiku-fs", session_id="fx", cwd=str(self.cwd),
                                         model="claude-unpublished-9", status="parked",
                                         spec_hash="x", spawned_at=0.0)})

    def tearDown(self):
        shutil.rmtree(self.tdir, ignore_errors=True); self.tmp.cleanup()

    def test_row_marks_dollars_unknown_and_keeps_token_counts(self):
        [r] = status.rows(now=LAST_TURN_TS + 60, registry=self.reg)
        self.assertEqual((r.read, r.written, r.output), (1000, 1200, 80))
        self.assertEqual(r.dollars, status.UNKNOWN_USD)
        self.assertEqual(r.resume_usd, status.UNKNOWN_USD)
        self.assertEqual(r.respawn_usd, status.UNKNOWN_USD)

    def test_render_shows_a_question_mark_not_a_zero(self):
        text = status.render(status.rows(now=LAST_TURN_TS + 60, registry=self.reg))
        self.assertNotIn("0.00", text)
        self.assertIn("?", text)


class ResolveUnderLockTests(ResolvePendingForkTests):
    """rows() must persist a resolution under the registry lock (spec §9),
    and must not persist at all when the caller already holds it - otherwise
    launcher.wake's own save reverts the resolution back to "pending"."""

    def _registered(self):
        self._touch(self.pdir / "parent-session.jsonl", 100.0)
        self._touch(self.pdir / "child-session.jsonl", 200.0)
        return {
            "opus": Entry(name="opus", session_id="parent-session", cwd=str(self.parent_cwd),
                          model="claude-opus-5", status="parked", spec_hash="x", spawned_at=0.0),
            "expert-test": Entry(name="expert-test", session_id="pending", cwd=str(self.child_cwd),
                                 model="claude-opus-5", status="parked", spec_hash="x", spawned_at=1.0,
                                 fork_of="opus"),
        }

    def test_rows_persists_the_resolution(self):
        self.reg.save(self._registered())
        status.rows(now=1.0, registry=self.reg, specs={})
        self.assertEqual(self.reg.load()["expert-test"].session_id, "child-session")

    def test_a_locked_registry_does_not_break_status(self):
        self.reg.save(self._registered())
        with self.reg.locked():
            rs = {r.name: r for r in status.rows(now=1.0, registry=self.reg, specs={})}
        self.assertEqual(rs["expert-test"].name, "expert-test")
        # not written while someone else held the lock
        self.assertEqual(self.reg.load()["expert-test"].session_id, "pending")

    def test_caller_owned_entries_are_resolved_in_place_and_not_written(self):
        entries = self._registered()
        self.reg.save(entries)
        entries = self.reg.load()
        with self.reg.locked():  # what launcher.wake holds
            status.rows(now=1.0, registry=self.reg, specs={}, entries=entries)
            self.assertEqual(entries["expert-test"].session_id, "child-session")
            self.reg.save(entries)  # wake's own save now carries the resolution
        self.assertEqual(self.reg.load()["expert-test"].session_id, "child-session")


class ForkedRowTests(unittest.TestCase):
    """A fork's transcript lives under the PARENT's cwd project dir.
    resolve_pending_fork_ids already knew that; rows() did not, so every
    forked thread showed context 0 / $0 / warmth new."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.parent_cwd = Path(self.tmp.name) / "opus"; self.parent_cwd.mkdir()
        self.child_cwd = Path(self.tmp.name) / "expert-test"; self.child_cwd.mkdir()
        self.pdir = paths.transcript_path(self.parent_cwd, "x").parent
        self.pdir.mkdir(parents=True, exist_ok=True)
        shutil.copy(FX, self.pdir / "child.jsonl")
        self.reg = Registry(Path(self.tmp.name) / "registry.json")
        self.reg.save({
            "expert-test": Entry(name="expert-test", session_id="child", cwd=str(self.child_cwd),
                                 model="claude-opus-5", status="running", spec_hash="x",
                                 spawned_at=0.0, fork_of="opus"),
            "opus": Entry(name="opus", session_id="parent", cwd=str(self.parent_cwd),
                          model="claude-opus-5", status="running", spec_hash="x", spawned_at=0.0),
        })

    def tearDown(self):
        shutil.rmtree(self.pdir, ignore_errors=True); self.tmp.cleanup()

    def test_forked_row_reads_the_transcript_from_the_parents_dir(self):
        rows = {r.name: r for r in status.rows(now=LAST_TURN_TS + 60, registry=self.reg)}
        self.assertEqual(rows["expert-test"].context, 5 + 1000 + 200)
        self.assertEqual(rows["expert-test"].read, 1000)
        self.assertGreater(rows["expert-test"].dollars, 0.0)
        # the parent has no transcript file of its own in this fixture
        self.assertEqual(rows["opus"].context, 0)


if __name__ == "__main__":
    unittest.main()


class RefusedStateTests(unittest.TestCase):
    """A thread whose last turn was a provider refusal must not read `idle`.
    Same fixture as StatusTests plus one real rate-limit record appended, and
    the entry is `running` (not parked) so the transcript path is exercised.
    Motivation 2026-09-04: fleet ran all night under an account lockout and a
    quota wall would have looked identical to a thread that simply stopped."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name) / "haiku-fs"
        self.cwd.mkdir()
        tdir = paths.transcript_path(self.cwd, "fx").parent
        tdir.mkdir(parents=True, exist_ok=True)
        shutil.copy(Path(__file__).parent / "fixtures" / "refused.jsonl", tdir / "fx.jsonl")
        self.tdir = tdir
        self.reg = Registry(Path(self.tmp.name) / "registry.json")
        t = load_specs()["haiku-fs"]
        self.reg.save({"haiku-fs": Entry(name="haiku-fs", session_id="fx", cwd=str(self.cwd), model=t.model,
                                         status="running", spec_hash=spec_hash(t), spawned_at=0.0)})

    def tearDown(self):
        shutil.rmtree(self.tdir, ignore_errors=True)
        self.tmp.cleanup()

    def test_state_is_refused_not_idle(self):
        [r] = status.rows(now=LAST_TURN_TS + 60, registry=self.reg)
        self.assertEqual(r.state, "refused")
        self.assertEqual(r.provider_refused, "rate_limit")

    def test_render_shows_how_long_ago_the_refusal_was(self):
        """A refusal is STICKY: `refused` derives from the last transcript record, so
        it persists after the wall lifts until the thread is poked and succeeds.
        Observed 2026-09-04 15:35 EDT — three threads read `refused` carrying a reset
        time of 14:30, already an hour past, and the row gave no hint the state was
        stale. The age is already in idle_minutes; it has to be in the flag a reader
        is actually looking at."""
        [r] = status.rows(now=LAST_TURN_TS + 3 * 3600, registry=self.reg)
        text = status.render([r])
        self.assertGreater(r.idle_minutes, 60, "fixture should be hours stale")
        # The age in the flag must be the row's own idle_minutes, not a second
        # derivation that can drift from the column beside it.
        self.assertIn(f"PROVIDER:rate_limit {r.idle_minutes}m-ago", text)

    def test_render_names_the_provider_refusal(self):
        text = status.render(status.rows(now=LAST_TURN_TS + 60, registry=self.reg))
        self.assertIn("refused", text)
        self.assertIn("PROVIDER:rate_limit", text)
