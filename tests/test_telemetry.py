import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fleet import telemetry, paths
from fleet.registry import Entry, Registry

FX = Path(__file__).parent / "fixtures" / "small.jsonl"
# The fixture's last assistant turn, 2026-08-26T04:05:00Z. Days are LOCAL
# (the nightly job fires at 23:55 local), so derive the day name from it
# rather than hard-coding one that is only right in some timezones.
FX_FIRST_TS = 1787716810.0  # 2026-08-26T04:00:10Z, the "m1" turn
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
        # Pegged to the fixture's own turns (m1 at FX_FIRST_TS, m2 at
        # FX_LAST_TS) rather than to absolute UTC literals: days are local, and
        # the fixture's turns sit just after local midnight here, so literals
        # a few minutes "before m2" in UTC fell into the PREVIOUS local day.
        # The intent is unchanged - a wake between the two turns, a respawn and
        # its miss just after the last one, one handoff sent in between.
        self.events = [
            {"ev": "wake", "thread": "haiku-fs", "t": FX_FIRST_TS + 60},
            {"ev": "respawn", "thread": "haiku-fs", "t": FX_LAST_TS + 60},
            {"ev": "miss", "thread": "haiku-fs", "reason": "respawn", "t": FX_LAST_TS + 60},
            {"ev": "send", "thread": "opus", "from": "haiku-fs", "bytes": 120, "t": FX_FIRST_TS + 120},
        ]

    def tearDown(self):
        shutil.rmtree(self.tdir, ignore_errors=True); self.tmp.cleanup()

    def test_derive_day_numbers(self):
        day = _fixture_day()
        recs = telemetry.derive_day(day, registry=self.reg, events=self.events, out_dir=self.out)
        [r] = recs
        self.assertEqual(r["turns"], 2)
        # hit_ratio = read / (input + read + written) over the day = 1000 / (15 + 1000 + 1200)
        self.assertAlmostEqual(r["hit_ratio"], 1000 / 2215, places=6)
        self.assertEqual(r["cold_wakes"], 0)
        self.assertEqual(r["respawns"], 1)
        self.assertEqual(r["misses"], {"respawn": 1})
        self.assertEqual(r["handoffs_sent"], 1)
        self.assertAlmostEqual(r["output_per_handoff"], 80.0)
        self.assertTrue((self.out / f"{day}.jsonl").exists())
        self.assertEqual(json.loads((self.out / f"{day}.jsonl").read_text().splitlines()[0])["thread"], "haiku-fs")

    def test_events_without_an_ev_key_do_not_crash_the_day(self):
        # ledger.read_events() returns whatever parsed; a record missing "ev"
        # (hand-edited line, older writer) must be skipped, not raise KeyError.
        events = [*self.events, {"t": 1787716800.0, "thread": "haiku-fs"}]
        [r] = telemetry.derive_day(_fixture_day(), registry=self.reg, events=events, out_dir=self.out)
        self.assertEqual(r["respawns"], 1)

    def test_unknown_model_marks_dollars_unknown_instead_of_crashing(self):
        entries = self.reg.load()
        entries["haiku-fs"].model = "claude-unpublished-9"
        self.reg.save(entries)
        [r] = telemetry.derive_day(_fixture_day(), registry=self.reg, events=[], out_dir=self.out)
        self.assertEqual(r["turns"], 2)
        self.assertEqual(r["dollars"], telemetry.UNKNOWN_USD)
        self.assertEqual(r["cold_wake_usd"], telemetry.UNKNOWN_USD)

    def test_report_mentions_three_questions(self):
        telemetry.derive_day(_fixture_day(), registry=self.reg, events=self.events, out_dir=self.out)
        text = telemetry.report(out_dir=self.out)
        for q in ("hot tier", "dormant tiers", "tool-threads"):
            self.assertIn(q, text)

    def test_report_has_a_per_model_aggregate_section(self):
        # haiku-fs7's COST-CACHE-VISIBILITY audit: aggregate stats were
        # only ever computable per-thread, never grouped by model across
        # the whole fleet.
        telemetry.derive_day(_fixture_day(), registry=self.reg, events=self.events, out_dir=self.out)
        text = telemetry.report(out_dir=self.out)
        self.assertIn("Per-model summary", text)
        self.assertIn("claude-haiku-4-5:", text)
        self.assertIn("avg-hit=0.45", text)  # 1000/2215, this fixture's one record
        self.assertIn("turns=2", text)
        self.assertIn("records=1", text)

    def test_per_model_dollars_excludes_unknown_usd_records_from_the_total(self):
        # An unpriced model's record must not silently drag the model's $
        # total down by -1.0 per record - it is excluded from the sum, and
        # the total reads "?" when nothing in the group was priced.
        entries = self.reg.load()
        entries["haiku-fs"].model = "claude-unpublished-9"
        self.reg.save(entries)
        telemetry.derive_day(_fixture_day(), registry=self.reg, events=[], out_dir=self.out)
        text = telemetry.report(out_dir=self.out)
        self.assertIn("claude-unpublished-9: total est$?", text)


def _assistant_line(msg_id: str, ts: str, **usage) -> str:
    base = {"input_tokens": 5, "cache_read_input_tokens": 0, "output_tokens": 10, "cache_creation": {}}
    base.update(usage)
    return json.dumps({"type": "assistant", "timestamp": ts,
                        "message": {"id": msg_id, "model": "claude-haiku-4-5", "stop_reason": "end_turn",
                                    "usage": base}})


def _local(day: str, hh: int, mm: int = 0) -> str:
    """A transcript timestamp (ISO-8601 Z) for a wall-clock LOCAL time.

    Telemetry days are local - the nightly launchd job fires at 23:55 local -
    so fixtures that probe day boundaries must be written in local wall-clock
    terms and converted, not hand-written as Z strings that only land on the
    intended day in some timezones.
    """
    naive = datetime.strptime(day, "%Y-%m-%d") + timedelta(hours=hh, minutes=mm)
    return naive.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class LocalDayTests(unittest.TestCase):
    """`fleet telemetry` days are LOCAL days. The launchd job fires at 23:55
    local; with UTC bounds a 23:00-local turn (03:00Z the next day, west of
    Greenwich) fell outside the day being derived, so the late-evening turns
    - most of the fleet's day - were never derived at all."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name) / "late"; self.cwd.mkdir()
        self.tdir = paths.transcript_path(self.cwd, "late").parent
        self.tdir.mkdir(parents=True, exist_ok=True)
        (self.tdir / "late.jsonl").write_text(
            _assistant_line("l1", _local("2026-03-10", 23, 0)) + "\n"
            + _assistant_line("l2", _local("2026-03-10", 0, 30)) + "\n")
        self.reg = Registry(Path(self.tmp.name) / "registry.json")
        self.reg.save({"late": Entry(name="late", session_id="late", cwd=str(self.cwd),
                                     model="claude-haiku-4-5", status="running",
                                     spec_hash="h", spawned_at=0.0)})
        self.out = Path(self.tmp.name) / "telemetry"

    def tearDown(self):
        shutil.rmtree(self.tdir, ignore_errors=True); self.tmp.cleanup()

    def test_a_2300_local_turn_lands_in_that_local_day(self):
        [r] = telemetry.derive_day("2026-03-10", registry=self.reg, events=[],
                                   out_dir=self.out, default_ttl=60)
        self.assertEqual(r["turns"], 2)  # 00:30 and 23:00, both local 2026-03-10

    def test_neither_neighbouring_day_claims_those_turns(self):
        for day in ("2026-03-09", "2026-03-11"):
            [r] = telemetry.derive_day(day, registry=self.reg, events=[],
                                       out_dir=self.out, default_ttl=60)
            self.assertEqual(r["turns"], 0, day)

    def test_bounds_are_exactly_local_midnight_to_local_midnight(self):
        lo, hi = telemetry._day_bounds("2026-03-10")
        self.assertEqual(datetime.fromtimestamp(lo).isoformat(), "2026-03-10T00:00:00")
        self.assertEqual(datetime.fromtimestamp(hi).isoformat(), "2026-03-11T00:00:00")

    def test_a_dst_day_is_not_assumed_to_be_86400_seconds(self):
        # US DST starts 2026-03-08; that local day is 23 hours long. Building
        # `hi` as lo + 86400 would swallow the first hour of 03-09.
        lo, hi = telemetry._day_bounds("2026-03-08")
        self.assertEqual(datetime.fromtimestamp(hi).isoformat(), "2026-03-09T00:00:00")


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
        # 23:00 LOCAL on the previous day -> 00:30 LOCAL on the next: a
        # 90-minute gap, >= the 60-minute TTL passed to derive_day below.
        lines = [
            _assistant_line("a1", _local("2026-08-25", 23, 0)),
            _assistant_line("a2", _local("2026-08-26", 0, 30)),
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
