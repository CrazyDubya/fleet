import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path


@dataclass
class Turn:
    ts: float
    model: str
    msg_id: str
    input: int
    cache_read: int
    cache_5m: int
    cache_1h: int
    output: int
    thinking: int
    stop_reason: str | None


@dataclass
class Parsed:
    turns: list[Turn] = field(default_factory=list)
    last_type: str | None = None
    last_ts: float | None = None
    errors: int = 0


def _ts(s: str | None) -> float | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()


def parse(path: Path) -> Parsed:
    out = Parsed()
    if not path.exists():
        return out
    seen: set[str] = set()
    with open(path) as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                out.errors += 1
                continue
            t = r.get("type")
            ts = _ts(r.get("timestamp"))
            if t in ("user", "assistant") and ts is not None:
                out.last_type, out.last_ts = t, ts
            if t != "assistant":
                continue
            m = r.get("message") or {}
            mid = m.get("id") or r.get("uuid", "")
            if mid in seen:
                continue
            seen.add(mid)
            u = m.get("usage") or {}
            cc = u.get("cache_creation") or {}
            out.turns.append(Turn(
                ts=ts or 0.0, model=m.get("model", "?"), msg_id=mid,
                input=u.get("input_tokens", 0), cache_read=u.get("cache_read_input_tokens", 0),
                cache_5m=cc.get("ephemeral_5m_input_tokens", 0), cache_1h=cc.get("ephemeral_1h_input_tokens", 0),
                output=u.get("output_tokens", 0),
                thinking=(u.get("output_tokens_details") or {}).get("thinking_tokens", 0),
                stop_reason=m.get("stop_reason"),
            ))
    return out
