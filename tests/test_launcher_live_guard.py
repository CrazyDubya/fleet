"""Guards on tests/test_launcher_live.py itself.

The live launcher tests spawn and kill real threads. They must never touch a
thread the operator has running: skipping inside the test *body* is not
enough, because unittest still runs `tearDown`, and that tearDown killed the
window and deleted the registry entry - i.e. running the suite destroyed the
live fleet. These tests are pure (they only read the registry and list tmux
windows) and assert the two guards that make that impossible:

  1. the skip is decided at import time, on the class, so unittest never
     enters setUp/tearDown for a live thread at all;
  2. tearDown is inert unless the test body actually spawned the thread.
"""

import unittest

from fleet import tmux
from fleet.registry import Registry

import tests.test_launcher_live as live


def _live(name: str) -> bool:
    e = Registry().load().get(name)
    return bool(e and e.status == "running" and tmux.window_exists(name))


class LiveGuardTests(unittest.TestCase):
    def test_class_level_skip_matches_the_real_fleet(self):
        for cls, thread in ((live.LauncherLiveTests, "haiku-fs"), (live.ForkLiveTests, "opus")):
            with self.subTest(thread=thread):
                self.assertEqual(
                    getattr(cls, "__unittest_skip__", False), _live(thread),
                    f"{cls.__name__} must be skipped at class level exactly when {thread} is live",
                )

    def test_teardown_is_inert_until_the_body_spawns(self):
        # A tearDown that runs after a body that never called launcher.up must
        # not kill a window or edit the registry.
        before = Registry().load()
        for cls in (live.LauncherLiveTests, live.ForkLiveTests):
            with self.subTest(cls=cls.__name__):
                method = sorted(n for n in dir(cls) if n.startswith("test_"))[0]
                case = cls(method)
                case.setUp()
                self.assertFalse(case._touched, "setUp must start untouched")
                case.tearDown()
        self.assertEqual(Registry().load(), before, "tearDown mutated the live registry")


if __name__ == "__main__":
    unittest.main()
