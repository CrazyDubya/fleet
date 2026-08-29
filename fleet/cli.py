import argparse
import json
import os
import re
import sys
from datetime import datetime

from . import ledger, launcher, telemetry, tmux
from . import registry as registry_mod
from . import send as send_mod
from . import spec as spec_mod
from . import status as status_mod
from .paths import profile_state
from .registry import Registry


def current_profile() -> str:
    """FLEET_PROFILE wins; otherwise fleet.toml [settings] default_profile (v1 if unset)."""
    env = os.environ.get("FLEET_PROFILE")
    if env:
        return env
    try:
        return spec_mod.load_settings()["default_profile"]
    except (OSError, KeyError):
        return "v1"


def activate_profile(name: str) -> spec_mod.Profile:
    prof = spec_mod.load_profile(name)
    tmux.use_session(prof.session)
    registry_mod.DEFAULT_PATH = profile_state(name) / "registry.json"
    os.environ["FLEET_PROFILE"] = name  # child processes (hooks, bin/fleet inside threads) inherit
    return prof


def _launch(fn):
    def run(args):
        try:
            e = fn(args)
        except launcher.LaunchError as exc:
            print(f"error: {exc}", file=sys.stderr); return 1
        print(f"{e.name}: {e.status} session={e.session_id}"); return 0
    return run


cmd_up = _launch(lambda a: launcher.up(a.thread))
cmd_park = _launch(lambda a: launcher.park(a.thread))
cmd_wake = _launch(lambda a: launcher.wake(a.thread))
cmd_respawn = _launch(lambda a: launcher.respawn(a.thread))
cmd_fork = _launch(lambda a: launcher.fork(a.parent, a.new, a.brief))


def cmd_ls(args):
    entries = Registry().load()
    if not entries:
        print("(no threads registered)"); return 0
    for name, e in sorted(entries.items()):
        print(f"{name:12} {e.status:8} {e.model:18} {e.session_id}")
    return 0


ABANDONED_RE = re.compile(r"^abandoned-([0-9a-f]{16})$")


def cmd_miss(args):
    reason = " ".join(args.reason)
    ledger.event("miss", thread=args.thread, reason=reason)
    # hold.sh tells the thread to run `fleet miss <you> abandoned-<id>` to drop
    # a reply it is no longer waiting for. Honour that literally: without
    # clearing the pending entry the Stop hook goes on blocking every turn and
    # the advice it prints is a dead end.
    m = ABANDONED_RE.match(reason.strip())
    if m:
        send_mod.clear_pending(args.thread, m.group(1), current_profile())
        print(f"dropped pending reply {m.group(1)} for {args.thread}")
    print(f"recorded miss for {args.thread}: {reason}")
    return 0


def cmd_send(args):
    text = " ".join(args.text)
    try:
        if not (args.lane or args.effort or args.reply or args.done or args.refs):
            n = send_mod.send(args.thread, text, sender=args.sender)
            print(f"sent {n} bytes to {args.thread}"); return 0
        from . import packet as packet_mod
        lane = args.lane or "build"
        ln = packet_mod.LANES[lane]
        p = packet_mod.Packet(to=args.thread, sender=args.sender, lane=lane, effort=args.effort or ln.effort,
                              reply=args.reply or ln.reply, refs=args.refs or [], done=args.done, body=text)
        pid = send_mod.send_packet(p, current_profile())
    except (send_mod.SendError, KeyError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr); return 1
    print(f"sent packet {pid} to {args.thread} lane={p.lane} effort={p.effort} reply={p.reply}"); return 0


def cmd_status(args):
    if args.watch:
        status_mod.watch(args.interval)
    else:
        print(status_mod.render(status_mod.rows()))
    return 0


def cmd_telemetry(args):
    # LOCAL today: telemetry days are local days (see telemetry._day_bounds),
    # and the nightly launchd job fires at 23:55 local.
    day = args.day or datetime.now().strftime("%Y-%m-%d")
    for r in telemetry.derive_day(day):
        print(json.dumps(r, sort_keys=True))
    return 0


def cmd_report(args):
    print(telemetry.report()); return 0


def cmd_decide(args):
    from . import prompts as prompts_mod
    try:
        prompts_mod.record_decision(args.thread, args.id, args.decision, current_profile())
    except FileNotFoundError:
        print(f"error: no pending prompt {args.thread}-{args.id}", file=sys.stderr); return 1
    ledger.event("decide", thread=args.thread, id=args.id, decision=args.decision)
    print(f"{args.decision}: {args.thread} {args.id}"); return 0


def cmd_hook_event(args):
    ledger.event("hook", hook=args.hook, thread=args.thread, decision=args.decision, ms=args.ms, why=" ".join(args.why)[:300])
    return 0


def cmd_perm_decide(args):
    from . import prompts as prompts_mod
    from .paths import ROOT
    d, why = prompts_mod.decide_auto(args.command, ROOT)
    if d != "escalate":
        print(d); return 0
    path = prompts_mod.open_prompt(args.thread, "Bash", args.command, args.cwd, current_profile())
    ledger.event("hook", hook="perm", thread=args.thread, decision="escalate", ms=0, why=why)
    got = prompts_mod.wait_decision(path, timeout=240.0)
    print(got or "escalate-timeout"); return 0


def cmd_perm_check(args):
    """Policy question only: `deny` or `ok`, no prompt file, no waiting.

    perm-decide is the PermissionRequest path (it may escalate and block for
    the operator up to 4 minutes). The PreToolUse gate needs the same policy
    without either of those: the tool tier runs with permission_mode that
    never reaches a PermissionRequest, so gate.sh is the only place a
    destructive Bash command can be stopped, and a hook has 3 seconds.
    """
    from . import prompts as prompts_mod
    from .paths import ROOT
    d, why = prompts_mod.decide_auto(args.command, ROOT)
    if d == "deny":
        print("deny"); print(why, file=sys.stderr); return 0
    print("ok"); return 0


def cmd_ask(args):
    from . import ask as ask_mod
    try:
        print(ask_mod.ask(args.thread, " ".join(args.text), sender=args.sender, profile=current_profile(),
                          timeout=args.timeout))
    except ask_mod.AskTimeout as exc:
        print(f"error: {exc}", file=sys.stderr); return 3
    except send_mod.SendError as exc:
        print(f"error: {exc}", file=sys.stderr); return 1
    return 0


def _build_parser():
    p = argparse.ArgumentParser(prog="fleet")
    p.add_argument("--profile", default=None)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ls").set_defaults(fn=cmd_ls)
    m = sub.add_parser("miss"); m.add_argument("thread"); m.add_argument("reason", nargs="+"); m.set_defaults(fn=cmd_miss)
    for verb, fn in (("up", cmd_up), ("park", cmd_park), ("wake", cmd_wake), ("respawn", cmd_respawn)):
        s = sub.add_parser(verb); s.add_argument("thread"); s.set_defaults(fn=fn)
    f = sub.add_parser("fork"); f.add_argument("parent"); f.add_argument("new"); f.add_argument("--brief", required=True); f.set_defaults(fn=cmd_fork)
    s = sub.add_parser("send"); s.add_argument("thread"); s.add_argument("text", nargs="+")
    s.add_argument("--from", dest="sender", default="operator")
    s.add_argument("--lane", choices=["lookup", "build", "plan", "judge", "consult"])
    s.add_argument("--effort", choices=["low", "med", "medium", "high"])
    s.add_argument("--reply", choices=["inline", "file", "none"])
    s.add_argument("--done"); s.add_argument("--refs", nargs="*")
    s.set_defaults(fn=cmd_send)
    s = sub.add_parser("status"); s.add_argument("--watch", action="store_true"); s.add_argument("--interval", type=int, default=10); s.set_defaults(fn=cmd_status)
    t = sub.add_parser("telemetry"); t.add_argument("--day"); t.set_defaults(fn=cmd_telemetry)
    sub.add_parser("report").set_defaults(fn=cmd_report)
    a = sub.add_parser("ask"); a.add_argument("thread"); a.add_argument("text", nargs="+")
    a.add_argument("--from", dest="sender", default="operator")
    a.add_argument("--timeout", type=float, default=30.0)
    a.set_defaults(fn=cmd_ask)
    d = sub.add_parser("decide"); d.add_argument("thread"); d.add_argument("id"); d.add_argument("decision", choices=["allow", "deny"]); d.set_defaults(fn=cmd_decide)
    h = sub.add_parser("hook-event"); h.add_argument("hook"); h.add_argument("thread"); h.add_argument("decision")
    h.add_argument("ms", type=int); h.add_argument("why", nargs="*"); h.set_defaults(fn=cmd_hook_event)
    pd = sub.add_parser("perm-decide"); pd.add_argument("thread"); pd.add_argument("cwd"); pd.add_argument("command"); pd.set_defaults(fn=cmd_perm_decide)
    pc = sub.add_parser("perm-check"); pc.add_argument("command"); pc.set_defaults(fn=cmd_perm_check)
    return p


def main(argv=None):
    args = _build_parser().parse_args(argv)
    activate_profile(args.profile or current_profile())
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
