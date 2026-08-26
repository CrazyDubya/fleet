import shutil
import tempfile
import unittest
from pathlib import Path

from fleet import spec, paths


class SpecTests(unittest.TestCase):
    def test_loads_four_threads_with_defaults(self):
        specs = spec.load_specs()
        self.assertEqual(set(specs), {"sonnet", "opus", "fable", "haiku-fs"})
        self.assertEqual(specs["sonnet"].model, "claude-sonnet-5")
        self.assertEqual(specs["opus"].permission_mode, "default")
        self.assertTrue(specs["opus"].forkable)
        self.assertEqual(specs["haiku-fs"].effort, "low")
        self.assertEqual(specs["fable"].resume_policy, "packet-first")

    def test_settings_default_ttl(self):
        self.assertEqual(spec.load_settings()["cache_ttl_minutes"], 60)

    def test_hash_changes_when_baseline_changes(self):
        t = spec.load_specs()["haiku-fs"]
        before = spec.spec_hash(t)
        p = paths.ROOT / "maps" / "repo.md"
        original = p.read_text()
        try:
            p.write_text(original + "\nchanged\n")
            self.assertNotEqual(before, spec.spec_hash(t))
        finally:
            p.write_text(original)
        self.assertEqual(before, spec.spec_hash(t))

    def test_transcript_path_key(self):
        p = paths.transcript_path(Path("/Users/pup/haiku"), "abc")
        self.assertTrue(str(p).endswith("/.claude/projects/-Users-pup-haiku/abc.jsonl"))


class AppendThreadTests(unittest.TestCase):
    """`fleet fork` has to write a [thread.<new>] stanza (spec §4), or the
    child exists only in the registry: wake/respawn say "no thread named",
    status shows tier `?`, spec_stale is never computed, respawn_usd is 0."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.toml = Path(self.tmp.name) / "fleet.toml"
        shutil.copy(paths.ROOT / "fleet.toml", self.toml)

    def tearDown(self):
        self.tmp.cleanup()

    def _child(self):
        parent = spec.load_specs(self.toml)["opus"]
        return spec.Thread(name="expert-test", model=parent.model, tier=parent.tier,
                           persist="on-demand", baseline=[*parent.baseline, "briefs/expert-test.md"],
                           mcp=parent.mcp, dirs=parent.dirs, permission_mode=parent.permission_mode,
                           effort=parent.effort, forkable=False, fork_of="opus",
                           resume_policy=parent.resume_policy)

    def test_appended_stanza_round_trips_through_load_specs(self):
        child = self._child()
        spec.append_thread(child, self.toml)
        loaded = spec.load_specs(self.toml)
        self.assertEqual(loaded["expert-test"], child)
        # the threads that were already there are untouched
        self.assertEqual(set(loaded), {"sonnet", "opus", "fable", "haiku-fs", "expert-test"})
        self.assertEqual(loaded["opus"], spec.load_specs(paths.ROOT / "fleet.toml")["opus"])

    def test_child_inherits_the_parents_prefix_and_adds_the_brief_last(self):
        child = self._child()
        spec.append_thread(child, self.toml)
        loaded = spec.load_specs(self.toml)["expert-test"]
        parent = spec.load_specs(self.toml)["opus"]
        self.assertEqual(loaded.model, parent.model)
        self.assertEqual(loaded.tier, parent.tier)
        self.assertEqual(loaded.fork_of, "opus")
        self.assertFalse(loaded.forkable)  # a fork of a fork is not independence (§6.6)
        self.assertEqual(loaded.baseline, [*parent.baseline, "briefs/expert-test.md"])

    def test_settings_block_survives_the_append(self):
        spec.append_thread(self._child(), self.toml)
        self.assertEqual(spec.load_settings(self.toml)["cache_ttl_minutes"], 60)

    def test_refuses_to_shadow_an_existing_thread(self):
        with self.assertRaises(ValueError):
            spec.append_thread(spec.Thread(name="opus", model="m", tier="warm", persist="on-demand"),
                               self.toml)

    def test_optional_fields_are_omitted_not_rendered_as_null(self):
        text = spec.render_stanza(spec.Thread(name="bare", model="m", tier="tool", persist="respawn"))
        self.assertNotIn("mcp", text)
        self.assertNotIn("effort", text)
        self.assertNotIn("fork_of", text)
        self.assertIn("[thread.bare]", text)
