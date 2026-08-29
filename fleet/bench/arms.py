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
_WS = re.compile(r"\s+")


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
        return ArmResult("error", by_thread, out, f"claude -p exit {r.returncode}: {(r.stderr or '')[-300:]}")
    return ArmResult("done", by_thread, out, "")


def _handoff_done(run: str, t0: float, handoff_dir: Path) -> bool:
    if not handoff_dir.is_dir():
        return False
    for p in handoff_dir.iterdir():
        if p.is_file() and p.stat().st_mtime >= t0 and f"@re{run}" in _WS.sub("", p.read_text(errors="replace")):
            return True
    return False


def fleet_wait_done(run: str, t0: float, timeout_s: int, handoff_dir: Path, capture, sleep=time.sleep, clock=time.time) -> bool:
    deadline = t0 + timeout_s
    while True:
        if _handoff_done(run, t0, handoff_dir):
            return True
        pane = capture()
        if pane and f"@re{run}" in _WS.sub("", pane) and extract_reply(pane, run) is not None:
            return True
        if clock() >= deadline:
            return False
        sleep(POLL_S)


def run_fleet(packet_text: str, refs: list[str], done: str, run: str, root: Path, timeout_s: int, lane: str,
              profile: str, registry_entries: dict, send=send_mod.send_packet, capture=None, sleep=time.sleep, clock=time.time) -> ArmResult:
    from fleet.registry import transcript_for
    by_thread = {name: transcript_for(e, registry_entries) for name, e in registry_entries.items()}
    p = packet_mod.Packet(to=FLEET_TARGET, sender="bench", lane=lane, effort=packet_mod.LANES[lane].effort, reply="file",
                          refs=refs, done=done, id=run, body=packet_text)
    t0 = clock()
    try:
        send(p, profile)
    except send_mod.SendError as exc:
        return ArmResult("error", by_thread, None, str(exc))
    cap = capture or (lambda: tmux.capture(FLEET_TARGET, lines=200, join=True))
    ok = fleet_wait_done(run, t0, timeout_s, root / "ledger" / "handoffs" / FLEET_TARGET, cap, sleep, clock)
    return ArmResult("done" if ok else "timeout", by_thread, None, "" if ok else "no @re reply within timeout_s")
