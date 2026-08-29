"""The runner: one arm-run → one row (spec: Runner, Row schema)."""
import json
import os
import re
import socket
import subprocess
import time
from pathlib import Path

from fleet import ledger, packet as packet_mod
from fleet.bench import arms, measure, tasks as tasks_mod
from fleet.paths import LEDGER, ROOT

RUNS = LEDGER / "bench" / "runs.jsonl"
JUDGE_MODEL = "claude-opus-5"


def _commit(root: Path) -> str:
    r = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else "?"


def _parse_score(text: str) -> int | None:
    for line in reversed(text.strip().splitlines()):
        m = re.fullmatch(r"\s*([0-5])\s*", line)
        if m:
            return int(m.group(1))
    return None


def judge(rubric_path: str, done: str, artifacts: list[str], run: str, root: Path, spawn=subprocess.run) -> tuple[int | None, str | None]:
    rubric = (root / rubric_path).read_text()
    out_dir = root / "ledger" / "handoffs" / "judge"; out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{run}.md"
    prompt = (f"You are the judge lane. Score the artifacts against the rubric and the acceptance test.\n\nRUBRIC:\n{rubric}\n\n"
              f"ACCEPTANCE TEST (@done): {done}\n\nARTIFACTS (read-only): {' '.join(artifacts)}\n\n"
              f"Write your reasoning to {out_path} (create it), then output ONLY the integer score 0-5 as the last line.")
    r = spawn(["claude", "-p", "--model", JUDGE_MODEL, "--permission-mode", "acceptEdits", "--add-dir", str(root), "--strict-mcp-config", prompt],
              cwd=str(root), capture_output=True, text=True, timeout=600)
    score = _parse_score(r.stdout or "")
    return score, (str(out_path.relative_to(root)) if out_path.exists() else None)


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
            judge_fn=None, events=None, clock=time.time) -> dict:
    run = packet_mod.new_id()
    assert re.fullmatch(r"[0-9a-f]{16}", run)  # the only runtime value interpolated into shell=True strings below
    resolved = tasks_mod.substitute(task, run, root)
    execute = execute or _default_execute(root)
    judge_fn = judge_fn or (lambda rubric, done, artifacts, r, rt: judge(rubric, done, artifacts, r, rt))
    row = {"run": run, "task": task.id, "arm": arm, "t0": None, "t1": None, "wall_s": None, "status": "error", "check_rc": None,
           "judge": None, "judge_path": None, "interventions": {}, "tokens": {}, "usd": 0.0, "pool": measure.pool_split({}),
           "commit": _commit(root), "error": None}
    t0 = clock(); row["t0"] = t0
    try:
        res = execute(resolved, run, arm)
        t1 = clock(); row["t1"] = t1; row["wall_s"] = t1 - t0
        row["status"] = res.status
        if res.status == "timeout" and arm == "fleet":
            subprocess.run([str(root / "bin" / "fleet"), "miss", "sonnet2", f"bench-timeout-{run}"], capture_output=True)
        if res.status == "done":
            # shell=True here is by design: check/cleanup come from operator-authored task files, not untrusted input.
            c = check_run(resolved.check, shell=True, cwd=str(root), capture_output=True, text=True, timeout=120)
            row["check_rc"] = c.returncode
            row["status"] = "pass" if c.returncode == 0 else "fail"
            if row["status"] == "pass" and task.judge:
                artifacts = [resolved.target] + ([str(res.stdout_path)] if res.stdout_path else [])
                row["judge"], row["judge_path"] = judge_fn(task.judge, resolved.done, artifacts, run, root)
        elif res.note:
            row["error"] = res.note
        ev = ledger.read_events() if events is None else events
        row["interventions"] = measure.interventions(ev, t0, t1)
        row["tokens"] = measure.tokens_by_model(res.transcripts, t0, t1)
        usd = measure.usd_by_model(res.transcripts, t0, t1)
        row["usd"] = round(sum(usd.values()), 6); row["pool"] = pool_rounded(measure.pool_split(usd))
    except Exception as exc:  # the bench must survive one bad arm-run
        row["t1"] = row["t1"] or clock(); row["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if resolved.cleanup:
            # shell=True here is by design: cleanup comes from operator-authored task files, not untrusted input.
            subprocess.run(resolved.cleanup, shell=True, cwd=str(root), capture_output=True)
    runs_path.parent.mkdir(parents=True, exist_ok=True)
    with open(runs_path, "a") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")
    return row


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
