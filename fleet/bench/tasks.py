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
    # optional shell command evaluated by the runner at t0, BEFORE the arm runs;
    # its stdout (stripped) is substituted into check/cleanup as {expect}, so a
    # task can pin the expected answer to the state the arm actually saw.
    expect: str | None = None


Resolved = TaskSpec  # same shape, placeholders replaced


def load_task(path: Path) -> TaskSpec:
    d = tomllib.loads(path.read_text())
    t = TaskSpec(id=d["id"], lane=d["lane"], packet=d["packet"], refs=list(d.get("refs", [])),
                 target=d["target"], done=d["done"], check=d["check"], judge=d.get("judge"),
                 timeout_s=int(d.get("timeout_s", 900)), cleanup=d.get("cleanup"), expect=d.get("expect"))
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
                   cleanup=_sub(task.cleanup, run, root, target, refs), expect=_sub(task.expect, run, root, target, refs))


def with_expect(task: Resolved, value: str) -> Resolved:
    """Substitute the {expect} placeholder (the expect command's stdout) into check/cleanup."""
    def sub(s: str | None) -> str | None:
        return None if s is None else s.replace("{expect}", value)

    return replace(task, check=sub(task.check), cleanup=sub(task.cleanup))
