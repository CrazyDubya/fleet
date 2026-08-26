import json
import tempfile
import unittest
from pathlib import Path

from fleet.paths import transcript_path
from fleet.registry import Entry, Registry, RegistryLocked, transcript_for


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "registry.json"
        self.reg = Registry(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_empty_when_missing(self):
        self.assertEqual(self.reg.load(), {})

    def test_roundtrip_and_atomic_file(self):
        e = Entry(name="sonnet", session_id="s1", cwd="/x/sonnet", model="claude-sonnet-5",
                  status="running", spec_hash="h", spawned_at=1.0)
        self.reg.save({"sonnet": e})
        self.assertEqual(self.reg.load()["sonnet"], e)
        self.assertFalse((self.path.parent / "registry.json.tmp").exists())
        self.assertIn("sonnet", json.loads(self.path.read_text()))

    def test_transcript_for_uses_the_parents_cwd_for_a_fork(self):
        parent = Entry(name="opus", session_id="p1", cwd="/x/opus", model="claude-opus-5",
                       status="running", spec_hash="h", spawned_at=0.0)
        child = Entry(name="expert", session_id="c1", cwd="/x/expert", model="claude-opus-5",
                      status="running", spec_hash="h", spawned_at=1.0, fork_of="opus")
        entries = {"opus": parent, "expert": child}
        self.assertEqual(transcript_for(child, entries), transcript_path(Path("/x/opus"), "c1"))
        self.assertEqual(transcript_for(parent, entries), transcript_path(Path("/x/opus"), "p1"))

    def test_transcript_for_falls_back_to_own_cwd_when_parent_is_gone(self):
        child = Entry(name="expert", session_id="c1", cwd="/x/expert", model="claude-opus-5",
                      status="running", spec_hash="h", spawned_at=1.0, fork_of="opus")
        self.assertEqual(transcript_for(child, {"expert": child}), transcript_path(Path("/x/expert"), "c1"))

    def test_lock_is_exclusive(self):
        with self.reg.locked():
            with self.assertRaises(RegistryLocked):
                with self.reg.locked():
                    pass
        with self.reg.locked():
            pass  # released
