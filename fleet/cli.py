import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from . import backlog as backlog_mod, ledger, launcher, outstanding as outstanding_mod, telemetry, tmux, watchdog as watchdog_mod
from . import packet as packet_mod
from . import registry as registry_mod
from . import send as send_mod
from . import spec as spec_mod
from . import status as status_mod
from .paths import ROOT, profile_state
from .registry import Registry


_SETTINGS: dict | None = None


def settings(refresh: bool = False) -> dict:
    """fleet.toml `[settings]`, parsed once per process.

    spec.load_settings() re-opens and re-parses fleet.toml on every call, and
    current_profile() is asked from a dozen places (cmd_send, cmd_ask,
    cmd_decide, status._specs, launcher._thread, the GUI prompts widget) - one
    CLI invocation was parsing the same file several times over. Nothing
    rewrites `[settings]` while a process runs; activate_profile() refreshes
    the cache anyway so a long-lived host that re-activates picks up an edit.
    """
    global _SETTINGS
    if refresh or _SETTINGS is None:
        _SETTINGS = spec_mod.load_settings()
    return _SETTINGS


def current_profile() -> str:
    """FLEET_PROFILE wins; otherwise fleet.toml [settings] default_profile (v1 if unset)."""
    env = os.environ.get("FLEET_PROFILE")
    if env:
        return env
    try:
        return settings()["default_profile"]
    except (OSError, KeyError):
        return "v1"


def activate_profile(name: str) -> spec_mod.Profile:
    settings()  # prime the per-process cache: every later current_profile() is free
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
    if m and send_mod.clear_pending(args.thread, m.group(1), current_profile()):
        # Only when something was actually removed: "dropped pending reply
        # <id>" printed for an id that was never in the list reads as a fix
        # that did not happen.
        print(f"dropped pending reply {m.group(1)} for {args.thread}")
    print(f"recorded miss for {args.thread}: {reason}")
    return 0


def cmd_send(args):
    text = " ".join(args.text)
    try:
        if not (args.lane or args.effort or args.reply or args.done or args.refs):
            n = send_mod.send(args.thread, text, sender=args.sender)
            print(f"sent {n} bytes to {args.thread}"); return 0
        lane = args.lane or "build"
        ln = packet_mod.LANES[lane]
        p = packet_mod.Packet(to=args.thread, sender=args.sender, lane=lane, effort=args.effort or ln.effort,
                              reply=args.reply or ln.reply, refs=args.refs or [], done=args.done, body=text)
        pid = send_mod.send_packet(p, current_profile())
    except (send_mod.SendError, KeyError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr); return 1
    print(f"sent packet {pid} to {args.thread} lane={p.lane} effort={p.effort} reply={p.reply}"); return 0


def _project_rows():
    """Health for every declared project; [] if none declared, None if the check broke.

    Never allowed to break `fleet status`: projects are watched repos, and a
    project whose status file has gone missing must not take the thread table
    down with it.

    FLEET-CODE-REVIEW item 4: the two outcomes used to collapse into the same [].
    A crashed health check and an empty `fleet.toml` rendered identically, and
    `fleet projects` answered "no [[project]] declared" - a false statement, made
    to an operator deciding whether it is safe to dispatch into a repo another
    agent may be working in. The health check is advisory (nothing enforces
    dispatch_blocked mechanically), so there is no gate to fail closed into; the
    fix is that the tool stops lying about why it has nothing to say.
    """
    from fleet import projects as projects_mod
    from fleet.registry import Registry
    try:
        ps = projects_mod.load()
        if not ps:
            return []
        # fleet's own threads are always "live" on a project they steer; they
        # must not read as a foreign agent blocking dispatch to themselves.
        mine = {e.session_id for e in Registry().load().values()}
        return projects_mod.rows(projects=ps, exclude_sessions=mine)
    except Exception as exc:
        print(f"project health check failed: {exc!r}", file=sys.stderr)
        return None


def cmd_status(args):
    if args.watch:
        status_mod.watch(args.interval)
        return 0
    print(status_mod.render(status_mod.rows()))
    from fleet import projects as projects_mod
    hs = _project_rows()
    if hs is None:
        print()
        print("  ! project health check failed - dispatch guard unavailable, see stderr")
    elif hs:
        print()
        print(projects_mod.render(hs))
        for h in hs:
            if not h.ok:
                print(f"  ! {h.project}: {h.state} - dispatch to {h.thread or '(no thread)'}")
    return 0


def cmd_projects(args):
    from fleet import agents as agents_mod, projects as projects_mod
    hs = _project_rows()
    if hs is None:
        print("project health check failed - dispatch guard unavailable, see stderr")
        print("this is NOT the same as no projects being declared; do not read it as all-clear")
        return 1
    if not hs:
        print("no [[project]] declared in fleet.toml")
        return 0
    print(projects_mod.render(hs))
    for h in hs:
        blocked = projects_mod.dispatch_blocked(h)
        print(f"\n{h.project}  {h.dir}")
        print(f"  status   {h.status_file or '(none found)'}")
        print(f"  dispatch {'BLOCKED - ' + blocked if blocked else 'clear'}")
        if args.agents:
            acts = agents_mod.by_cwd(agents_mod.scan(since=None)).get(h.dir, [])
            print(f"  agents   {len(acts)} session(s) ever")
            for a in acts[-args.agents:]:
                when = datetime.fromtimestamp(a.last).strftime("%m-%d %H:%M")
                print(f"    {when}  {a.agent:6} {a.model or '?':24} {a.session[:8]}")
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


def cmd_outstanding(args):
    events_path = Path(args.events_path) if args.events_path else None
    report = outstanding_mod.outstanding(profile=current_profile(), events_path=events_path)
    print(report.describe())
    # A degenerate ledger (missing/unreadable/empty) is not "0 outstanding" -
    # it means this command could not check, and a caller scripting off the
    # exit code must not read that as a clean bill of health either.
    return 1 if report.ledger_status != "ok" or report.outstanding else 0


def cmd_backlog(args):
    path = Path(args.path) if args.path else backlog_mod.DEFAULT_PATH
    bl = backlog_mod.read(path)
    if bl.file_status != "ok":
        print(f"{bl.path}: {bl.file_status} - cannot tell whether there is a backlog")
        return 1
    print(f"{bl.path}: {bl.count} open item(s)")
    for it in bl.items:
        print(f"  {it.id}  {it.thread or '?':14}  {it.expects}")
    return 0


def cmd_watchdog(args):
    events_path = Path(args.events_path) if args.events_path else None
    kwargs = {}
    if args.backlog_path:
        kwargs["backlog_path"] = Path(args.backlog_path)
    status = watchdog_mod.check(profile=current_profile(), events_path=events_path,
                                 threshold_min=args.minutes, **kwargs)
    print(status.describe())
    return 0 if status.alert is None else 1


# How long to wait, after writing a decision, for the waiting `wait_decision`
# poll loop (fleet/prompts.py) to notice and consume (unlink) the prompt
# file - proof the decision actually reached a live listener rather than
# sitting on disk unread. wait_decision polls every 0.5s, so this only ever
# costs real time when there is no listener at all, which is exactly the
# case this exists to catch.
DECIDE_CONFIRM_TIMEOUT_S = 3.0


def cmd_decide(args):
    from . import prompts as prompts_mod
    try:
        path = prompts_mod.record_decision(args.thread, args.id, args.decision, current_profile())
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        print(f"error: no pending prompt {args.thread}-{args.id} ({exc})", file=sys.stderr); return 1
    ledger.event("decide", thread=args.thread, id=args.id, decision=args.decision)
    # A decide event landing is NOT the same as the decision taking effect.
    # wait_decision only unblocks the waiting thread by consuming (unlinking)
    # this exact file - if its own process already died (a hook timeout
    # killing it before its own `finally: path.unlink()` runs is a real,
    # reproduced failure: ledger/handoffs/sonnet4/20260906T211500Z-decide-
    # silent-noop.md), nothing is left to notice this decision. Without this
    # check `fleet decide` printed an identical "success" line whether or
    # not anything downstream actually happened, which reads from outside as
    # a thread stalled on its own prompt.
    deadline = time.monotonic() + DECIDE_CONFIRM_TIMEOUT_S
    while path.exists() and time.monotonic() < deadline:
        time.sleep(0.1)
    if path.exists():
        print(f"error: {args.decision} recorded for {args.thread} {args.id} and logged to the ledger, "
              f"but nothing consumed the prompt file within {DECIDE_CONFIRM_TIMEOUT_S:.0f}s - its waiter "
              f"is not listening (most likely died before writing the decision). The thread is NOT "
              f"unblocked; this decision had no effect.", file=sys.stderr)
        return 1
    print(f"{args.decision}: {args.thread} {args.id}"); return 0


def cmd_hook_event(args):
    ledger.event("hook", hook=args.hook, thread=args.thread, decision=args.decision, ms=args.ms, why=" ".join(args.why)[:300])
    return 0


def _thread_roots(thread: str) -> tuple[str, ...]:
    """Directories this thread legitimately works in besides the fleet repo.

    A [[project]] thread declares `dir`; that dir IS its workspace, so paths
    under it are in-repo for that thread and nobody else. Resolved from the
    spec, not from the caller's cwd, so a thread cannot widen its own boundary
    by cd-ing somewhere.
    """
    try:
        t = spec_mod.active_threads(current_profile()).get(thread)
    except (OSError, KeyError):  # unreadable/unknown profile: no extra roots
        return ()
    return (str(Path(t.dir).resolve()),) if t and t.dir else ()


def cmd_perm_decide(args):
    from . import prompts as prompts_mod
    from .paths import ROOT
    # args.cwd is the thread's actual directory. Passing it is what lets a
    # relative path be judged from where the command really runs; without it
    # everything resolved against ROOT and `ls ../e4/` from games/pinball-lab
    # read as /Users/e4 and escalated a read that is inside the repo.
    d, why = prompts_mod.decide_auto(args.command, ROOT, args.cwd,
                                     extra_roots=_thread_roots(args.thread))
    if d != "escalate":
        print(d); return 0
    path = prompts_mod.open_prompt(args.thread, "Bash", args.command, args.cwd, current_profile())
    ledger.event("hook", hook="perm", thread=args.thread, decision="escalate", ms=0, why=why)
    got = prompts_mod.wait_decision(path, timeout=240.0)
    print(got or "escalate-timeout"); return 0


def _gate_thread(thread: str | None):
    """The spec for `thread`, or None when there isn't one to be had."""
    if not thread:
        return None
    try:
        return spec_mod.active_threads(current_profile()).get(thread)
    except (OSError, KeyError):  # unreadable/unknown profile
        return None


def _gate_roots(thread: str | None) -> tuple[str, ...]:
    """Containment roots for the PreToolUse gate: every directory the spec
    already grants this thread, plus a [[project]] thread's own repo.

    Wider than _thread_roots, and only here. perm-decide can escalate a path it
    is unsure about to a human; the gate cannot, so from the moment escalate
    stops meaning "allow anyway" (see cmd_perm_check) an unlisted root turns
    into a hard block on sanctioned work - haiku-fs2's entire job is lookups
    across /Users/pup, which is exactly what its `dirs` grants it at spawn.
    Reading a root the operator already granted is not a widening of policy;
    inventing one the spec does not mention would be.
    """
    t = _gate_thread(thread)
    if not t:
        return ()
    roots = [str(Path(d).resolve()) for d in t.dirs]
    if t.dir:
        roots.append(str(Path(t.dir).resolve()))
    return tuple(roots)


def _operator_fallthrough(thread: str | None) -> bool:
    """Can an escalate for this thread still reach a human?

    Only if its permission mode raises a PermissionRequest at all.
    bypassPermissions raises none, which is precisely why the gate is the last
    check those threads have. An unknown thread counts as no fallthrough: "no
    answer" must not read as yes, the same rule gate.sh applies to a missing jq.
    """
    t = _gate_thread(thread)
    return bool(t) and t.permission_mode != "bypassPermissions"


def cmd_perm_check(args):
    """The PreToolUse gate's oracle. Prints "<verdict> <fallthrough> <why>".

    `verdict` is decide_auto's own answer, unflattened: deny, escalate or ok.
    It used to print "ok" for escalate, which turned a three-way policy into a
    two-way one for the single caller that has nothing behind it: every
    escalate-class command - a non-loopback URL, a path outside the thread's
    roots, a quoted `rm` inside a python -c - read to gate.sh as sanctioned.

    `fallthrough` is whether an escalate can still reach a human: "prompt" when
    the thread's permission mode raises a PermissionRequest (perm.sh asks the
    operator, so the gate must NOT block those - blocking at PreToolUse
    pre-empts the very prompt that would resolve it), "none" when it does not.
    The gate blocks deny always, and escalate only when fallthrough is none.

    decide_auto's reason follows as the rest of the line, so a blocked command
    reaches the ledger with WHY it was blocked - the only way the operator can
    tell a real catch from a false positive without re-deriving it. It rides on
    stdout, not stderr, so gate.sh can keep 2>/dev/null: merging stderr would
    let a stray python warning parse as the verdict, in a hook that fails
    closed on anything it cannot parse.

    Still no prompt file and no waiting either way: a hook has ~3 seconds.
    """
    from . import prompts as prompts_mod
    from .paths import ROOT
    thread = getattr(args, "thread", None)
    cwd = getattr(args, "cwd", None) or None
    d, why = prompts_mod.decide_auto(args.command, ROOT, cwd,
                                     extra_roots=_gate_roots(thread))
    verdict = "ok" if d == "allow-auto" else d
    print(f"{verdict} {'prompt' if _operator_fallthrough(thread) else 'none'} {why}")
    _log_outside_roots(thread, d, args.command, ROOT, cwd)
    return 0


def _log_outside_roots(thread: str | None, verdict: str, command: str, root: Path,
                       cwd: str | None) -> None:
    """Option B's dirs-narrowing measurement (see
    ledger/handoffs/opus2/20260913T030809Z-case-symlink-bypass-fixed.md and
    ledger/handoffs/sonnet2/20260913T193000Z-dirs-hardening-option-b-measurement.md):
    for an allow-auto Bash command on a tool-tier thread, log the top-level
    directories outside `root` it touched, so a future `dirs` grant can be
    narrowed from real usage.

    Observation only - this never influences `verdict`, runs after it is
    already printed, and only appends a ledger line when there is something
    outside `root` to report (an in-repo-only command logs nothing new here;
    the existing `gate allow` event already counts it). One extra Path/regex
    pass and one `ledger.event` file-append inside the same already-running
    perm-check process - no new subprocess, so no added latency on the
    gate's ~150ms budget.
    """
    if verdict != "allow-auto" or not command:
        return
    t = _gate_thread(thread)
    if not t or t.tier != "tool":
        return
    from . import prompts as prompts_mod
    roots = prompts_mod.outside_top_roots(command, root, cwd)
    if not roots:
        return
    ledger.event("hook", hook="gate", thread=thread, decision="outside-root", ms=0,
                 why=",".join(roots)[:300])


def cmd_path_check(args):
    """The file-tool gate's oracle: same "<verdict> <fallthrough> <why>" as
    perm-check, for a tool that hands over a path instead of a command.

    Read/Edit/Write/NotebookEdit reach the filesystem without passing through
    decide_auto at all, and under bypassPermissions --add-dir does not confine
    them either (verified: a tool thread read /etc/hosts on request). Asking
    the same policy here is what keeps the two channels from disagreeing -
    a credential refused to `cat` should not be one Read call away.
    """
    from . import prompts as prompts_mod
    from .paths import ROOT
    thread = getattr(args, "thread", None)
    d, why = prompts_mod.path_verdict(args.path, ROOT, getattr(args, "cwd", None) or None,
                                      extra_roots=_gate_roots(thread))
    verdict = "ok" if d == "allow-auto" else d
    print(f"{verdict} {'prompt' if _operator_fallthrough(thread) else 'none'} {why}")
    return 0


def cmd_web_check(args):
    """Egress oracle for hooks/v2/web.sh: "deny <host>" or "ok".

    Same denylist the Bash path uses (fleet.prompts.EXFIL_HOSTS), asked from
    one place so a URL that is refused to curl is not quietly available to
    WebFetch.
    """
    from . import prompts as prompts_mod
    host = prompts_mod.exfil_host(args.url)
    if host:
        print(f"deny {host}"); print(f"known exfil sink ({host}): {args.url}", file=sys.stderr); return 0
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


def cmd_bench(args):
    if args.bench_cmd == "run":
        from fleet.bench import run as brun
        from fleet.bench import arms as arms_mod
        arms = args.arms.split(",")
        # derived, never a fourth hardcoded list: declaring haiku-swarm in
        # arms.SWARM_ARMS and wiring it into the runner and the report still left
        # this whitelist rejecting it as an unknown arm.
        known = set(arms_mod.ARMS) | set(arms_mod.SWARM_ARMS) | {"fleet"}
        bad = [a for a in arms if a not in known]
        if bad:
            print(f"error: unknown arm(s): {', '.join(bad)}", file=sys.stderr); return 1
        ids = None
        if args.task != "all":
            from fleet.bench import tasks as btasks
            if args.task not in {t.id for t in btasks.load_all(ROOT / "bench" / "tasks")}:
                print(f"error: no such task {args.task}", file=sys.stderr); return 1
            ids = [args.task]
        brun.run_many(ids, arms, repeat=args.repeat)
        return 0
    from fleet.bench import report as breport, run as brun
    since = None
    if args.since:
        try:
            since = datetime.strptime(args.since, "%Y-%m-%d").timestamp()
        except ValueError:
            print("error: --since must be YYYY-MM-DD", file=sys.stderr); return 1
    print(breport.render(breport.summarize(breport.load(brun.RUNS, since))))
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
    s.add_argument("--lane", choices=["lookup", "build", "plan", "judge", "consult", "verify"])
    s.add_argument("--effort", choices=["low", "med", "medium", "high"])
    s.add_argument("--reply", choices=["inline", "file", "none"])
    s.add_argument("--done"); s.add_argument("--refs", nargs="*")
    s.set_defaults(fn=cmd_send)
    s = sub.add_parser("status"); s.add_argument("--watch", action="store_true"); s.add_argument("--interval", type=int, default=10); s.set_defaults(fn=cmd_status)
    pj = sub.add_parser("projects"); pj.add_argument("--agents", type=int, default=0, metavar="N",
                                                    help="also list the last N agent sessions per project")
    pj.set_defaults(fn=cmd_projects)
    t = sub.add_parser("telemetry"); t.add_argument("--day"); t.set_defaults(fn=cmd_telemetry)
    sub.add_parser("report").set_defaults(fn=cmd_report)
    o = sub.add_parser("outstanding")
    o.add_argument("--events-path", help="ledger events file to read instead of ledger/events.jsonl "
                    "(also exercises the missing/unreadable/empty ledger guards from the CLI)")
    o.set_defaults(fn=cmd_outstanding)
    w = sub.add_parser("watchdog")
    w.add_argument("--events-path", help="ledger events file to read instead of ledger/events.jsonl")
    w.add_argument("--minutes", type=float, default=watchdog_mod.DEFAULT_MINUTES,
                    help="fleet-wide silence threshold in minutes (default: %(default)s, "
                         "derived from the real gap distribution - see fleet/watchdog.py)")
    w.add_argument("--backlog-path", help="OPEN.md-shaped backlog file to read instead of "
                    "ledger/assignments/OPEN.md")
    w.set_defaults(fn=cmd_watchdog)
    bl = sub.add_parser("backlog")
    bl.add_argument("--path", help="OPEN.md-shaped file to read instead of ledger/assignments/OPEN.md")
    bl.set_defaults(fn=cmd_backlog)
    a = sub.add_parser("ask"); a.add_argument("thread"); a.add_argument("text", nargs="+")
    a.add_argument("--from", dest="sender", default="operator")
    a.add_argument("--timeout", type=float, default=30.0)
    a.set_defaults(fn=cmd_ask)
    d = sub.add_parser("decide"); d.add_argument("thread"); d.add_argument("id"); d.add_argument("decision", choices=["allow", "deny"]); d.set_defaults(fn=cmd_decide)
    h = sub.add_parser("hook-event"); h.add_argument("hook"); h.add_argument("thread"); h.add_argument("decision")
    h.add_argument("ms", type=int); h.add_argument("why", nargs="*"); h.set_defaults(fn=cmd_hook_event)
    pd = sub.add_parser("perm-decide"); pd.add_argument("thread"); pd.add_argument("cwd"); pd.add_argument("command"); pd.set_defaults(fn=cmd_perm_decide)
    pc = sub.add_parser("perm-check"); pc.add_argument("command")
    pc.add_argument("--thread", help="whose policy roots and permission mode to judge by")
    pc.add_argument("--cwd", help="where the command's relative paths resolve from")
    pc.set_defaults(fn=cmd_perm_check)
    wc = sub.add_parser("web-check"); wc.add_argument("url"); wc.set_defaults(fn=cmd_web_check)
    ph = sub.add_parser("path-check"); ph.add_argument("path")
    ph.add_argument("--thread", help="whose policy roots and permission mode to judge by")
    ph.add_argument("--cwd", help="where a relative path resolves from")
    ph.set_defaults(fn=cmd_path_check)
    b = sub.add_parser("bench"); bs = b.add_subparsers(dest="bench_cmd", required=True)
    br = bs.add_parser("run"); br.add_argument("task"); br.add_argument("--arms", default="fable,sonnet,fleet")
    br.add_argument("--repeat", type=int, default=1); br.set_defaults(fn=cmd_bench)
    bp = bs.add_parser("report"); bp.add_argument("--since"); bp.set_defaults(fn=cmd_bench)
    return p


def main(argv=None):
    args = _build_parser().parse_args(argv)
    activate_profile(args.profile or current_profile())
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
