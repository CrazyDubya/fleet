import unittest

from fleet import cost
from fleet.transcript import Turn


def turn(**kw):
    base = dict(ts=0.0, model="claude-haiku-4-5", msg_id="x", input=0, cache_read=0, cache_5m=0,
                cache_1h=0, output=0, thinking=0, stop_reason="end_turn")
    base.update(kw); return Turn(**base)


class CostTests(unittest.TestCase):
    def test_warmth_bands(self):
        now = 10_000.0
        self.assertEqual(cost.warmth(None, now, 60), ("new", 0))
        self.assertEqual(cost.warmth(now - 10 * 60, now, 60), ("hot", 10))
        self.assertEqual(cost.warmth(now - 45 * 60, now, 60), ("cooling", 45))  # exactly 0.75·TTL boundary
        self.assertEqual(cost.warmth(now - 50 * 60, now, 60), ("cooling", 50))
        self.assertEqual(cost.warmth(now - 61 * 60, now, 60), ("cold", 61))

    def test_observed_ttl(self):
        self.assertEqual(cost.observed_ttl_minutes([turn(cache_1h=5)], 60), 60)
        self.assertEqual(cost.observed_ttl_minutes([turn(cache_5m=5)], 60), 5)
        self.assertEqual(cost.observed_ttl_minutes([turn()], 7), 7)
        self.assertEqual(cost.observed_ttl_minutes([], 60), 60)
        # Any turn with cache_1h takes priority: [cache_1h, cache_5m] → 60
        self.assertEqual(cost.observed_ttl_minutes([turn(cache_1h=1), turn(cache_5m=1)], 60), 60)

    def test_context_size_is_last_turn_prefix(self):
        turns = [turn(input=1, cache_1h=100), turn(input=5, cache_read=100, cache_1h=20)]
        self.assertEqual(cost.context_size(turns), 125)

    def test_spend_dollars_haiku(self):
        # haiku: $1/M in, $5/M out. 1,000,000 read @0.1 = $0.10; 1,000,000 written 1h @2 = $2.00;
        # 100,000 uncached in = $0.10; 200,000 out = $1.00  → $3.20
        t = turn(input=100_000, cache_read=1_000_000, cache_1h=1_000_000, output=200_000)
        s = cost.spend([t], "claude-haiku-4-5")
        self.assertEqual((s.read, s.written, s.output), (1_000_000, 1_000_000, 200_000))
        self.assertAlmostEqual(s.dollars, 3.20, places=6)

    def test_spend_empty(self):
        s = cost.spend([], "claude-sonnet-5")
        self.assertAlmostEqual(s.dollars, 0.0, places=6)

    def test_unknown_model_raises_instead_of_silently_costing_zero(self):
        # (0.0, 0.0) made a typo'd or brand-new model id render as "$0.00
        # spent", which reads as "this thread is free" - the one number the
        # layer exists to show. Callers decide how to display "unknown".
        for fn in (lambda: cost.spend([turn(output=10)], "claude-nope-9"),
                   lambda: cost.resume_cost(1000, "claude-nope-9", 60),
                   lambda: cost.respawn_cost(1000, "claude-nope-9", 60)):
            with self.assertRaises(ValueError) as cm:
                fn()
            self.assertIn("claude-nope-9", str(cm.exception))

    def test_resume_vs_respawn(self):
        # fable $10/M in; 1h TTL write = 2×. 300k context → $6.00; 20kB baseline ≈ 5k tokens → $0.10
        self.assertAlmostEqual(cost.resume_cost(300_000, "claude-fable-5", 60), 6.0, places=6)
        self.assertAlmostEqual(cost.respawn_cost(20_000, "claude-fable-5", 60), 0.10, places=6)
        self.assertAlmostEqual(cost.resume_cost(1_000_000, "claude-sonnet-5", 5), 2.5, places=6)
