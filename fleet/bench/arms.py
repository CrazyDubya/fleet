"""How each arm executes and how the bench knows it finished (spec: Runner)."""
import re
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from fleet import packet as packet_mod, send as send_mod, tmux
from fleet.ask import extract_reply
from fleet.paths import transcript_path

ARMS = {"fable": "claude-fable-5", "sonnet": "claude-sonnet-5"}
FLEET_TARGET = "sonnet2"
POLL_S = 1  # done-detection poll: t1 is only as precise as this interval
# How long an operator send with no handoff is still presumed "in flight". Measured
# from the SEND, not from thread idleness: idleness is reset by any turn at all,
# including the bench's own packet, so an idleness bound releases the guard exactly
# when the bench is about to collide and holds it the rest of the time. Generous
# enough to cover a long lab dispatch; `state == busy` covers the thread mid-turn.
DISPATCH_STALE_S = 5400


@dataclass
class ArmResult:
    status: str                      # done | timeout | error
    # ledger thread name -> its transcript. Keyed, not a bare list, so the runner can
    # scope interventions to the threads that actually spoke inside [t0, t1] instead of
    # to every thread the arm could in principle have used.
    transcripts_by_thread: dict[str, Path] = field(default_factory=dict)
    stdout_path: Path | None = None
    note: str = ""

    @property
    def transcripts(self) -> list[Path]:
        """The paths, for measure.tokens_by_model / measure.usd_by_model."""
        return list(self.transcripts_by_thread.values())

    @property
    def threads(self) -> list[str]:
        """Ledger thread names this arm-run owns."""
        return list(self.transcripts_by_thread)


def single_turn_argv(model: str, session_id: str, packet: str, root: Path) -> list[str]:
    return ["claude", "-p", "--model", model, "--session-id", session_id, "--permission-mode", "acceptEdits",
            "--add-dir", str(root), "--settings", str(root / "settings/v2/hot.json"), "--strict-mcp-config", packet]


def run_single_turn(model: str, packet: str, run: str, root: Path, timeout_s: int, workdir: Path,
                    spawn=subprocess.run) -> ArmResult:
    workdir.mkdir(parents=True, exist_ok=True)
    sid = str(uuid.uuid4())
    out = workdir / "stdout.txt"
    # hooks/v2/_lib.sh derives THREAD from the transcript's project dir, so a cwd of
    # <root>/bench/work/<run> reports as thread "bench-work-<run>".
    by_thread = {f"bench-work-{run}": transcript_path(workdir, sid)}
    try:
        r = spawn(single_turn_argv(model, sid, packet, root), cwd=str(workdir), capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return ArmResult("timeout", by_thread, out, "claude -p exceeded timeout_s")
    out.write_text(r.stdout or "")
    if r.returncode != 0:
        # No stdout at all means the CLI rejected its OWN invocation - bad settings,
        # bad flags - and exited before a single turn. The arm never attempted the
        # task, so this is missing data like a skipped fleet arm, not a failure by
        # the model. Reported as `error` it looked like 11 straight sonnet failures
        # when the real cause was an inert Write() rule in settings/v2/hot.json
        # (fixed in a55136d); the arm had been zeroed out for three days.
        started = bool((r.stdout or "").strip())
        return ArmResult("error" if started else "skipped", by_thread, out,
                         f"claude -p exit {r.returncode}: {(r.stderr or '')[-300:]}")
    return ArmResult("done", by_thread, out, "")


def _handoff_done(run: str, t0: float, handoff_dir: Path) -> bool:
    if not handoff_dir.is_dir():
        return False
    for p in handoff_dir.iterdir():
        if p.is_file() and p.stat().st_mtime >= t0 and f"@re{run}" in packet_mod.norm(p.read_text(errors="replace")):
            return True
    return False


def _artifact_done(target: Path | None, t0: float) -> bool:
    """True once the task's own declared output exists with content.

    A task states where its answer goes (`target`, e.g. bench/work/<run>/out) and
    the packet tells the thread to write it there. Nothing checked that file. So a
    thread that did exactly as asked - wrote the artifact, then replied in prose
    without an `@re` header - was invisible to the detector: on 2026-09-03 sonnet2
    answered lookup-newest-handoff in 4 SECONDS and the arm sat for another 176
    before recording a timeout. Six of the arm's nine historical timeouts have this
    shape (real output, no handoff).

    Existence is the signal, NOT correctness: `check` still decides pass/fail
    afterwards, so a thread that finishes with a WRONG answer is recorded as a
    fail rather than vanishing into a timeout. Empty files do not count - the
    directory and a zero-byte file often appear a beat before the content.
    """
    if target is None or not target.is_dir():
        return False
    return any(p.is_file() and p.stat().st_size > 0 and p.stat().st_mtime >= t0
               for p in target.rglob("*"))


def fleet_wait_done(run: str, t0: float, timeout_s: int, handoff_dir: Path, capture, sleep=time.sleep, clock=time.time,
                    target: Path | None = None) -> bool:
    deadline = t0 + timeout_s
    while True:
        if _handoff_done(run, t0, handoff_dir) or _artifact_done(target, t0):
            return True
        pane = capture()
        if pane and f"@re{run}" in packet_mod.norm(pane) and extract_reply(pane, run) is not None:
            return True
        if clock() >= deadline:
            return False
        sleep(POLL_S)


def _dispatch_in_flight(now=None, events=None, handoff=None) -> str:
    """Non-empty when an operator dispatch is still awaiting its `@done` handoff.

    `state == idle` is NOT enough. A thread pauses between the steps of a long
    dispatch - waiting on a permission dialog, or simply between turns - and in
    those gaps it reads as idle while the operator still owns it. That is how
    the 03:00 and 03:15 runs on 2026-09-03 sent into sonnet2 mid-LAB-18, burned
    $1.75 and $0.31 on 900 s timeouts, and pulled the thread onto bench work in
    the middle of a lab experiment.

    "Owned" means: the newest `send` to this thread is newer than its newest
    handoff. Idle means "not speaking", not "not busy".

    Bounded by the AGE OF THE SEND, because "newest send is newer than newest
    handoff" never clears on its own. Plenty of legitimate operator sends ask
    for an inline answer and write no handoff at all - two such probes on
    2026-09-03 at 09:11 and 09:13 latched this guard on and disabled the fleet
    arm for the rest of the day. A guard that can only ever say "busy" is not a
    guard, it is an outage.

    An earlier version of this bound used thread idleness, which is worse than
    no bound: any turn resets it, including the bench's own packet, so it
    released the guard precisely when a collision was imminent.

    Fails open like every other probe here - an unreadable ledger reports
    available rather than disabling the arm.
    """
    try:
        from fleet import ledger
        sends = [e for e in (events if events is not None else ledger.read_events(tail=4000))
                 if e.get("ev") == "send" and e.get("thread") == FLEET_TARGET
                 and e.get("from") != "bench"]
        if not sends:
            return ""
        last_send = sends[-1].get("t") or 0
        if (now if now is not None else time.time()) - last_send >= DISPATCH_STALE_S:
            return ""  # too old to still be running; it ended without a handoff
        h = handoff if handoff is not None else ledger.last_handoff(FLEET_TARGET)
        last_handoff_t = h.stat().st_mtime if h else 0
        if last_send > last_handoff_t:
            return "operator dispatch still in flight (no @done handoff yet)"
    except Exception:
        return ""
    return ""


def _target_unavailable(registry_entries: dict, capture=None) -> str:
    """Why FLEET_TARGET must not be sent a packet right now, or "" if it may.

    Transcript state alone is not enough. A thread WEDGED with unsubmitted text
    has no open turn, so `status` reports it idle - that is how the 2026-09-02
    03:19 bench run sent into a thread stuck for 13.8 h, burned $0.31 and
    recorded a 900 s timeout as if the fleet had failed the task. Both
    conditions mean the same thing to the bench (the thread cannot answer), so
    both are checked here.

    Best-effort in one direction only: on any error, report AVAILABLE, so a
    broken probe degrades to the old behaviour rather than silently disabling
    the fleet arm forever. A capture that SUCCEEDS and shows no input box is
    not an error - it is a blocked thread, and it is reported as such.
    """
    try:
        from fleet import status as status_mod
        for r in status_mod.rows(entries=registry_entries):
            if getattr(r, "name", None) == FLEET_TARGET:
                if getattr(r, "state", "") == "busy":
                    return "busy with operator work"
                break
    except Exception:
        return ""
    inflight = _dispatch_in_flight()
    if inflight:
        return inflight
    try:
        # escapes=True is load-bearing: the box renders a real draft and Claude
        # Code's dim SUGGESTED next prompt identically without SGR codes.
        pane = (capture or (lambda: tmux.capture(FLEET_TARGET, lines=40, escapes=True)))()
    except Exception:
        return ""
    if not pane.strip():
        return ""
    draft = tmux.parse_input_box(pane)
    if draft is None:
        return "no input box on screen (permission dialog or non-TUI state)"
    if draft:
        return f"wedged: unsubmitted text in the prompt ({draft[:60]!r})"
    return ""


def run_fleet(packet_text: str, refs: list[str], done: str, run: str, root: Path, timeout_s: int, lane: str,
              profile: str, registry_entries: dict, send=send_mod.send_packet, capture=None, sleep=time.sleep, clock=time.time,
              unavailable=None, target: Path | None = None) -> ArmResult:
    from fleet.registry import transcript_for
    by_thread = {name: transcript_for(e, registry_entries) for name, e in registry_entries.items()}
    p = packet_mod.Packet(to=FLEET_TARGET, sender="bench", lane=lane, effort=packet_mod.LANES[lane].effort, reply="file",
                          refs=refs, done=done, id=run, body=packet_text)
    # The fleet arm drives the LIVE thread, so a bench run that fires while the
    # operator has real work in flight commandeers it mid-task. Observed twice
    # (2026-09-01 and 09-02 3AM runs), both times interrupting a pinball-lab
    # experiment; a third time (09-02 03:19) the thread was wedged rather than
    # busy and the arm sent anyway. Skip rather than collide: a skipped arm is
    # honest missing data, a collided one corrupts both the bench measurement
    # and the live work.
    # injectable like every other collaborator here: it reads live tmux and the live
    # ledger, so a test that cannot stub it passes or fails on whatever the fleet
    # happens to be doing at that second.
    why = (unavailable or _target_unavailable)(registry_entries)
    if why:
        return ArmResult("skipped", by_thread, None,
                         f"{FLEET_TARGET} {why}; arm skipped to avoid collision")
    t0 = clock()
    try:
        send(p, profile)
    except send_mod.SendError as exc:
        return ArmResult("error", by_thread, None, str(exc))
    cap = capture or (lambda: tmux.capture(FLEET_TARGET, lines=200, join=True))
    ok = fleet_wait_done(run, t0, timeout_s, root / "ledger" / "handoffs" / FLEET_TARGET, cap, sleep, clock, target)
    return ArmResult("done" if ok else "timeout", by_thread, None, "" if ok else "no @re reply within timeout_s")
