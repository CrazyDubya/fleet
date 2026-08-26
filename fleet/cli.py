import argparse
import sys

from . import ledger, launcher
from . import send as send_mod
from .registry import Registry


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
    try:
        n = send_mod.send(args.thread, " ".join(args.text), sender=args.sender)
    except send_mod.SendError as exc:
        print(f"error: {exc}", file=sys.stderr); return 1
    print(f"sent {n} bytes to {args.thread}"); return 0


def _build_parser():
    p = argparse.ArgumentParser(prog="fleet")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ls").set_defaults(fn=cmd_ls)
    m = sub.add_parser("miss"); m.add_argument("thread"); m.add_argument("reason", nargs="+"); m.set_defaults(fn=cmd_miss)
    for verb, fn in (("up", cmd_up), ("park", cmd_park), ("wake", cmd_wake), ("respawn", cmd_respawn)):
        s = sub.add_parser(verb); s.add_argument("thread"); s.set_defaults(fn=fn)
    f = sub.add_parser("fork"); f.add_argument("parent"); f.add_argument("new"); f.add_argument("--brief", required=True); f.set_defaults(fn=cmd_fork)
    s = sub.add_parser("send"); s.add_argument("thread"); s.add_argument("text", nargs="+"); s.add_argument("--from", dest="sender", default="operator"); s.set_defaults(fn=cmd_send)
    return p


def main(argv=None):
    args = _build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
