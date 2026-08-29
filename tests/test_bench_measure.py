import unittest
from unittest import mock

from fleet.bench import measure
from fleet.transcript import Turn


def turn(ts, model, **kw):
    base = dict(ts=ts, model=model, msg_id=f"m{ts}", input=0, cache_read=0, cache_5m=0, cache_1h=0, output=0, thinking=0, stop_reason=None)
    base.update(kw); return Turn(**base)


class MeasureTests(unittest.TestCase):
    def test_window_is_half_open(self):
        ts = [turn(1, "m"), turn(5, "m"), turn(9, "m")]
        self.assertEqual([t.ts for t in measure.window(ts, 5, 9)], [5])

    def test_tokens_and_usd_by_model(self):
        s = [turn(10, "claude-sonnet-5", input=100, cache_read=1000, cache_1h=50, output=20)]
        h = [turn(11, "claude-haiku-4-5", cache_read=500, output=5), turn(99, "claude-haiku-4-5", output=999)]
        with mock.patch("fleet.bench.measure._turns_of", side_effect=[s, h]):
            tok = measure.tokens_by_model(["a", "b"], 0, 50)
        self.assertEqual(tok["claude-sonnet-5"], {"input": 100, "cache_read": 1000, "cache_write": 50, "output": 20})
        self.assertEqual(tok["claude-haiku-4-5"]["output"], 5)  # the ts=99 turn is outside the window
        with mock.patch("fleet.bench.measure._turns_of", side_effect=[s, h]):
            usd = measure.usd_by_model(["a", "b"], 0, 50)
        self.assertAlmostEqual(usd["claude-sonnet-5"], (1000*2.0*0.1 + 50*2.0*2.0 + 100*2.0 + 20*10.0) / 1e6)

    def test_unknown_model_is_listed_but_unpriced(self):
        with mock.patch("fleet.bench.measure._turns_of", return_value=[turn(1, "mystery-9", output=3)]):
            self.assertEqual(measure.tokens_by_model(["a"], 0, 5)["mystery-9"]["output"], 3)
            self.assertEqual(measure.usd_by_model(["a"], 0, 5)["mystery-9"], 0.0)

    def test_pool_split(self):
        p = measure.pool_split({"claude-fable-5": 1.5, "claude-opus-5": 0.5, "claude-sonnet-5": 0.3, "claude-haiku-4-5": 0.02})
        self.assertEqual(p, {"fable": 1.5, "weekly": {"opus": 0.5, "sonnet": 0.3, "haiku": 0.02}})
        self.assertEqual(measure.pool_split({})["weekly"], {"opus": 0.0, "sonnet": 0.0, "haiku": 0.0})

    def test_interventions_in_window(self):
        ev = [{"ev": "hook", "hook": "perm", "decision": "escalate", "t": 5}, {"ev": "hook", "hook": "gate", "decision": "block", "t": 6},
              {"ev": "hook", "hook": "gate", "decision": "allow", "t": 6}, {"ev": "decide", "t": 7}, {"ev": "keypress", "t": 8}, {"ev": "keypress", "t": 50}]
        self.assertEqual(measure.interventions(ev, 0, 10), {"keypress": 1, "decide": 1, "escalate": 1, "block": 1})

    def test_interventions_scoped_to_threads(self):
        ev = [{"ev": "keypress", "t": 1, "thread": "sonnet2"}, {"ev": "keypress", "t": 2, "thread": "opus"},
              {"ev": "hook", "decision": "escalate", "t": 3, "thread": "haiku1"}, {"ev": "decide", "t": 4}]
        self.assertEqual(measure.interventions(ev, 0, 10, {"sonnet2", "haiku1"}),
                         {"keypress": 1, "decide": 0, "escalate": 1, "block": 0})
        self.assertEqual(measure.interventions(ev, 0, 10)["keypress"], 2)  # unscoped counts the whole ledger
