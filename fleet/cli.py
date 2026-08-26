import argparse
import sys

from . import ledger
from .registry import Registry


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


def _build_parser():
    p = argparse.ArgumentParser(prog="fleet")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ls").set_defaults(fn=cmd_ls)
    m = sub.add_parser("miss"); m.add_argument("thread"); m.add_argument("reason", nargs="+"); m.set_defaults(fn=cmd_miss)
    return p


def main(argv=None):
    args = _build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
