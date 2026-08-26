import json
import tempfile
import unittest
from pathlib import Path

from fleet.registry import Entry, Registry, RegistryLocked


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

    def test_lock_is_exclusive(self):
        with self.reg.locked():
            with self.assertRaises(RegistryLocked):
                with self.reg.locked():
                    pass
        with self.reg.locked():
            pass  # released
