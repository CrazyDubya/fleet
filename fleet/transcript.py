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
    # Provider refusal, distinct from a model reply. Claude Code writes an
    # assistant record with isApiErrorMessage=true and error="rate_limit" (or
    # another API error string) and zero usage. Without this a quota wall
    # parsed as an ordinary end-of-turn and the thread read as idle - a broken-
    # looking thread with no handoff and no reason. Captured from a live
    # transcript 2026-09-04.
    api_error: str | None = None
    api_error_text: str = ""


@dataclass
class Parsed:
    turns: list[Turn] = field(default_factory=list)
    last_type: str | None = None
    last_ts: float | None = None
    errors: int = 0
    # The api_error of the most recent assistant turn, or None. Status keys the
    # `refused` state off this rather than re-deriving it from turns[-1].
    last_api_error: str | None = None


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
            # Treat non-dict records (null, arrays, numbers, etc.) as malformed
            if not isinstance(r, dict):
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
            api_error = r.get("error") if r.get("isApiErrorMessage") else None
            api_error_text = ""
            if api_error:
                c = m.get("content")
                if isinstance(c, list):
                    api_error_text = " ".join(
                        x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text"
                    ).strip()
                elif isinstance(c, str):
                    api_error_text = c.strip()
            out.last_api_error = api_error
            out.turns.append(Turn(
                ts=ts or 0.0, model=m.get("model", "?"), msg_id=mid,
                input=u.get("input_tokens", 0), cache_read=u.get("cache_read_input_tokens", 0),
                cache_5m=cc.get("ephemeral_5m_input_tokens", 0), cache_1h=cc.get("ephemeral_1h_input_tokens", 0),
                output=u.get("output_tokens", 0),
                thinking=(u.get("output_tokens_details") or {}).get("thinking_tokens", 0),
                stop_reason=m.get("stop_reason"),
                api_error=api_error, api_error_text=api_error_text,
            ))
    return out
