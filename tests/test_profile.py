import tempfile
import unittest
from pathlib import Path

from fleet import paths, spec, tmux

TOML = '''
[settings]
cache_ttl_minutes = 60

[thread.sonnet]
model = "claude-sonnet-5"
tier = "hot"
persist = "singular"

[profile.v2]
session = "fleet2"
briefs = "briefs/v2"

[profile.v2.thread.sonnet2]
model = "claude-sonnet-5"
tier = "hot"
persist = "singular"
effort = "medium"
settings = "settings/v2/hot.json"

[profile.v2.thread.haiku-fs2]
model = "claude-haiku-4-5"
tier = "tool"
persist = "respawn"
effort = "low"
'''


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.toml = Path(self.tmp.name) / "fleet.toml"
        self.toml.write_text(TOML)

    def tearDown(self):
        self.tmp.cleanup(); tmux.use_session("fleet")

    def test_v1_is_implicit_default(self):
        p = spec.load_profile("v1", self.toml)
        self.assertEqual(p.session, "fleet")
        self.assertEqual(set(p.threads), {"sonnet"})

    def test_v2_profile_threads_and_session(self):
        p = spec.load_profile("v2", self.toml)
        self.assertEqual(p.session, "fleet2")
        self.assertEqual(p.briefs, "briefs/v2")
        self.assertEqual(set(p.threads), {"sonnet2", "haiku-fs2"})
        self.assertEqual(p.threads["sonnet2"].effort, "medium")

    def test_load_specs_v1_ignores_profiles(self):
        self.assertEqual(set(spec.load_specs(self.toml)), {"sonnet"})

    def test_unknown_profile_raises(self):
        with self.assertRaises(KeyError):
            spec.load_profile("v9", self.toml)

    def test_profile_state_dir(self):
        self.assertEqual(paths.profile_state("v1"), paths.STATE)
        self.assertEqual(paths.profile_state("v2"), paths.STATE / "v2")

    def test_tmux_use_session_changes_target(self):
        tmux.use_session("fleet2")
        self.assertEqual(tmux._target("sonnet2"), "fleet2:=sonnet2")
