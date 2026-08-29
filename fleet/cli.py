import argparse
import json
import os
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
    return os.environ.get("FLEET_PROFILE", "v1")


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


def cmd_miss(args):
    ledger.event("miss", thread=args.thread, reason=" ".join(args.reason))
    print(f"recorded miss for {args.thread}: {' '.join(args.reason)}")
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
    return p


def main(argv=None):
    args = _build_parser().parse_args(argv)
    activate_profile(args.profile or current_profile())
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
