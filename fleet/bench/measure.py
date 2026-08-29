"""Per-run measurement from transcripts and the ledger (spec: Row schema)."""
from pathlib import Path

from fleet import cost, transcript
from fleet.transcript import Turn


def _turns_of(path) -> list[Turn]:
    p = Path(path)
    return transcript.parse(p).turns if p.exists() else []


def window(turns: list[Turn], t0: float, t1: float) -> list[Turn]:
    return [t for t in turns if t0 <= t.ts < t1]


def _by_model(paths, t0, t1) -> dict[str, list[Turn]]:
    out: dict[str, list[Turn]] = {}
    for p in paths:
        for t in window(_turns_of(p), t0, t1):
            out.setdefault(t.model, []).append(t)
    return out


def tokens_by_model(paths, t0: float, t1: float) -> dict[str, dict]:
    return {m: {"input": sum(t.input for t in ts), "cache_read": sum(t.cache_read for t in ts),
                "cache_write": sum(t.cache_5m + t.cache_1h for t in ts), "output": sum(t.output for t in ts)}
            for m, ts in _by_model(paths, t0, t1).items()}


def usd_by_model(paths, t0: float, t1: float) -> dict[str, float]:
    out = {}
    for m, ts in _by_model(paths, t0, t1).items():
        try:
            out[m] = cost.spend(ts, m).dollars
        except ValueError:  # unknown model: listed, unpriced
            out[m] = 0.0
    return out


def pool_split(usd: dict[str, float]) -> dict:
    pools = {"fable": 0.0, "weekly": {"opus": 0.0, "sonnet": 0.0, "haiku": 0.0}}
    for m, d in usd.items():
        if "fable" in m:
            pools["fable"] += d
        else:
            for k in ("opus", "sonnet", "haiku"):
                if k in m:
                    pools["weekly"][k] += d
    return pools


def interventions(events: list[dict], t0: float, t1: float) -> dict[str, int]:
    n = {"keypress": 0, "decide": 0, "escalate": 0, "block": 0}
    for e in events:
        if not (t0 <= e.get("t", -1) < t1):
            continue
        if e.get("ev") in ("keypress", "decide"):
            n[e["ev"]] += 1
        elif e.get("ev") == "hook" and e.get("decision") in ("escalate", "block"):
            n[e["decision"]] += 1
    return n
