import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fleet import paths, spec, status, tmux

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


class StatusSpecsProfileTests(unittest.TestCase):
    """R1: `status.rows()` (and `launcher.fork()`) must resolve specs through
    the active profile, not always `load_specs()` (v1-only) - otherwise
    `fleet status` under FLEET_PROFILE=v2 shows tier `?` for v2 threads.
    `status._specs()` is the small helper `rows()` defaults to; it is
    exercised directly here rather than through `rows()` itself so the test
    does not need a registry/transcript fixture."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.toml = Path(self.tmp.name) / "fleet.toml"
        self.toml.write_text(TOML)
        self.real_read = spec._read

    def tearDown(self):
        self.tmp.cleanup(); tmux.use_session("fleet")

    def _redirected(self, _path=None):
        return self.real_read(self.toml)

    def test_v2_profile_resolves_sonnet2_as_hot(self):
        with mock.patch.dict(os.environ, {"FLEET_PROFILE": "v2"}), \
             mock.patch.object(spec, "_read", side_effect=self._redirected):
            specs = status._specs()
        self.assertEqual(specs["sonnet2"].tier, "hot")

    def test_v1_unaffected_when_no_profile_set(self):
        env = dict(os.environ); env.pop("FLEET_PROFILE", None)
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(spec, "_read", side_effect=self._redirected):
            specs = status._specs()
        self.assertEqual(set(specs), {"sonnet"})
        self.assertEqual(specs["sonnet"].tier, "hot")
