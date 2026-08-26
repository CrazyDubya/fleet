import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from fleet import telemetry, paths
from fleet.registry import Entry, Registry

FX = Path(__file__).parent / "fixtures" / "small.jsonl"
# The fixture's last assistant turn, 2026-08-26T04:05:00Z. Days are LOCAL
# (the nightly job fires at 23:55 local), so derive the day name from it
# rather than hard-coding one that is only right in some timezones.
FX_LAST_TS = 1787717100.0


def _fixture_day() -> str:
    return datetime.fromtimestamp(FX_LAST_TS).strftime("%Y-%m-%d")


class TelemetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name) / "haiku-fs"; self.cwd.mkdir()
        self.tdir = paths.transcript_path(self.cwd, "fx").parent
        self.tdir.mkdir(parents=True, exist_ok=True)
        shutil.copy(FX, self.tdir / "fx.jsonl")
        self.reg = Registry(Path(self.tmp.name) / "registry.json")
        self.reg.save({"haiku-fs": Entry(name="haiku-fs", session_id="fx", cwd=str(self.cwd),
                                         model="claude-haiku-4-5", status="running", spec_hash="h", spawned_at=0.0)})
        self.out = Path(self.tmp.name) / "telemetry"
        self.events = [
            {"ev": "wake", "thread": "haiku-fs", "t": 1787716500.0},        # 04:01:40Z, before m2 at 04:05 → cold? no: gap from m1 (04:00:10) is 4.8 min < 5-min TTL? TTL observed = 60 → hot; not a cold wake
            {"ev": "respawn", "thread": "haiku-fs", "t": 1787716800.0},
            {"ev": "miss", "thread": "haiku-fs", "reason": "respawn", "t": 1787716800.0},
            {"ev": "send", "thread": "opus", "from": "haiku-fs", "bytes": 120, "t": 1787716650.0},
        ]

    def tearDown(self):
        shutil.rmtree(self.tdir, ignore_errors=True); self.tmp.cleanup()

    def test_derive_day_numbers(self):
        recs = telemetry.derive_day("2026-08-26", registry=self.reg, events=self.events, out_dir=self.out)
        [r] = recs
        self.assertEqual(r["turns"], 2)
        # hit_ratio = read / (input + read + written) over the day = 1000 / (15 + 1000 + 1200)
        self.assertAlmostEqual(r["hit_ratio"], 1000 / 2215, places=6)
        self.assertEqual(r["cold_wakes"], 0)
        self.assertEqual(r["respawns"], 1)
        self.assertEqual(r["misses"], {"respawn": 1})
        self.assertEqual(r["handoffs_sent"], 1)
        self.assertAlmostEqual(r["output_per_handoff"], 80.0)
        self.assertTrue((self.out / "2026-08-26.jsonl").exists())
        self.assertEqual(json.loads((self.out / "2026-08-26.jsonl").read_text().splitlines()[0])["thread"], "haiku-fs")

    def test_events_without_an_ev_key_do_not_crash_the_day(self):
        # ledger.read_events() returns whatever parsed; a record missing "ev"
        # (hand-edited line, older writer) must be skipped, not raise KeyError.
        events = [*self.events, {"t": 1787716800.0, "thread": "haiku-fs"}]
        [r] = telemetry.derive_day("2026-08-26", registry=self.reg, events=events, out_dir=self.out)
        self.assertEqual(r["respawns"], 1)

    def test_report_mentions_three_questions(self):
        telemetry.derive_day("2026-08-26", registry=self.reg, events=self.events, out_dir=self.out)
        text = telemetry.report(out_dir=self.out)
        for q in ("hot tier", "dormant tiers", "tool-threads"):
            self.assertIn(q, text)


def _assistant_line(msg_id: str, ts: str, **usage) -> str:
    base = {"input_tokens": 5, "cache_read_input_tokens": 0, "output_tokens": 10, "cache_creation": {}}
    base.update(usage)
    return json.dumps({"type": "assistant", "timestamp": ts,
                        "message": {"id": msg_id, "model": "claude-haiku-4-5", "stop_reason": "end_turn",
                                    "usage": base}})


class OvernightColdWakeTests(unittest.TestCase):
    """derive_day must count a cold wake at the day boundary: a turn just
    after midnight that follows a >=TTL gap from the PREVIOUS day's last
    turn is the exact case the cold-wake metric exists for, and it was being
    dropped because the turn list was filtered to [lo, hi) before the gap
    loop ran - so the previous day's turn was never available to compare
    against."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name) / "overnight"; self.cwd.mkdir()
        self.tdir = paths.transcript_path(self.cwd, "ovn").parent
        self.tdir.mkdir(parents=True, exist_ok=True)
        # 2026-08-25T23:00Z (previous day) -> 2026-08-26T00:30Z (next day):
        # a 90-minute gap, >= the 60-minute TTL passed to derive_day below.
        lines = [
            _assistant_line("a1", "2026-08-25T23:00:00.000Z"),
            _assistant_line("a2", "2026-08-26T00:30:00.000Z"),
        ]
        (self.tdir / "ovn.jsonl").write_text("\n".join(lines) + "\n")
        self.reg = Registry(Path(self.tmp.name) / "registry.json")
        self.reg.save({"overnight": Entry(name="overnight", session_id="ovn", cwd=str(self.cwd),
                                          model="claude-haiku-4-5", status="running", spec_hash="h", spawned_at=0.0)})
        self.out = Path(self.tmp.name) / "telemetry"

    def tearDown(self):
        shutil.rmtree(self.tdir, ignore_errors=True); self.tmp.cleanup()

    def test_boundary_gap_counted_against_the_day_it_wakes_into(self):
        recs = telemetry.derive_day("2026-08-26", registry=self.reg, events=[], out_dir=self.out, default_ttl=60)
        [r] = recs
        self.assertEqual(r["turns"], 1)  # only the 00:30 turn is in-day; the 23:00 turn is not
        self.assertEqual(r["cold_wakes"], 1)

    def test_prior_day_itself_shows_no_cold_wake_it_has_no_predecessor(self):
        recs = telemetry.derive_day("2026-08-25", registry=self.reg, events=[], out_dir=self.out, default_ttl=60)
        [r] = recs
        self.assertEqual(r["turns"], 1)  # the 23:00 turn
        self.assertEqual(r["cold_wakes"], 0)  # no turn before it to gap against


class ForkedThreadTests(unittest.TestCase):
    """Same seam as ForkedRowTests in test_status: derive_day must read a
    fork's transcript from the parent's project dir, via the one shared
    registry.transcript_for helper."""

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
        self.out = Path(self.tmp.name) / "telemetry"

    def tearDown(self):
        shutil.rmtree(self.pdir, ignore_errors=True); self.tmp.cleanup()

    def test_forked_thread_turns_are_derived(self):
        recs = {r["thread"]: r for r in
                telemetry.derive_day(_fixture_day(), registry=self.reg, events=[], out_dir=self.out)}
        self.assertEqual(recs["expert-test"]["turns"], 2)
        self.assertGreater(recs["expert-test"]["dollars"], 0.0)
        self.assertEqual(recs["opus"]["turns"], 0)  # no transcript of its own here


if __name__ == "__main__":
    unittest.main()
