"""Pending permission prompts with Proceed/Deny, plus a raw keypress fallback (spec §3)."""
import os
import re

from fleet import ledger, prompts, spec, tmux
from gui.server import HttpError

# Both profiles' prompt dirs: WATCH is read once per widget by gui/watch.py at
# import time, so it cannot depend on FLEET_PROFILE (which a request may change
# between polls). Watching the inactive profile's dir costs one stat per tick.
WATCH = ["state/v2/prompts/*.json", "state/prompts/*.json"]
KEYS = {"1", "2", "3", "4", "Enter", "Escape"}
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")


def _profile() -> str:
    return os.environ.get("FLEET_PROFILE", "v2")


def _session() -> None:
    """Point fleet.tmux at the active profile's session.

    The GUI host never calls cli.activate_profile, so fleet.tmux.SESSION is
    still its "fleet" default - every pane capture and keypress for a v2 thread
    went to the v1 session (and silently found no window, or worse, a v1 window
    of the same name). Idempotent; called at the top of every route that talks
    to tmux.
    """
    tmux.use_session(spec.load_profile(_profile()).session)


def get(ctx):
    _session()
    items = []
    for rec in prompts.pending(_profile()):
        if not NAME.fullmatch(rec.get("thread", "")) or not re.fullmatch(r"[0-9a-f]{16}", rec.get("id", "")):
            continue
        try:
            pane = [l for l in tmux.capture(rec["thread"], lines=12).splitlines() if l.strip()][-12:]
        except Exception:
            pane = []
        items.append({**rec, "pane": pane})
    return {"items": items}


def decide(ctx):
    b = ctx.json(); thread, pid, decision = b.get("thread", ""), b.get("id", ""), b.get("decision", "")
    if not NAME.fullmatch(thread) or decision not in ("allow", "deny") or not re.fullmatch(r"[0-9a-f]{16}", pid):
        raise HttpError(400, "bad thread/id/decision")
    try:
        prompts.record_decision(thread, pid, decision, _profile())
    except FileNotFoundError:
        raise HttpError(404, "no such pending prompt")
    ledger.event("decide", thread=thread, id=pid, decision=decision, via="gui")
    ctx.publish("changed")
    return {"ok": True}


def keypress(ctx):
    _session()
    b = ctx.json(); thread, key = b.get("thread", ""), b.get("key", "")
    if not NAME.fullmatch(thread) or key not in KEYS:
        raise HttpError(400, "bad thread/key")
    if not tmux.window_exists(thread):
        raise HttpError(404, "no such window")
    tmux._run("send-keys", "-t", tmux._target(thread), key)
    ledger.event("keypress", thread=thread, key=key, via="gui")
    return {"ok": True}


ROUTES = {"": get, "decide": decide, "keypress": keypress}
