# Fleet Bench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `fleet bench run|report` measures accuracy (executable check + judge), cost (API-rate `$` plus the same `$` split by subscription pool), and wall-clock for three arms — single-turn fable, single-turn sonnet, and fleet v2 — on a task set, appending verifiable rows to `ledger/bench/runs.jsonl`.

**Architecture:** A `fleet/bench/` package with one module per responsibility: `tasks` (TOML task files + substitution), `measure` (transcript windows → tokens/`$`/pool/interventions), `arms` (how each arm executes and how "done" is detected), `run` (the sequential runner and row writer), `report` (aggregation). CLI verbs in `fleet/cli.py`; a `bench` dashboard widget; a launchd plist. Everything reuses the production parsers (`fleet.transcript`, `fleet.cost`, `fleet.ledger`, `fleet.send`, `fleet.ask.extract_reply`).

**Tech Stack:** Python 3.11+ stdlib (tomllib, subprocess, dataclasses, unittest), `claude -p` for headless arms, vanilla ES-module widget on the existing `gui/` host.

**Spec:** `docs/superpowers/specs/2026-08-29-fleet-bench-design.md`

## Global Constraints

- No new Python dependencies; tests run with `python3 -m pytest -q tests --deselect tests/test_v2_live.py` (baseline 191 passed, 3 skipped — must not regress). Live tests skip unless tmux session `fleet2` exists.
- Arms exactly: `fable` → `claude-fable-5`, `sonnet` → `claude-sonnet-5` (single-turn, headless), `fleet` → v2 profile (`sonnet2` target). Arms run sequentially, never concurrently.
- Accuracy = `check` exit 0; judge (opus, 0–5) only when check passes and the task has a rubric.
- `usd` = `fleet.cost.spend` at the API rate table; `pool` = the same `$` split as `{"fable": x, "weekly": {"opus": a, "sonnet": b, "haiku": c}}` (shares, never balances).
- Tokens per model come from `fleet.transcript.parse`, windowed to `t0 <= turn.ts < t1`.
- Row schema exactly as in the spec ("Row schema"); rows append to `ledger/bench/runs.jsonl` (gitignored via `ledger/`).
- Task files: `bench/tasks/<id>.toml`; rubrics: `bench/rubrics/<name>.md`; work dirs `bench/work/<run>/` (gitignored).
- Substitution placeholders exactly: `{run}`, `{target}`, `{refs}`, `{root}`.
- Interventions in a window: `keypress` (ledger `ev:keypress`), `decide` (ledger `ev:decide`), `escalate` and `block` (ledger `ev:hook` with that `decision`).
- Commit trailer line: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never spawn/kill/park any fleet thread from bench code; the fleet arm only sends packets.
- `check` and `cleanup` run with `shell=True` **by design**: task files are operator-authored config under `bench/tasks/` (trusted like `fleet.toml`); the only runtime-substituted values are `{run}` (must match `^[0-9a-f]{16}$` — `run_one` asserts this) and `{target}`/`{refs}`/`{root}` (from the task file / repo path). Never substitute model output into a shell string.

---

### Task 1: Task files — load and substitute

**Files:**
- Create: `fleet/bench/__init__.py` (empty), `fleet/bench/tasks.py`
- Test: `tests/test_bench_tasks.py`

**Interfaces:**
- Produces: `TaskSpec` dataclass (`id, lane, packet, refs: list[str], target, done, check, judge: str | None, timeout_s: int, cleanup: str | None`), `load_task(path: Path) -> TaskSpec`, `load_all(dir: Path) -> list[TaskSpec]` (sorted by id), `substitute(task: TaskSpec, run: str, root: Path) -> Resolved` where `Resolved` has the same string fields with `{run}`, `{target}`, `{refs}`, `{root}` replaced (`{target}` replaced *after* `{run}` so `target = "gui/widgets/bench-{run}"` works; `{refs}` is the space-joined list).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_bench_tasks.py
import tempfile
import unittest
from pathlib import Path

from fleet.bench import tasks

TOML = '''
id = "lookup-newest"
lane = "lookup"
packet = "Newest file under {root}/ledger/handoffs and its first line. Refs: {refs}"
refs = ["maps/projects.md"]
target = "bench/work/{run}/out"
done = "the reply names the newest handoff"
check = "grep -q handoffs {target}/reply.txt"
timeout_s = 120
'''


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.dir = Path(self.tmp.name)
        (self.dir / "lookup-newest.toml").write_text(TOML)

    def tearDown(self):
        self.tmp.cleanup()

    def test_load_and_defaults(self):
        t = tasks.load_task(self.dir / "lookup-newest.toml")
        self.assertEqual((t.id, t.lane, t.timeout_s), ("lookup-newest", "lookup", 120))
        self.assertIsNone(t.judge); self.assertIsNone(t.cleanup)
        self.assertEqual(t.refs, ["maps/projects.md"])

    def test_substitute(self):
        t = tasks.load_task(self.dir / "lookup-newest.toml")
        r = tasks.substitute(t, "abc123", Path("/r"))
        self.assertEqual(r.target, "bench/work/abc123/out")
        self.assertEqual(r.check, "grep -q handoffs bench/work/abc123/out/reply.txt")
        self.assertIn("/r/ledger/handoffs", r.packet); self.assertIn("maps/projects.md", r.packet)

    def test_load_all_sorted_and_rejects_bad_lane(self):
        (self.dir / "a-build.toml").write_text(TOML.replace('id = "lookup-newest"', 'id = "a-build"').replace('lane = "lookup"', 'lane = "build"'))
        self.assertEqual([t.id for t in tasks.load_all(self.dir)], ["a-build", "lookup-newest"])
        (self.dir / "bad.toml").write_text(TOML.replace('lane = "lookup"', 'lane = "magic"'))
        with self.assertRaises(ValueError):
            tasks.load_all(self.dir)
```

- [ ] **Step 2: Run to verify failure** — `python3 -m pytest -q tests/test_bench_tasks.py` → `ModuleNotFoundError: fleet.bench`

- [ ] **Step 3: Implement**

```python
# fleet/bench/tasks.py
"""Bench task files (spec: Task definition)."""
import tomllib
from dataclasses import dataclass, replace
from pathlib import Path

LANES = ("lookup", "build", "plan", "judge")


@dataclass
class TaskSpec:
    id: str
    lane: str
    packet: str
    refs: list[str]
    target: str
    done: str
    check: str
    judge: str | None = None
    timeout_s: int = 900
    cleanup: str | None = None


Resolved = TaskSpec  # same shape, placeholders replaced


def load_task(path: Path) -> TaskSpec:
    d = tomllib.loads(path.read_text())
    t = TaskSpec(id=d["id"], lane=d["lane"], packet=d["packet"], refs=list(d.get("refs", [])),
                 target=d["target"], done=d["done"], check=d["check"], judge=d.get("judge"),
                 timeout_s=int(d.get("timeout_s", 900)), cleanup=d.get("cleanup"))
    if t.lane not in LANES:
        raise ValueError(f"{path.name}: lane must be one of {LANES}, not {t.lane!r}")
    return t


def load_all(dir: Path) -> list[TaskSpec]:
    return sorted((load_task(p) for p in dir.glob("*.toml")), key=lambda t: t.id)


def _sub(s: str | None, run: str, root: Path, target: str, refs: str) -> str | None:
    if s is None:
        return None
    return s.replace("{run}", run).replace("{target}", target).replace("{refs}", refs).replace("{root}", str(root))


def substitute(task: TaskSpec, run: str, root: Path) -> Resolved:
    target = task.target.replace("{run}", run).replace("{root}", str(root))
    refs = " ".join(task.refs)
    return replace(task, packet=_sub(task.packet, run, root, target, refs), target=target,
                   done=_sub(task.done, run, root, target, refs), check=_sub(task.check, run, root, target, refs),
                   cleanup=_sub(task.cleanup, run, root, target, refs))
```

- [ ] **Step 4: Run** — `python3 -m pytest -q tests/test_bench_tasks.py` → 3 passed
- [ ] **Step 5: Commit** — `git add fleet/bench tests/test_bench_tasks.py && git commit -m "feat(bench): task files - load and substitute"`

---

### Task 2: Measurement — windows, tokens, `$`, pool, interventions

**Files:**
- Create: `fleet/bench/measure.py`
- Test: `tests/test_bench_measure.py`

**Interfaces:**
- Consumes: `fleet.transcript.Turn` (`ts, model, input, cache_read, cache_5m, cache_1h, output`), `fleet.transcript.parse(path).turns`, `fleet.cost.spend(turns, model) -> Spend(.dollars)`, `fleet.cost._rate` (raises `ValueError` for unknown models — treat as unpriced, `usd` contribution 0 and model listed in `tokens` anyway).
- Produces: `window(turns, t0, t1) -> list[Turn]`; `tokens_by_model(paths: list[Path], t0, t1) -> dict[str, dict]` with keys `input, cache_read, cache_write, output`; `usd_by_model(paths, t0, t1) -> dict[str, float]`; `pool_split(usd_by_model) -> dict` (`{"fable": x, "weekly": {"opus": a, "sonnet": b, "haiku": c}}`, keyed by substring of the model id: `fable`→fable pool; `opus`/`sonnet`/`haiku`→weekly); `interventions(events: list[dict], t0, t1) -> dict[str, int]` with keys `keypress, decide, escalate, block`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_bench_measure.py
import unittest
from unittest import mock

from fleet.bench import measure
from fleet.transcript import Turn


def turn(ts, model, **kw):
    base = dict(ts=ts, model=model, msg_id=f"m{ts}", input=0, cache_read=0, cache_5m=0, cache_1h=0, output=0, thinking=0, stop_reason=None)
    base.update(kw); return Turn(**base)


class MeasureTests(unittest.TestCase):
    def test_window_is_half_open(self):
        ts = [turn(1, "m"), turn(5, "m"), turn(9, "m")]
        self.assertEqual([t.ts for t in measure.window(ts, 5, 9)], [5])

    def test_tokens_and_usd_by_model(self):
        s = [turn(10, "claude-sonnet-5", input=100, cache_read=1000, cache_1h=50, output=20)]
        h = [turn(11, "claude-haiku-4-5", cache_read=500, output=5), turn(99, "claude-haiku-4-5", output=999)]
        with mock.patch("fleet.bench.measure._turns_of", side_effect=[s, h]):
            tok = measure.tokens_by_model(["a", "b"], 0, 50)
        self.assertEqual(tok["claude-sonnet-5"], {"input": 100, "cache_read": 1000, "cache_write": 50, "output": 20})
        self.assertEqual(tok["claude-haiku-4-5"]["output"], 5)  # the ts=99 turn is outside the window
        with mock.patch("fleet.bench.measure._turns_of", side_effect=[s, h]):
            usd = measure.usd_by_model(["a", "b"], 0, 50)
        self.assertAlmostEqual(usd["claude-sonnet-5"], (1000*2.0*0.1 + 50*2.0*2.0 + 100*2.0 + 20*10.0) / 1e6)

    def test_unknown_model_is_listed_but_unpriced(self):
        with mock.patch("fleet.bench.measure._turns_of", return_value=[turn(1, "mystery-9", output=3)]):
            self.assertEqual(measure.tokens_by_model(["a"], 0, 5)["mystery-9"]["output"], 3)
            self.assertEqual(measure.usd_by_model(["a"], 0, 5)["mystery-9"], 0.0)

    def test_pool_split(self):
        p = measure.pool_split({"claude-fable-5": 1.5, "claude-opus-5": 0.5, "claude-sonnet-5": 0.3, "claude-haiku-4-5": 0.02})
        self.assertEqual(p, {"fable": 1.5, "weekly": {"opus": 0.5, "sonnet": 0.3, "haiku": 0.02}})
        self.assertEqual(measure.pool_split({})["weekly"], {"opus": 0.0, "sonnet": 0.0, "haiku": 0.0})

    def test_interventions_in_window(self):
        ev = [{"ev": "hook", "hook": "perm", "decision": "escalate", "t": 5}, {"ev": "hook", "hook": "gate", "decision": "block", "t": 6},
              {"ev": "hook", "hook": "gate", "decision": "allow", "t": 6}, {"ev": "decide", "t": 7}, {"ev": "keypress", "t": 8}, {"ev": "keypress", "t": 50}]
        self.assertEqual(measure.interventions(ev, 0, 10), {"keypress": 1, "decide": 1, "escalate": 1, "block": 1})
```

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError: fleet.bench.measure`

- [ ] **Step 3: Implement**

```python
# fleet/bench/measure.py
"""Per-run measurement from transcripts and the ledger (spec: Row schema)."""
from pathlib import Path

from fleet import cost, transcript
from fleet.transcript import Turn


def _turns_of(path) -> list[Turn]:
    p = Path(path)
    return transcript.parse(p).turns if p.exists() else []


def window(turns: list[Turn], t0: float, t1: float) -> list[Turn]:
    return [t for t in turns if t0 <= t.ts < t1]


def _by_model(paths, t0, t1) -> dict[str, list[Turn]]:
    out: dict[str, list[Turn]] = {}
    for p in paths:
        for t in window(_turns_of(p), t0, t1):
            out.setdefault(t.model, []).append(t)
    return out


def tokens_by_model(paths, t0: float, t1: float) -> dict[str, dict]:
    return {m: {"input": sum(t.input for t in ts), "cache_read": sum(t.cache_read for t in ts),
                "cache_write": sum(t.cache_5m + t.cache_1h for t in ts), "output": sum(t.output for t in ts)}
            for m, ts in _by_model(paths, t0, t1).items()}


def usd_by_model(paths, t0: float, t1: float) -> dict[str, float]:
    out = {}
    for m, ts in _by_model(paths, t0, t1).items():
        try:
            out[m] = cost.spend(ts, m).dollars
        except ValueError:  # unknown model: listed, unpriced
            out[m] = 0.0
    return out


def pool_split(usd: dict[str, float]) -> dict:
    pools = {"fable": 0.0, "weekly": {"opus": 0.0, "sonnet": 0.0, "haiku": 0.0}}
    for m, d in usd.items():
        if "fable" in m:
            pools["fable"] += d
        else:
            for k in ("opus", "sonnet", "haiku"):
                if k in m:
                    pools["weekly"][k] += d
    return pools


def interventions(events: list[dict], t0: float, t1: float) -> dict[str, int]:
    n = {"keypress": 0, "decide": 0, "escalate": 0, "block": 0}
    for e in events:
        if not (t0 <= e.get("t", -1) < t1):
            continue
        if e.get("ev") in ("keypress", "decide"):
            n[e["ev"]] += 1
        elif e.get("ev") == "hook" and e.get("decision") in ("escalate", "block"):
            n[e["decision"]] += 1
    return n
```

- [ ] **Step 4: Run** — 5 passed
- [ ] **Step 5: Commit** — `git commit -m "feat(bench): measurement - windows, tokens, usd, pool split, interventions"`

---

### Task 3: Arms — single-turn `claude -p` and the fleet packet, with done-detection

**Files:**
- Create: `fleet/bench/arms.py`
- Test: `tests/test_bench_arms.py`

**Interfaces:**
- Consumes: `fleet.send.send_packet(p, profile) -> id`, `fleet.packet.Packet`, `fleet.ask.extract_reply(pane, pid)` (whitespace-insensitive `@re <pid>` detection), `fleet.tmux.capture(name, lines, join=True)`, `fleet.paths.transcript_path(cwd, session_id)`, `fleet.registry.Registry().load()` + `transcript_for`, `fleet.cli.current_profile()`.
- Produces: `ArmResult(status: str, transcripts: list[Path], stdout_path: Path | None, note: str)` with status ∈ `done|timeout|error`; `single_turn_argv(model, session_id, packet, root) -> list[str]`; `run_single_turn(model, packet, run, root, timeout_s, workdir, spawn=subprocess.run) -> ArmResult`; `fleet_wait_done(run, t0, timeout_s, handoff_dir, capture, sleep, clock) -> bool`; `run_fleet(packet_text, refs, done, run, root, timeout_s, lane, send=send_packet, ...) -> ArmResult`; `ARMS = {"fable": "claude-fable-5", "sonnet": "claude-sonnet-5"}`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_bench_arms.py
import subprocess
import tempfile
import unittest
from pathlib import Path

from fleet.bench import arms


class SingleTurnTests(unittest.TestCase):
    def test_argv_shape(self):
        a = arms.single_turn_argv("claude-sonnet-5", "sid-1", "do it", Path("/r"))
        self.assertEqual(a[:2], ["claude", "-p"])
        for flag, val in (("--model", "claude-sonnet-5"), ("--session-id", "sid-1"), ("--permission-mode", "acceptEdits"),
                          ("--add-dir", "/r"), ("--settings", "/r/settings/v2/hot.json")):
            self.assertEqual(a[a.index(flag) + 1], val)
        self.assertIn("--strict-mcp-config", a); self.assertEqual(a[-1], "do it")

    def test_run_single_turn_records_transcript_and_stdout(self):
        with tempfile.TemporaryDirectory() as d:
            wd = Path(d) / "w"
            calls = []
            def spawn(argv, **kw):
                calls.append((argv, kw)); return subprocess.CompletedProcess(argv, 0, stdout="hello\n", stderr="")
            r = arms.run_single_turn("claude-sonnet-5", "pkt", "run1", Path("/r"), 30, wd, spawn=spawn)
            self.assertEqual(r.status, "done")
            self.assertEqual((wd / "stdout.txt").read_text(), "hello\n")
            self.assertEqual(calls[0][1]["cwd"], str(wd)); self.assertEqual(calls[0][1]["timeout"], 30)
            self.assertTrue(str(r.transcripts[0]).endswith(".jsonl"))

    def test_run_single_turn_timeout(self):
        def spawn(argv, **kw):
            raise subprocess.TimeoutExpired(argv, kw["timeout"])
        with tempfile.TemporaryDirectory() as d:
            r = arms.run_single_turn("claude-sonnet-5", "pkt", "run1", Path("/r"), 1, Path(d) / "w", spawn=spawn)
        self.assertEqual(r.status, "timeout")


class FleetWaitTests(unittest.TestCase):
    def test_done_by_handoff_file(self):
        with tempfile.TemporaryDirectory() as d:
            hd = Path(d); (hd / "20260829T150000Z-x.md").write_text("@from sonnet2  @re run77  @status done\nok")
            ok = arms.fleet_wait_done("run77", 0.0, 10, hd, capture=lambda: "", sleep=lambda s: None, clock=iter([1.0, 2.0]).__next__)
        self.assertTrue(ok)

    def test_done_by_pane(self):
        pane = "❯ @to sonnet2 … @id run77\n⏺ @from sonnet2  @re run77  @status done  @out x.md\n  built\n✻ done\n❯ \n"
        with tempfile.TemporaryDirectory() as d:
            ok = arms.fleet_wait_done("run77", 0.0, 10, Path(d), capture=lambda: pane, sleep=lambda s: None, clock=iter([1.0]).__next__)
        self.assertTrue(ok)

    def test_timeout(self):
        with tempfile.TemporaryDirectory() as d:
            ok = arms.fleet_wait_done("run77", 0.0, 5, Path(d), capture=lambda: "", sleep=lambda s: None, clock=iter([1.0, 3.0, 6.0]).__next__)
        self.assertFalse(ok)

    def test_old_handoff_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            hd = Path(d); f = hd / "old.md"; f.write_text("@re run77"); import os; os.utime(f, (1, 1))
            ok = arms.fleet_wait_done("run77", 100.0, 5, hd, capture=lambda: "", sleep=lambda s: None, clock=iter([101.0, 200.0]).__next__)
        self.assertFalse(ok)
```

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError: fleet.bench.arms`

- [ ] **Step 3: Implement**

```python
# fleet/bench/arms.py
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
_WS = re.compile(r"\s+")


@dataclass
class ArmResult:
    status: str                      # done | timeout | error
    transcripts: list[Path] = field(default_factory=list)
    stdout_path: Path | None = None
    note: str = ""


def single_turn_argv(model: str, session_id: str, packet: str, root: Path) -> list[str]:
    return ["claude", "-p", "--model", model, "--session-id", session_id, "--permission-mode", "acceptEdits",
            "--add-dir", str(root), "--settings", str(root / "settings/v2/hot.json"), "--strict-mcp-config", packet]


def run_single_turn(model: str, packet: str, run: str, root: Path, timeout_s: int, workdir: Path,
                    spawn=subprocess.run) -> ArmResult:
    workdir.mkdir(parents=True, exist_ok=True)
    sid = str(uuid.uuid4())
    out = workdir / "stdout.txt"
    transcripts = [transcript_path(workdir, sid)]
    try:
        r = spawn(single_turn_argv(model, sid, packet, root), cwd=str(workdir), capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return ArmResult("timeout", transcripts, out, "claude -p exceeded timeout_s")
    out.write_text(r.stdout or "")
    if r.returncode != 0:
        return ArmResult("error", transcripts, out, f"claude -p exit {r.returncode}: {(r.stderr or '')[-300:]}")
    return ArmResult("done", transcripts, out)


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
        sleep(5)


def run_fleet(packet_text: str, refs: list[str], done: str, run: str, root: Path, timeout_s: int, lane: str,
              profile: str, registry_entries: dict, send=send_mod.send_packet, capture=None, sleep=time.sleep, clock=time.time) -> ArmResult:
    from fleet.registry import transcript_for
    transcripts = [transcript_for(e, registry_entries) for e in registry_entries.values()]
    p = packet_mod.Packet(to=FLEET_TARGET, sender="bench", lane=lane, effort=packet_mod.LANES[lane].effort, reply="file",
                          refs=refs, done=done, id=run, body=packet_text)
    t0 = clock()
    try:
        send(p, profile)
    except send_mod.SendError as exc:
        return ArmResult("error", transcripts, None, str(exc))
    cap = capture or (lambda: tmux.capture(FLEET_TARGET, lines=200, join=True))
    ok = fleet_wait_done(run, t0, timeout_s, root / "ledger" / "handoffs" / FLEET_TARGET, cap, sleep, clock)
    return ArmResult("done" if ok else "timeout", transcripts, None, "" if ok else "no @re reply within timeout_s")
```

- [ ] **Step 4: Run** — 7 passed
- [ ] **Step 5: Commit** — `git commit -m "feat(bench): arms - headless single-turn and fleet packet with done detection"`

---

### Task 4: Runner — one arm-run to one row; check, judge, cleanup

**Files:**
- Create: `fleet/bench/run.py`
- Test: `tests/test_bench_run.py`

**Interfaces:**
- Consumes: Tasks 1–3; `fleet.ledger.read_events()`, `fleet.packet.new_id()`, `fleet.cli.current_profile()`, `fleet.registry.Registry().load()`, `fleet.ledger.EVENTS`.
- Produces: `run_one(task: TaskSpec, arm: str, root: Path, runs_path: Path, *, execute=None, check_run=subprocess.run, judge_fn=None, events=None, clock=time.time) -> dict` (the row; appended to `runs_path`); `judge(rubric_path, done, artifacts: list[str], run, root, spawn=subprocess.run) -> tuple[int | None, str | None]` (score, write-up path) using `claude -p --model claude-opus-5`; `ensure_gui(root) -> callable` that starts `python3 -m gui --port 8787` if `:8787` is not listening and returns a stop function (no-op if it was already up); `RUNS = LEDGER / "bench" / "runs.jsonl"`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_bench_run.py
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from fleet.bench import run as brun, tasks
from fleet.bench.arms import ArmResult


def task(**kw):
    base = dict(id="t1", lane="build", packet="build {target}", refs=[], target="bench/work/{run}/out", done="exists",
                check="test -d {target}", judge=None, timeout_s=10, cleanup="rm -rf {target}")
    base.update(kw); return tasks.TaskSpec(**base)


class RunOneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name); self.runs = self.root / "runs.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def _exec(self, status="done"):
        def execute(resolved, run, arm):
            (self.root / resolved.target).mkdir(parents=True, exist_ok=True)
            return ArmResult(status, transcripts=[], stdout_path=None)
        return execute

    def test_pass_row(self):
        row = brun.run_one(task(), "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([100.0, 104.5]).__next__)
        self.assertEqual((row["status"], row["check_rc"], row["arm"], row["task"]), ("pass", 0, "sonnet", "t1"))
        self.assertAlmostEqual(row["wall_s"], 4.5)
        self.assertEqual(row["pool"]["weekly"], {"opus": 0.0, "sonnet": 0.0, "haiku": 0.0})
        self.assertIsNone(row["judge"]); self.assertEqual(json.loads(self.runs.read_text())["run"], row["run"])
        self.assertFalse((self.root / "bench/work" / row["run"] / "out").exists())  # cleanup ran

    def test_fail_row_when_check_fails(self):
        row = brun.run_one(task(check="test -f {target}/missing"), "sonnet", self.root, self.runs, execute=self._exec(), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["check_rc"]), ("fail", 1))

    def test_timeout_row_skips_check(self):
        row = brun.run_one(task(), "fleet", self.root, self.runs, execute=self._exec("timeout"), events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["status"], row["check_rc"]), ("timeout", None))

    def test_judge_only_on_pass_with_rubric(self):
        calls = []
        def judge_fn(rubric, done, artifacts, run, root):
            calls.append(rubric); return 4, "ledger/handoffs/judge/x.md"
        row = brun.run_one(task(judge="bench/rubrics/w.md"), "fable", self.root, self.runs, execute=self._exec(), events=[], judge_fn=judge_fn, clock=iter([1.0, 2.0]).__next__)
        self.assertEqual((row["judge"], row["judge_path"], calls), (4, "ledger/handoffs/judge/x.md", ["bench/rubrics/w.md"]))
        row = brun.run_one(task(judge="bench/rubrics/w.md", check="false"), "fable", self.root, self.runs, execute=self._exec(), events=[], judge_fn=judge_fn, clock=iter([1.0, 2.0]).__next__)
        self.assertIsNone(row["judge"]); self.assertEqual(len(calls), 1)

    def test_error_row_on_exception(self):
        def execute(resolved, run, arm):
            raise RuntimeError("boom")
        row = brun.run_one(task(), "sonnet", self.root, self.runs, execute=execute, events=[], clock=iter([1.0, 2.0]).__next__)
        self.assertEqual(row["status"], "error"); self.assertIn("boom", row["error"])


class JudgeParseTests(unittest.TestCase):
    def test_parse_score_last_line(self):
        self.assertEqual(brun._parse_score("blah\nscore: 4\n3\n"), 3)
        self.assertIsNone(brun._parse_score("no number here"))
```

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError: fleet.bench.run`

- [ ] **Step 3: Implement**

```python
# fleet/bench/run.py
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
        if res.status == "done":
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
```

- [ ] **Step 4: Run** — `python3 -m pytest -q tests/test_bench_run.py` → 6 passed (note: `test -d`/`rm -rf` run via `shell=True` inside the temp root — the cleanup literally deletes `bench/work/<run>/out` under the temp dir, which is the point of the assertion)
- [ ] **Step 5: Commit** — `git commit -m "feat(bench): runner - arm-run to row, check gate, judge on pass, cleanup"`

---

### Task 5: Report and CLI verbs

**Files:**
- Create: `fleet/bench/report.py`
- Modify: `fleet/cli.py` (add `bench` subparser with `run` and `report`)
- Test: `tests/test_bench_report.py`, `tests/fixtures/bench_runs.jsonl`

**Interfaces:**
- Consumes: rows from Task 4; `fleet.bench.run.run_many`.
- Produces: `report.summarize(rows) -> dict` (`{task: {arm: {"n", "pass_rate", "wall_med", "usd_med", "weekly_med", "fable_med", "interventions_per_run", "judge_med"}}}` plus `"headline": {"accuracy": {...}, "cost": {...}, "time": {...}}` with per-arm values and `fleet_vs_sonnet`/`fleet_vs_fable` ratios, `None` when a denominator is 0 or n = 0); `report.render(summary) -> str`; CLI `fleet bench run <task|all> [--arms a,b,c] [--repeat N]`, `fleet bench report [--since YYYY-MM-DD]`.

- [ ] **Step 1: Fixture** — `tests/fixtures/bench_runs.jsonl` (6 rows: task `t1` × arms fable/sonnet/fleet, two runs each; make sonnet fail once):

```json
{"run":"r1","task":"t1","arm":"fable","t0":1000,"t1":1109,"wall_s":109,"status":"pass","check_rc":0,"judge":4,"judge_path":null,"interventions":{"keypress":0,"decide":0,"escalate":0,"block":0},"tokens":{},"usd":4.9,"pool":{"fable":4.9,"weekly":{"opus":0,"sonnet":0,"haiku":0}},"commit":"a","error":null}
{"run":"r2","task":"t1","arm":"fable","t0":2000,"t1":2101,"wall_s":101,"status":"pass","check_rc":0,"judge":5,"judge_path":null,"interventions":{"keypress":0,"decide":0,"escalate":0,"block":0},"tokens":{},"usd":4.1,"pool":{"fable":4.1,"weekly":{"opus":0,"sonnet":0,"haiku":0}},"commit":"a","error":null}
{"run":"r3","task":"t1","arm":"sonnet","t0":3000,"t1":3090,"wall_s":90,"status":"pass","check_rc":0,"judge":3,"judge_path":null,"interventions":{"keypress":0,"decide":0,"escalate":0,"block":0},"tokens":{},"usd":0.5,"pool":{"fable":0,"weekly":{"opus":0,"sonnet":0.5,"haiku":0}},"commit":"a","error":null}
{"run":"r4","task":"t1","arm":"sonnet","t0":4000,"t1":4080,"wall_s":80,"status":"fail","check_rc":1,"judge":null,"judge_path":null,"interventions":{"keypress":0,"decide":0,"escalate":1,"block":0},"tokens":{},"usd":0.4,"pool":{"fable":0,"weekly":{"opus":0,"sonnet":0.4,"haiku":0}},"commit":"a","error":null}
{"run":"r5","task":"t1","arm":"fleet","t0":5000,"t1":5104,"wall_s":104,"status":"pass","check_rc":0,"judge":4,"judge_path":null,"interventions":{"keypress":0,"decide":1,"escalate":1,"block":0},"tokens":{},"usd":0.31,"pool":{"fable":0,"weekly":{"opus":0,"sonnet":0.29,"haiku":0.02}},"commit":"a","error":null}
{"run":"r6","task":"t1","arm":"fleet","t0":6000,"t1":6100,"wall_s":100,"status":"pass","check_rc":0,"judge":4,"judge_path":null,"interventions":{"keypress":0,"decide":0,"escalate":0,"block":0},"tokens":{},"usd":0.33,"pool":{"fable":0,"weekly":{"opus":0,"sonnet":0.30,"haiku":0.03}},"commit":"a","error":null}
```

- [ ] **Step 2: Write the failing tests**

```python
# tests/test_bench_report.py
import json
import unittest
from pathlib import Path

from fleet.bench import report

FIX = Path(__file__).parent / "fixtures" / "bench_runs.jsonl"
ROWS = [json.loads(l) for l in FIX.read_text().splitlines()]


class ReportTests(unittest.TestCase):
    def test_per_arm_stats(self):
        s = report.summarize(ROWS)
        a = s["t1"]["sonnet"]
        self.assertEqual((a["n"], a["pass_rate"], a["wall_med"], a["usd_med"]), (2, 0.5, 85.0, 0.45))
        self.assertEqual(s["t1"]["fleet"]["weekly_med"], 0.32)
        self.assertEqual(s["t1"]["fleet"]["interventions_per_run"], 1.0)
        self.assertEqual(s["t1"]["fable"]["judge_med"], 4.5)

    def test_headline_ratios(self):
        h = report.summarize(ROWS)["headline"]
        self.assertEqual(h["accuracy"]["fleet"], 1.0); self.assertEqual(h["accuracy"]["fleet_vs_sonnet"], 2.0)
        self.assertAlmostEqual(h["cost"]["fleet_vs_fable"], 0.32 / 4.5, places=3)
        self.assertAlmostEqual(h["time"]["fleet_vs_sonnet"], 102.0 / 90.0, places=3)  # per pass: sonnet's only pass took 90 s

    def test_missing_arm_yields_none_not_crash(self):
        h = report.summarize([r for r in ROWS if r["arm"] != "fable"])["headline"]
        self.assertIsNone(h["cost"]["fleet_vs_fable"])

    def test_render_mentions_n(self):
        text = report.render(report.summarize(ROWS))
        self.assertIn("n=2", text); self.assertIn("fleet", text); self.assertIn("accuracy", text.lower())
```

- [ ] **Step 3: Run to verify failure** — `ModuleNotFoundError: fleet.bench.report`

- [ ] **Step 4: Implement**

```python
# fleet/bench/report.py
"""Aggregate runs.jsonl (spec: Report)."""
import json
import statistics as st
from pathlib import Path

ARMS = ("fable", "sonnet", "fleet")


def load(path: Path, since: float | None = None) -> list[dict]:
    rows = []
    for line in path.read_text().splitlines() if path.exists() else []:
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if since is None or (r.get("t0") or 0) >= since:
            rows.append(r)
    return rows


def _med(xs):
    xs = [x for x in xs if x is not None]
    return round(st.median(xs), 4) if xs else None


def _arm_stats(rows: list[dict]) -> dict:
    passes = [r for r in rows if r["status"] == "pass"]
    return {"n": len(rows), "pass_rate": (len(passes) / len(rows)) if rows else None,
            "wall_med": _med([r["wall_s"] for r in rows]), "usd_med": _med([r["usd"] for r in rows]),
            "weekly_med": _med([sum(r["pool"]["weekly"].values()) for r in rows]), "fable_med": _med([r["pool"]["fable"] for r in rows]),
            "interventions_per_run": (sum(sum(r["interventions"].values()) for r in rows) / len(rows)) if rows else None,
            "judge_med": _med([r["judge"] for r in passes]),
            # per-pass medians feed the headline ratios
            "_wall_pass_med": _med([r["wall_s"] for r in passes]), "_usd_pass_med": _med([r["usd"] for r in passes]),
            "_weekly_pass_med": _med([sum(r["pool"]["weekly"].values()) for r in passes])}


def _ratio(a, b):
    return round(a / b, 4) if a is not None and b else None


def summarize(rows: list[dict]) -> dict:
    out: dict = {}
    for r in rows:
        out.setdefault(r["task"], {}).setdefault(r["arm"], []).append(r)
    summary = {task: {arm: _arm_stats(rs) for arm, rs in arms.items()} for task, arms in out.items()}
    by_arm = {arm: [r for r in rows if r["arm"] == arm] for arm in ARMS}
    stats = {arm: _arm_stats(rs) for arm, rs in by_arm.items()}
    acc = {arm: stats[arm]["pass_rate"] for arm in ARMS}
    cost = {arm: stats[arm]["_usd_pass_med"] for arm in ARMS}
    weekly = {arm: stats[arm]["_weekly_pass_med"] for arm in ARMS}
    tm = {arm: stats[arm]["_wall_pass_med"] for arm in ARMS}
    summary["headline"] = {
        "n": {arm: stats[arm]["n"] for arm in ARMS},
        "accuracy": {**acc, "fleet_vs_sonnet": _ratio(acc["fleet"], acc["sonnet"]), "fleet_vs_fable": _ratio(acc["fleet"], acc["fable"])},
        "cost": {**cost, "weekly": weekly, "fleet_vs_sonnet": _ratio(cost["fleet"], cost["sonnet"]), "fleet_vs_fable": _ratio(cost["fleet"], cost["fable"])},
        "time": {**tm, "fleet_vs_sonnet": _ratio(tm["fleet"], tm["sonnet"]), "fleet_vs_fable": _ratio(tm["fleet"], tm["fable"])},
    }
    return summary


def _f(x, fmt="{:.2f}"):
    return "-" if x is None else fmt.format(x)


def render(summary: dict) -> str:
    lines = [f"{'task':16} {'arm':7} {'n':>3} {'pass':>5} {'wall':>7} {'$':>6} {'weekly$':>8} {'fable$':>7} {'interv':>6} {'judge':>5}"]
    for task, arms in summary.items():
        if task == "headline":
            continue
        for arm, s in arms.items():
            lines.append(f"{task:16} {arm:7} {s['n']:>3} {_f(s['pass_rate']):>5} {_f(s['wall_med'], '{:.0f}s'):>7} {_f(s['usd_med']):>6} "
                         f"{_f(s['weekly_med']):>8} {_f(s['fable_med']):>7} {_f(s['interventions_per_run'], '{:.1f}'):>6} {_f(s['judge_med'], '{:.1f}'):>5}")
    h = summary.get("headline", {})
    if h:
        n = h["n"]
        lines.append("")
        lines.append(f"accuracy (pass rate)  fable {_f(h['accuracy']['fable'])} n={n['fable']}  sonnet {_f(h['accuracy']['sonnet'])} n={n['sonnet']}  "
                     f"fleet {_f(h['accuracy']['fleet'])} n={n['fleet']}  | fleet/sonnet {_f(h['accuracy']['fleet_vs_sonnet'])}  fleet/fable {_f(h['accuracy']['fleet_vs_fable'])}")
        lines.append(f"cost ($ per pass)     fable {_f(h['cost']['fable'])}  sonnet {_f(h['cost']['sonnet'])}  fleet {_f(h['cost']['fleet'])}  "
                     f"(weekly-pool $: sonnet {_f(h['cost']['weekly']['sonnet'])}  fleet {_f(h['cost']['weekly']['fleet'])})  | fleet/sonnet {_f(h['cost']['fleet_vs_sonnet'])}  fleet/fable {_f(h['cost']['fleet_vs_fable'])}")
        lines.append(f"time (s per pass)     fable {_f(h['time']['fable'], '{:.0f}')}  sonnet {_f(h['time']['sonnet'], '{:.0f}')}  fleet {_f(h['time']['fleet'], '{:.0f}')}  "
                     f"| fleet/sonnet {_f(h['time']['fleet_vs_sonnet'])}  fleet/fable {_f(h['time']['fleet_vs_fable'])}")
    return "\n".join(lines)
```

`fleet/cli.py` additions:

```python
def cmd_bench(args):
    from datetime import datetime
    from fleet.bench import report as breport, run as brun
    if args.bench_cmd == "run":
        ids = None if args.task == "all" else [args.task]
        brun.run_many(ids, args.arms.split(","), repeat=args.repeat)
        return 0
    since = datetime.strptime(args.since, "%Y-%m-%d").timestamp() if args.since else None
    print(breport.render(breport.summarize(breport.load(brun.RUNS, since)))); return 0
```

subparser: `b = sub.add_parser("bench"); bs = b.add_subparsers(dest="bench_cmd", required=True); br = bs.add_parser("run"); br.add_argument("task"); br.add_argument("--arms", default="fable,sonnet,fleet"); br.add_argument("--repeat", type=int, default=1); br.set_defaults(fn=cmd_bench); bp = bs.add_parser("report"); bp.add_argument("--since"); bp.set_defaults(fn=cmd_bench)`. Validate arms: each must be in `("fable", "sonnet", "fleet")`, else print an error and return 1 (add `test_bench_cli_rejects_bad_arm` in `tests/test_bench_report.py` using `cli.main(["bench", "run", "all", "--arms", "gpt"])` → returns 1 without running anything — patch `fleet.bench.run.run_many`).

- [ ] **Step 5: Run** — `python3 -m pytest -q tests/test_bench_report.py` → 5 passed; full non-live suite green
- [ ] **Step 6: Commit** — `git commit -m "feat(bench): report aggregation and fleet bench run/report verbs"`

---

### Task 6: The initial task set and rubrics

**Files:**
- Create: `bench/tasks/lookup-newest-handoff.toml`, `bench/tasks/build-gui-slice2.toml`, `bench/tasks/plan-workspace-widget.toml`, `bench/tasks/judge-two-widgets.toml`, `bench/rubrics/widget.md`, `bench/rubrics/design.md`, `bench/rubrics/review.md`, `bench/.gitignore` (`work/`)
- Test: `tests/test_bench_taskset.py`

**Interfaces:** Consumes Task 1's loader. Produces the four spec'd lane tasks, each with a `check` that is runnable from ROOT with `sh`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_bench_taskset.py
import unittest
from pathlib import Path

from fleet.bench import tasks
from fleet.paths import ROOT


class TaskSetTests(unittest.TestCase):
    def test_four_lane_tasks_load_and_substitute(self):
        ts = tasks.load_all(ROOT / "bench" / "tasks")
        self.assertEqual(sorted(t.lane for t in ts), ["build", "judge", "lookup", "plan"])
        for t in ts:
            r = tasks.substitute(t, "deadbeefdeadbeef", ROOT)
            for field in ("packet", "target", "check"):
                self.assertNotIn("{", getattr(r, field), f"{t.id}.{field} has an unresolved placeholder")
            if t.judge:
                self.assertTrue((ROOT / t.judge).exists(), t.judge)
            self.assertIn("deadbeefdeadbeef", r.target)
        self.assertTrue((ROOT / "bench" / ".gitignore").read_text().strip() == "work/")
```

- [ ] **Step 2: Run to verify failure** — `AssertionError`/`FileNotFoundError` (no `bench/tasks`)

- [ ] **Step 3: Write the files**

`bench/tasks/lookup-newest-handoff.toml`:
```toml
id = "lookup-newest-handoff"
lane = "lookup"
packet = "Which file under {root}/ledger/handoffs/ (recursive) is newest by mtime? Write ONLY its ROOT-relative path to {target}/reply.txt (create the directory), then reply with that path."
refs = []
target = "bench/work/{run}/out"
done = "{target}/reply.txt names the newest handoff"
check = "mkdir -p {target} && test \"$(cat {target}/reply.txt | tr -d '[:space:]')\" = \"$(cd {root} && ls -t ledger/handoffs/*/*.md | head -1)\""
timeout_s = 180
cleanup = "rm -rf bench/work/{run}"
```

`bench/tasks/build-gui-slice2.toml`:
```toml
id = "build-gui-slice2"
lane = "build"
packet = "Build the workspace widget from slice 2 of the design at {refs}, as a NEW widget directory {root}/{target}/ (id = the directory name). Do not modify any other widget. Done when POST /w/<id>/push with JSON {\"title\":\"t\",\"body\":\"b\"} returns JSON containing \"name\" and GET /w/<id>/ lists it. The GUI server is running on http://127.0.0.1:8787 with the token in {root}/state/gui-token (cookie fleet_gui=<token>). Reply with the handoff path."
refs = ["ledger/handoffs/opus/20260829T021451Z-gui-design.md"]
target = "gui/widgets/bench{run}"
done = "POST /w/bench{run}/push returns a name and GET /w/bench{run}/ lists it"
check = "T=$(cat state/gui-token); curl -sf -b fleet_gui=$T -H 'Content-Type: application/json' -X POST -d '{\"title\":\"t\",\"body\":\"b\"}' http://127.0.0.1:8787/w/bench{run}/push | grep -q name && curl -sf -b fleet_gui=$T http://127.0.0.1:8787/w/bench{run}/ | grep -q name"
judge = "bench/rubrics/widget.md"
timeout_s = 900
cleanup = "rm -rf gui/widgets/bench{run} state/bench{run} state/workspace-bench{run}"
```
(The widget id `bench<run>` is 21 chars of `[a-z0-9]` — valid as a Python module name and a URL segment.)

`bench/tasks/plan-workspace-widget.toml`:
```toml
id = "plan-workspace-widget"
lane = "plan"
packet = "Design (do not build) the workspace widget for the dashboard described in {refs}: routes, storage under state/, client contract, security. Write the design to {target}/design.md (create the directory) with sections '## Routes', '## Storage', '## Security', '## Build order'. Reply with the path."
refs = ["ledger/handoffs/opus/20260829T021451Z-gui-design.md"]
target = "bench/work/{run}/out"
done = "{target}/design.md exists with the four sections"
check = "for s in Routes Storage Security 'Build order'; do grep -q \"## $s\" {target}/design.md || exit 1; done"
judge = "bench/rubrics/design.md"
timeout_s = 900
cleanup = "rm -rf bench/work/{run}"
```

`bench/tasks/judge-two-widgets.toml`:
```toml
id = "judge-two-widgets"
lane = "judge"
packet = "Compare gui/widgets/workspace/ and gui/widgets/workspace-r2/ against the design at {refs}. Write a verdict to {target}/verdict.md (create the directory) containing a scoring table, a '## Winner' section naming one of them, and file:line evidence. Reply with the path."
refs = ["ledger/handoffs/opus/20260829T021451Z-gui-design.md"]
target = "bench/work/{run}/out"
done = "{target}/verdict.md has a Winner section naming workspace or workspace-r2"
check = "grep -q '## Winner' {target}/verdict.md && grep -Eq 'workspace(-r2)?' {target}/verdict.md"
judge = "bench/rubrics/review.md"
timeout_s = 900
cleanup = "rm -rf bench/work/{run}"
```

Rubrics (each ≤ 15 lines, five criteria, "score = round(mean)"): `widget.md` — design compliance, security (sandboxed HTML, traversal), mobile UX (44 px targets, `ctx.poll`, push affordance), code quality, handoff honesty. `design.md` — completeness of the four sections, consistency with the widget contract, security section names concrete mechanisms, build order has a first slice servable in < 15 min, brevity. `review.md` — evidence cited as file:line, claims verified not trusted, both candidates treated symmetrically, defects rated by severity, a single clear winner with reasoning.

`bench/.gitignore`: `work/`

- [ ] **Step 4: Run** — 1 passed; then a dry substitution check: `python3 -c "from fleet.bench import tasks; from fleet.paths import ROOT; [print(t.id, tasks.substitute(t,'abc',ROOT).check) for t in tasks.load_all(ROOT/'bench/tasks')]"` and eyeball that each `check` is a valid `sh` line.
- [ ] **Step 5: Commit** — `git commit -m "feat(bench): four lane tasks and rubrics"`

---

### Task 7: `bench` dashboard widget

**Files:**
- Create: `gui/widgets/bench/__init__.py`, `gui/widgets/bench/server.py`, `gui/widgets/bench/widget.js`
- Test: `tests/test_gui_bench_widget.py`

**Interfaces:**
- Consumes: `fleet.bench.report.load/summarize`, `fleet.bench.run.RUNS`; widget contract (`ROUTES`, `WATCH`, `meta`, `mount(ctx)`, `ctx.api.get`, `ctx.on`, `ctx.poll`, `ctx.css`).
- Produces: `GET /w/bench/?since=YYYY-MM-DD` → `{"summary": <summarize()>, "last": [last 10 rows]}`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_gui_bench_widget.py
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from gui.widgets.bench import server as bsrv

FIX = Path(__file__).parent / "fixtures" / "bench_runs.jsonl"


class BenchWidgetTests(unittest.TestCase):
    def test_get_returns_summary_and_last(self):
        with mock.patch("gui.widgets.bench.server.RUNS", FIX):
            out = bsrv.get(SimpleNamespace(method="GET", query={}, json=lambda: {}, publish=lambda *a: None))
        self.assertEqual(out["summary"]["headline"]["accuracy"]["fleet"], 1.0)
        self.assertEqual(len(out["last"]), 6); self.assertEqual(out["last"][0]["run"], "r6")

    def test_bad_since_is_400(self):
        from gui.server import HttpError
        with self.assertRaises(HttpError):
            bsrv.get(SimpleNamespace(method="GET", query={"since": "yesterday"}, json=lambda: {}, publish=lambda *a: None))
```

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError: gui.widgets.bench`

- [ ] **Step 3: Implement**

```python
# gui/widgets/bench/server.py
"""Bench headlines and last runs (spec: Widget)."""
from datetime import datetime

from fleet.bench import report
from fleet.bench.run import RUNS as _RUNS
from gui.server import HttpError

RUNS = _RUNS
WATCH = ["ledger/bench/runs.jsonl"]


def get(ctx):
    since = None
    if ctx.query.get("since"):
        try:
            since = datetime.strptime(ctx.query["since"], "%Y-%m-%d").timestamp()
        except ValueError:
            raise HttpError(400, "since must be YYYY-MM-DD")
    rows = report.load(RUNS, since)
    return {"summary": report.summarize(rows), "last": list(reversed(rows[-10:]))}


ROUTES = {"": get}
```

```js
// gui/widgets/bench/widget.js
export const meta = { title: 'Bench', panel: 'dashboard', order: 50 };

export function mount(ctx) {
  ctx.css(`
    .bcards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
    .bcard{background:var(--panel-2,#1e2633);border-radius:12px;padding:10px}
    .bcard h3{margin:0 0 4px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
    .bval{font-size:15px}.bsub{font-size:11px;color:var(--muted)}
    .brow{display:grid;grid-template-columns:5em 4.5em 4em 5em 5em 1fr;gap:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:3px 0;border-top:1px solid #222}
    .pass{color:var(--good)}.fail,.timeout,.error{color:var(--bad)}`);
  const f = (x, d = 2) => x == null ? '–' : Number(x).toFixed(d);
  const card = (title, lines) => { const c = document.createElement('div'); c.className = 'bcard';
    const h = document.createElement('h3'); h.textContent = title; c.append(h);
    for (const [v, s] of lines) { const a = document.createElement('div'); a.className = 'bval'; a.textContent = v; const b = document.createElement('div'); b.className = 'bsub'; b.textContent = s; c.append(a, b); }
    return c; };
  const draw = async () => {
    const { summary, last } = await ctx.api.get('');
    const h = summary.headline || null; ctx.root.replaceChildren();
    if (!h) { const e = document.createElement('div'); e.className = 'bsub'; e.textContent = 'no bench runs yet'; ctx.root.append(e); return; }
    const cards = document.createElement('div'); cards.className = 'bcards';
    cards.append(
      card('accuracy', [[`fleet ${f(h.accuracy.fleet)} · sonnet ${f(h.accuracy.sonnet)} · fable ${f(h.accuracy.fable)}`, `n ${h.n.fleet}/${h.n.sonnet}/${h.n.fable}`], [`fleet/sonnet ${f(h.accuracy.fleet_vs_sonnet)}`, `fleet/fable ${f(h.accuracy.fleet_vs_fable)}`]]),
      card('cost $ per pass', [[`fleet ${f(h.cost.fleet)} · sonnet ${f(h.cost.sonnet)} · fable ${f(h.cost.fable)}`, `weekly pool: fleet ${f(h.cost.weekly.fleet)} · sonnet ${f(h.cost.weekly.sonnet)}`], [`fleet/sonnet ${f(h.cost.fleet_vs_sonnet)}`, `fleet/fable ${f(h.cost.fleet_vs_fable)}`]]),
      card('time s per pass', [[`fleet ${f(h.time.fleet, 0)} · sonnet ${f(h.time.sonnet, 0)} · fable ${f(h.time.fable, 0)}`, ''], [`fleet/sonnet ${f(h.time.fleet_vs_sonnet)}`, `fleet/fable ${f(h.time.fleet_vs_fable)}`]]));
    ctx.root.append(cards);
    for (const r of last) { const row = document.createElement('div'); row.className = 'brow ' + r.status;
      for (const v of [r.task, r.arm, r.status, `${f(r.wall_s, 0)}s`, `$${f(r.usd)}`, r.judge == null ? '' : `judge ${r.judge}`]) { const s = document.createElement('span'); s.textContent = v; row.append(s); }
      ctx.root.append(row); }
  };
  ctx.on('changed', draw); ctx.poll(30000, draw); draw();
}
```

- [ ] **Step 4: Run** — 2 passed; live: `curl -s -b fleet_gui=$(cat state/gui-token) http://127.0.0.1:8787/api/widgets` lists `bench`.
- [ ] **Step 5: Commit** — `git commit -m "feat(bench): dashboard widget"`

---

### Task 8: Nightly job, runbook, live test, first pass

**Files:**
- Create: `ops/com.pup.fleet.bench.plist`, `tests/test_bench_live.py`
- Modify: `docs/RUNBOOK.md`

- [ ] **Step 1: Live test** (skips unless `fleet2` is up)

```python
# tests/test_bench_live.py
import subprocess
import tempfile
import unittest
from pathlib import Path

from fleet.bench import run as brun, tasks
from fleet.paths import ROOT

LIVE = subprocess.run(["tmux", "has-session", "-t", "fleet2"], capture_output=True).returncode == 0


@unittest.skipUnless(LIVE, "tmux session fleet2 not running")
class BenchLiveTests(unittest.TestCase):
    def test_lookup_task_on_fleet_arm(self):
        t = tasks.load_task(ROOT / "bench/tasks/lookup-newest-handoff.toml")
        with tempfile.TemporaryDirectory() as d:
            row = brun.run_one(t, "fleet", ROOT, Path(d) / "runs.jsonl")
        self.assertIn(row["status"], ("pass", "fail"), row.get("error"))
        self.assertIn("claude-sonnet-5", row["tokens"])  # sonnet2 answered; tokens attributed

    def test_lookup_task_on_sonnet_arm(self):
        t = tasks.load_task(ROOT / "bench/tasks/lookup-newest-handoff.toml")
        with tempfile.TemporaryDirectory() as d:
            row = brun.run_one(tasks.TaskSpec(**{**t.__dict__, "timeout_s": 120}), "sonnet", ROOT, Path(d) / "runs.jsonl")
        self.assertIn(row["status"], ("pass", "fail", "timeout"), row.get("error"))
        if row["status"] != "timeout":
            self.assertTrue(row["tokens"], "headless claude -p produced no transcript turns in the window")
```

- [ ] **Step 2: Plist** — copy `ops/com.pup.fleet.telemetry.plist`, change the label to `com.pup.fleet.bench`, `ProgramArguments` to `/Users/pup/fleet/bin/fleet bench run all --arms sonnet,fleet`, `StartCalendarInterval` Hour 3 Minute 0, logs to `state/bench.log`. Do not install it (the runbook tells the operator how).

- [ ] **Step 3: Runbook** — append:

```markdown
## Bench (spec docs/superpowers/specs/2026-08-29-fleet-bench-design.md)

| need | command |
|---|---|
| run everything, three arms | `fleet bench run all` (sequential; ≈ tasks × arms × minutes) |
| one task, cheap arms | `fleet bench run lookup-newest-handoff --arms sonnet,fleet` |
| the numbers | `fleet bench report [--since 2026-08-29]` — `$` is API-rate; `weekly$`/`fable$` split the same `$` by subscription pool (shares, not balances) |
| add a task | drop `bench/tasks/<id>.toml` (see the four there); `check` must exit 0 on success; `judge` is optional |
| nightly | `cp ops/com.pup.fleet.bench.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.pup.fleet.bench.plist` (sonnet + fleet arms; run the fable arm by hand) |
```

- [ ] **Step 4: First pass** — `bin/fleet bench run lookup-newest-handoff --arms sonnet,fleet` then `bin/fleet bench report`; paste the report into the commit message body. If the sonnet arm's `tokens` is empty, `claude -p` wrote its transcript somewhere other than `transcript_path(workdir, sid)` — find it with `ls -t ~/.claude/projects/*/ | head` and fix `run_single_turn`'s transcript path before continuing.
- [ ] **Step 5: Full suite, commit** — `git commit -m "feat(bench): live test, nightly plist, runbook; first pass results"`

---

## Self-review

**Spec coverage:** task definition → T1, T6; runner table (single-turn argv, fleet send + done detection, timeouts, sequential) → T3, T4 (`run_many` is sequential; timeout rows skip check; fleet timeout `fleet miss` — **gap**: add to T4's `run_one`: when `arm == "fleet"` and `res.status == "timeout"`, call `subprocess.run([str(root/"bin"/"fleet"), "miss", "sonnet2", f"bench-timeout-{run}"])` — added inline below); row schema → T4; `$` + pool → T2; interventions → T2; report + ratios with n → T5; widget → T7; nightly → T8; judge lane (fresh opus, write-up path) → T4 `judge()`; GUI ensure → T4 `ensure_gui`; testing section → T1–T8; risks (headless hooks) → T8 step 4 check.

**T4 addendum (fleet timeout):** in `run_one`, after `row["status"] = res.status`, add:
```python
        if res.status == "timeout" and arm == "fleet":
            subprocess.run([str(root / "bin" / "fleet"), "miss", "sonnet2", f"bench-timeout-{run}"], capture_output=True)
```
and in `tests/test_bench_run.py::test_timeout_row_skips_check` patch `subprocess.run` to assert it was called with `["…/bin/fleet", "miss", "sonnet2", "bench-timeout-<run>"]`.

**Placeholder scan:** none.

**Type consistency:** `TaskSpec`/`Resolved` fields used identically in T1/T4/T6/T8; `ArmResult(status, transcripts, stdout_path, note)` in T3/T4; `summarize()` keys (`n, pass_rate, wall_med, usd_med, weekly_med, fable_med, interventions_per_run, judge_med`, `headline.{n,accuracy,cost,time}`) in T5/T7; `RUNS` defined in T4, imported in T5/T7; `measure.pool_split` shape in T2/T4/T5 fixture.
