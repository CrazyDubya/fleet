"""Detect fleet-wide silence and say whose fault it is.

A naive timer ("no event for N minutes") cannot tell two situations apart,
and they call for opposite responses:

  - **stuck**: a dispatch is open (per `fleet.outstanding`) and nothing has
    happened anywhere in the fleet for N minutes. A thread is wedged, or it
    finished and never filed a handoff. This is the fleet's fault.
  - **idle queue**: the same silence, but nothing is outstanding. There is
    genuinely nothing running because nobody assigned anything. This is the
    operator's fault, and no amount of alerting the fleet fixes it.

`check()` reuses `outstanding.outstanding()` for the open-assignment side of
that distinction rather than re-deriving it - the two questions ("is anyone
stuck" and "has anything happened") share the same evidence.

N (the silence threshold) is chosen from the real gap distribution in the
ledger, not intuition - see the derivation recorded in
ledger/handoffs/sonnet4/. Ordinary per-event spacing across a real 28-hour
window sits under ~1.5 minutes even at the 99.9th percentile, and the first
genuine fleet-wide silence in that window is 14.2 minutes - the gap between
them is wide and completely empty (nothing in the real log falls between
10 and 14 minutes), so 10 minutes catches every real silence with room to
spare on both sides, and matches opus2's own reference threshold in
ledger/handoffs/opus2/20260906T042000Z-completion-event.md.

Same discipline as `outstanding`: a ledger that is missing, unreadable, or
empty is not "no alert" - it is its own loud, distinct state, because a
watchdog whose own input has gone silent is indistinguishable from a
healthy fleet unless it says so explicitly.
"""
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import ledger
from . import outstanding as outstanding_mod

DEFAULT_MINUTES = 10.0


@dataclass
class Status:
    ledger_status: str  # "missing" | "unreadable" | "empty" | "ok"
    ledger_path: str
    threshold_min: float
    idle_s: float | None = None
    alert: str | None = None  # None | "stuck" | "idle_queue" | "degraded"
    open_items: list = field(default_factory=list)

    def describe(self) -> str:
        if self.ledger_status != "ok":
            return (
                f"DEGRADED: ledger at {self.ledger_path} is {self.ledger_status} - this "
                f"watchdog cannot see whether the fleet is healthy or stuck, which is not "
                f"the same thing as the fleet being healthy. Treat as an alert."
            )
        mins = (self.idle_s or 0) / 60
        if self.alert is None:
            return f"quiet: last fleet-wide event {mins:.1f}m ago (< {self.threshold_min:.0f}m threshold)."
        if self.alert == "stuck":
            lines = [
                f"ALERT (stuck): no thread has emitted any event for {mins:.1f}m, and "
                f"{len(self.open_items)} dispatch(es) are still open - a thread is wedged, or "
                f"finished without filing a handoff:"
            ]
            for i in self.open_items:
                age_m = (i.age_s or 0) / 60
                lines.append(f"  {i.d.id}  {i.d.thread:14}  open {age_m:.0f}m  \u2014 {i.d.done or '(no @done recorded)'}")
            return "\n".join(lines)
        return (
            f"ALERT (idle queue): no thread has emitted any event for {mins:.1f}m, and nothing "
            f"is outstanding. Nobody is stuck - the fleet is waiting on a dispatch from you."
        )


def _last_event_t(path: Path, tail: int = 50) -> float | None:
    """Timestamp of the most recent event, read from the tail of the ledger
    rather than the whole file - fleet-wide idle only needs the newest
    record, and this file grows without bound.
    """
    events = ledger.read_events(path, tail=tail)
    ts = [e.get("t") for e in events if isinstance(e.get("t"), (int, float))]
    return max(ts) if ts else None


def check(profile: str = "v2", events_path: Path | None = None,
          handoffs_root: Path = outstanding_mod.HANDOFFS,
          threshold_min: float = DEFAULT_MINUTES, now: float | None = None) -> Status:
    now = now if now is not None else time.time()
    path = events_path or ledger.EVENTS
    lstatus = ledger.status(path)
    if lstatus != "ok":
        return Status(ledger_status=lstatus, ledger_path=str(path), threshold_min=threshold_min,
                      alert="degraded")
    last_t = _last_event_t(path)
    if last_t is None:
        # The file exists and is readable but every line failed to parse, or
        # none carried a timestamp - functionally the same blindness as an
        # empty ledger, so it gets the same loud treatment, not a silent 0.
        return Status(ledger_status="empty", ledger_path=str(path), threshold_min=threshold_min,
                      alert="degraded")
    idle_s = now - last_t
    threshold_s = threshold_min * 60
    if idle_s < threshold_s:
        return Status(ledger_status="ok", ledger_path=str(path), threshold_min=threshold_min, idle_s=idle_s)
    report = outstanding_mod.outstanding(profile=profile, events_path=events_path,
                                         handoffs_root=handoffs_root, now=now)
    open_items = report.outstanding if report.ledger_status == "ok" else []
    alert = "stuck" if open_items else "idle_queue"
    return Status(ledger_status="ok", ledger_path=str(path), threshold_min=threshold_min,
                  idle_s=idle_s, alert=alert, open_items=open_items)


def fleet_wide_gaps(path: Path, window_s: float | None = None, min_gap_s: float = 600.0) -> list[float]:
    """Durations (seconds) of every fleet-wide silence >= min_gap_s in the
    trailing window_s seconds of the ledger (the whole file if None).

    A "fleet-wide silence" is a gap between two consecutive events of ANY
    kind, from ANY thread - hook events fire on nearly every tool call from
    any active thread, so this is a strong, low-noise signal: nothing in
    the entire fleet did anything for that long. This is the same
    methodology opus2 used to find fourteen silences over ten minutes in a
    28.2-hour window (longest 218) - reproduced here as a function so the
    threshold in DEFAULT_MINUTES stays checkable against the real log
    rather than asserted once and left to rot.
    """
    events = ledger.read_events(path)
    times = sorted(e["t"] for e in events if isinstance(e.get("t"), (int, float)))
    if window_s is not None and times:
        cutoff = times[-1] - window_s
        times = [t for t in times if t >= cutoff]
    return [b - a for a, b in zip(times, times[1:]) if b - a >= min_gap_s]
