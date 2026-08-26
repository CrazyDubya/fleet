from dataclasses import dataclass

from .transcript import Turn

RATES = {  # $ per million tokens: (input, output)
    "claude-sonnet-5": (2.0, 10.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-haiku-4-5": (1.0, 5.0),
}
READ_MULT = 0.1
WRITE_5M = 1.25
WRITE_1H = 2.0


def _rate(model: str) -> tuple[float, float]:
    for k, v in RATES.items():
        if model.startswith(k):
            return v
    return (0.0, 0.0)


def _write_mult(ttl_minutes: int) -> float:
    return WRITE_1H if ttl_minutes >= 60 else WRITE_5M


def warmth(last_turn_ts: float | None, now: float, ttl_minutes: int) -> tuple[str, int]:
    if last_turn_ts is None:
        return ("new", 0)
    minutes = int((now - last_turn_ts) // 60)
    if minutes < 0.75 * ttl_minutes:
        return ("hot", minutes)
    if minutes < ttl_minutes:
        return ("cooling", minutes)
    return ("cold", minutes)


def observed_ttl_minutes(turns: list[Turn], default: int) -> int:
    if any(t.cache_1h > 0 for t in turns):
        return 60
    if any(t.cache_5m > 0 for t in turns):
        return 5
    return default


def context_size(turns: list[Turn]) -> int:
    if not turns:
        return 0
    t = turns[-1]
    return t.input + t.cache_read + t.cache_5m + t.cache_1h


@dataclass
class Spend:
    read: int
    written: int
    output: int
    dollars: float


def spend(turns: list[Turn], model: str) -> Spend:
    rin, rout = _rate(model)
    read = sum(t.cache_read for t in turns)
    w5 = sum(t.cache_5m for t in turns)
    w1 = sum(t.cache_1h for t in turns)
    uncached = sum(t.input for t in turns)
    out = sum(t.output for t in turns)
    dollars = (read * rin * READ_MULT + w5 * rin * WRITE_5M + w1 * rin * WRITE_1H
               + uncached * rin + out * rout) / 1e6
    return Spend(read=read, written=w5 + w1, output=out, dollars=dollars)


def resume_cost(context_tokens: int, model: str, ttl_minutes: int) -> float:
    return context_tokens * _rate(model)[0] * _write_mult(ttl_minutes) / 1e6


def respawn_cost(baseline_bytes: int, model: str, ttl_minutes: int) -> float:
    return resume_cost(baseline_bytes // 4, model, ttl_minutes)
