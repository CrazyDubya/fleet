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
