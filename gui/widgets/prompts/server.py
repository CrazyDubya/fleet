"""Pending permission prompts with Proceed/Deny, plus a raw keypress fallback (spec §3)."""
import os
import re

from fleet import ledger, prompts, tmux
from gui.server import HttpError

WATCH = ["state/v2/prompts/*.json", "state/prompts/*.json"]
KEYS = {"1", "2", "3", "4", "Enter", "Escape"}
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")


def _profile() -> str:
    return os.environ.get("FLEET_PROFILE", "v2")


def get(ctx):
    items = []
    for rec in prompts.pending(_profile()):
        try:
            pane = [l for l in tmux.capture(rec["thread"], lines=12).splitlines() if l.strip()][-12:]
        except Exception:
            pane = []
        items.append({**rec, "pane": pane})
    return {"items": items}


def decide(ctx):
    b = ctx.json(); thread, pid, decision = b.get("thread", ""), b.get("id", ""), b.get("decision", "")
    if not NAME.match(thread) or decision not in ("allow", "deny") or not re.fullmatch(r"[0-9a-f]{16}", pid):
        raise HttpError(400, "bad thread/id/decision")
    try:
        prompts.record_decision(thread, pid, decision, _profile())
    except FileNotFoundError:
        raise HttpError(404, "no such pending prompt")
    ledger.event("decide", thread=thread, id=pid, decision=decision, via="gui")
    ctx.publish("changed")
    return {"ok": True}


def keypress(ctx):
    b = ctx.json(); thread, key = b.get("thread", ""), b.get("key", "")
    if not NAME.match(thread) or key not in KEYS:
        raise HttpError(400, "bad thread/key")
    tmux._run("send-keys", "-t", tmux._target(thread), key)
    ledger.event("keypress", thread=thread, key=key, via="gui")
    return {"ok": True}


ROUTES = {"": get, "decide": decide, "keypress": keypress}
