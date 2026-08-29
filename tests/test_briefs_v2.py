import unittest
from fleet import spec
from fleet.paths import ROOT


class BriefsV2Tests(unittest.TestCase):
    def test_every_v2_baseline_exists_and_embeds_protocol(self):
        proto = (ROOT / "briefs/v2/_protocol.md").read_text()
        for t in spec.load_profile("v2").threads.values():
            for b in t.baseline:
                self.assertTrue((ROOT / b).exists(), b)
            role = (ROOT / t.baseline[0]).read_text()
            self.assertTrue(role.startswith(proto), t.baseline[0])

    def test_protocol_names_the_verbs(self):
        proto = (ROOT / "briefs/v2/_protocol.md").read_text()
        for needle in ["fleet ask", "@lane", "@done", "@reply", "servable"]:
            self.assertIn(needle, proto)

    def test_router_rubric_lists_all_lanes(self):
        r = (ROOT / "briefs/v2/router.md").read_text()
        for lane in ["lookup", "build", "plan", "judge", "consult"]:
            self.assertIn(lane, r)
