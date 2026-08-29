"""The runner: one arm-run → one row (spec: Runner, Row schema)."""
import json
import re
import socket
import subprocess
import time
import uuid
from functools import lru_cache
from pathlib import Path

from fleet import ledger, packet as packet_mod
from fleet.bench import arms, measure, tasks as tasks_mod
from fleet.paths import LEDGER, ROOT, transcript_path

RUNS = LEDGER / "bench" / "runs.jsonl"
JUDGE_MODEL = "claude-opus-5"
RUN_RE = re.compile(r"[0-9a-f]{16}")


def _commit(root: Path) -> str:
    r = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else "?"


@lru_cache(maxsize=1)
def claude_version() -> str:
    """Which `claude` produced these rows - a version bump moves every number."""
    try:
        r = subprocess.run(["claude", "--version"], capture_output=True, text=True)
    except (OSError, subprocess.SubprocessError):
        return "?"
    return r.stdout.strip() or "?"


def _add_error(row: dict, msg: str) -> None:
    row["error"] = f"{row['error']}; {msg}" if row["error"] else msg


def _parse_score(text: str) -> int | None:
    for line in reversed(text.strip().splitlines()):
        m = re.fullmatch(r"\s*([0-5])\s*", line)
        if m:
            return int(m.group(1))
    return None


def judge(rubric_path: str, done: str, artifacts: list[str], run: str, root: Path, spawn=subprocess.run,
          clock=time.time) -> tuple[int | None, str | None, float, str | None]:
    """Score one passing run: (score, handoff path, judge $, judge model).

    The judge is hooked like every arm (`--settings settings/v2/hot.json`) and gets its
    own session id, so its spend is measurable - and it is reported beside the arm's `$`,
    never folded into it: judging is the bench's cost, not the arm's.
    """
    rubric = (root / rubric_path).read_text()
    out_dir = root / "ledger" / "handoffs" / "judge"; out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{run}.md"
    sid = str(uuid.uuid4())
    prompt = (f"You are the judge lane. Score the artifacts against the rubric and the acceptance test.\n\nRUBRIC:\n{rubric}\n\n"
              f"ACCEPTANCE TEST (@done): {done}\n\nARTIFACTS (read-only): {' '.join(artifacts)}\n\n"
              f"Write your reasoning to {out_path} (create it), then output ONLY the integer score 0-5 as the last line.")
    t0 = clock()
    r = spawn(["claude", "-p", "--model", JUDGE_MODEL, "--session-id", sid, "--permission-mode", "acceptEdits",
               "--add-dir", str(root), "--settings", str(root / "settings" / "v2" / "hot.json"), "--strict-mcp-config", prompt],
              cwd=str(root), capture_output=True, text=True, timeout=600)
    t1 = clock()
    usd = measure.usd_by_model([transcript_path(root, sid)], t0, t1)
    score = _parse_score(r.stdout or "")
    return score, (str(out_path.relative_to(root)) if out_path.exists() else None), round(sum(usd.values()), 6), JUDGE_MODEL


def ensure_gui(root: Path, port: int = 8787):
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)) == 0:
            return lambda: None
    proc = subprocess.Popen(["python3", "-m", "gui", "--port", str(port)], cwd=str(root), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    return proc.terminate


def _default_execute(root: Path):
    from fleet.cli import current_profile
    from fleet.registry import Registry
    def execute(resolved: tasks_mod.TaskSpec, run: str, arm: str) -> arms.ArmResult:
        if arm == "fleet":
            return arms.run_fleet(resolved.packet, resolved.refs, resolved.done, run, root, resolved.timeout_s, resolved.lane,
                                  current_profile(), Registry().load())
        return arms.run_single_turn(arms.ARMS[arm], resolved.packet, run, root, resolved.timeout_s, root / "bench" / "work" / run)
    return execute


def run_one(task: tasks_mod.TaskSpec, arm: str, root: Path, runs_path: Path = RUNS, *, execute=None, check_run=subprocess.run,
            judge_fn=None, events=None, clock=time.time, shell_run=subprocess.run) -> dict:
    from fleet.cli import current_profile
    run = packet_mod.new_id()
    if not RUN_RE.fullmatch(run):  # the only runtime value interpolated into shell=True strings below
        raise ValueError(f"bench run id must be 16 hex chars, got {run!r}")
    resolved = tasks_mod.substitute(task, run, root)
    execute = execute or _default_execute(root)
    judge_fn = judge_fn or (lambda rubric, done, artifacts, r, rt: judge(rubric, done, artifacts, r, rt))
    row = {"run": run, "task": task.id, "arm": arm, "t0": None, "t1": None, "wall_s": None, "status": "error", "check_rc": None,
           "judge": None, "judge_path": None, "judge_usd": 0.0, "judge_model": None, "interventions": {}, "tokens": {},
           "usd": 0.0, "pool": measure.pool_split({}), "measured": False, "commit": _commit(root),
           "profile": current_profile(), "claude_version": claude_version(), "error": None}
    t0 = clock(); row["t0"] = t0

    def body() -> None:
        nonlocal resolved
        missing = [r for r in task.refs if not (root / r).exists()]
        if missing:  # a task that cites a moved handoff measures nothing but the arm's confusion
            _add_error(row, "missing ref: " + ", ".join(missing))
            return
        if resolved.expect is not None:
            # shell=True here is by design: expect/check/cleanup come from operator-authored
            # task files, not untrusted input. It runs at t0 so the expected answer is the one
            # the arm could actually have found - not one the run itself changed.
            e = shell_run(resolved.expect, shell=True, cwd=str(root), capture_output=True, text=True, timeout=120)
            if e.returncode != 0:
                resolved = tasks_mod.with_expect(resolved, "")
                _add_error(row, f"expect: exit {e.returncode}: {(e.stderr or '').strip()[-200:]}")
                return
            resolved = tasks_mod.with_expect(resolved, (e.stdout or "").strip())
        res = execute(resolved, run, arm)
        t1 = clock(); row["t1"] = t1; row["wall_s"] = t1 - t0
        row["status"] = res.status
        if res.status == "timeout" and arm == "fleet":
            _fleet_miss(root, run, row)
        if res.status == "done":
            _check_and_judge(row, resolved, task, res, run, root, check_run, judge_fn)
        elif res.note:
            _add_error(row, res.note)
        ev = ledger.read_events() if events is None else events
        row["interventions"] = measure.interventions(ev, t0, t1, set(res.threads) if res.threads else None)
        row["tokens"] = measure.tokens_by_model(res.transcripts, t0, t1)
        usd = measure.usd_by_model(res.transcripts, t0, t1)
        row["usd"] = round(sum(usd.values()), 6); row["pool"] = pool_rounded(measure.pool_split(usd))
        row["measured"] = True  # only now is status backed by a real cost/token window

    try:
        body()
    except Exception as exc:  # the bench must survive one bad arm-run
        row["t1"] = row["t1"] or clock()
        _add_error(row, f"{type(exc).__name__}: {exc}")
        row["status"] = "error"  # never leave a pass/fail standing on an empty measurement
    finally:
        if resolved.cleanup:
            # shell=True here is by design: cleanup comes from operator-authored task files.
            subprocess.run(resolved.cleanup, shell=True, cwd=str(root), capture_output=True)
    runs_path.parent.mkdir(parents=True, exist_ok=True)
    with open(runs_path, "a") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")
    return row


def _fleet_miss(root: Path, run: str, row: dict) -> None:
    """Drop the reply sonnet2 is still pending on. `abandoned-<id>` is the only reason
    cmd_miss matches to clear pending state; anything else leaves the Stop hook blocking."""
    try:
        m = subprocess.run([str(root / "bin" / "fleet"), "miss", arms.FLEET_TARGET, f"abandoned-{run}"],
                           capture_output=True, timeout=60)
        if m.returncode != 0:
            _add_error(row, f"fleet miss: exit {m.returncode}")
    except (OSError, subprocess.SubprocessError) as exc:  # recorded, but the run's status stands
        _add_error(row, f"fleet miss: {type(exc).__name__}: {exc}")


def _check_and_judge(row: dict, resolved, task, res, run: str, root: Path, check_run, judge_fn) -> None:
    try:
        c = check_run(resolved.check, shell=True, cwd=str(root), capture_output=True, text=True, timeout=120)
        row["check_rc"] = c.returncode
        row["status"] = "pass" if c.returncode == 0 else "fail"
    except subprocess.TimeoutExpired:
        row["status"] = "fail"; row["check_rc"] = None
        _add_error(row, "check timed out")
        return
    if row["status"] == "pass" and task.judge:
        artifacts = [resolved.target] + ([str(res.stdout_path)] if res.stdout_path else [])
        try:
            row["judge"], row["judge_path"], row["judge_usd"], row["judge_model"] = judge_fn(task.judge, resolved.done, artifacts, run, root)
        except Exception as exc:  # a judge failure degrades the score, it does not discard the run
            row["judge"], row["judge_path"] = None, None
            _add_error(row, f"judge: {type(exc).__name__}: {exc}")


def pool_rounded(p: dict) -> dict:
    return {"fable": round(p["fable"], 6), "weekly": {k: round(v, 6) for k, v in p["weekly"].items()}}


def run_many(task_ids: list[str] | None, arm_names: list[str], root: Path = ROOT, repeat: int = 1, runs_path: Path = RUNS) -> list[dict]:
    all_tasks = tasks_mod.load_all(root / "bench" / "tasks")
    chosen = [t for t in all_tasks if not task_ids or t.id in task_ids]
    stop = ensure_gui(root)
    rows = []
    try:
        for _ in range(repeat):
            for t in chosen:
                for arm in arm_names:  # sequential by construction
                    rows.append(run_one(t, arm, root, runs_path))
                    print(f"{t.id:16} {arm:7} {rows[-1]['status']:8} {rows[-1]['wall_s'] or 0:7.1f}s ${rows[-1]['usd']:.3f}", flush=True)
    finally:
        stop()
    return rows
