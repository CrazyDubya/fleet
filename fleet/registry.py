import json
import os
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .paths import STATE, transcript_path


class RegistryLocked(RuntimeError):
    pass


@dataclass
class Entry:
    name: str
    session_id: str
    cwd: str
    model: str
    status: str
    spec_hash: str
    spawned_at: float
    fork_of: str | None = None
    lineage: list[str] = field(default_factory=list)


def transcript_for(entry: Entry, entries: dict[str, Entry]) -> Path:
    """Where this entry's session transcript actually lives.

    `claude --resume <parent> --fork-session` writes the child's transcript
    into the PARENT's project directory (keyed off the parent's cwd), never
    the child's own - verified by hand against a live opus -> expert-test
    fork. Every reader (status.rows, telemetry.derive_day,
    status.resolve_pending_fork_ids) must agree on this, so it lives here.
    """
    parent = entries.get(entry.fork_of) if entry.fork_of else None
    cwd = Path(parent.cwd) if parent else Path(entry.cwd)
    return transcript_path(cwd, entry.session_id)


class Registry:
    def __init__(self, path: Path = STATE / "registry.json"):
        self.path = path
        self.lock_path = path.with_suffix(".lock")

    def load(self) -> dict[str, Entry]:
        if not self.path.exists():
            return {}
        raw = json.loads(self.path.read_text())
        return {k: Entry(**v) for k, v in raw.items()}

    def save(self, entries: dict[str, Entry]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps({k: asdict(v) for k, v in entries.items()}, indent=1, sort_keys=True))
        os.replace(tmp, self.path)

    @contextmanager
    def locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise RegistryLocked(f"registry locked by another fleet process ({self.lock_path})")
        try:
            os.write(fd, str(os.getpid()).encode()); os.close(fd)
            yield
        finally:
            try:
                os.unlink(self.lock_path)
            except FileNotFoundError:
                pass
