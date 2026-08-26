import hashlib
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .paths import ROOT


@dataclass
class Thread:
    name: str
    model: str
    tier: str
    persist: str
    baseline: list[str] = field(default_factory=list)
    mcp: str | None = None
    dirs: list[str] = field(default_factory=list)
    permission_mode: str = "default"
    effort: str | None = None
    forkable: bool = False
    fork_of: str | None = None
    resume_policy: str = "packet-first"


def _read(path: Path | None) -> dict:
    with open(path or ROOT / "fleet.toml", "rb") as f:
        return tomllib.load(f)


def load_specs(path: Path | None = None) -> dict[str, Thread]:
    data = _read(path)
    return {name: Thread(name=name, **body) for name, body in data.get("thread", {}).items()}


def load_settings(path: Path | None = None) -> dict:
    data = _read(path)
    return {"cache_ttl_minutes": data.get("settings", {}).get("cache_ttl_minutes", 60)}


def spec_hash(thread: Thread, root: Path = ROOT) -> str:
    h = hashlib.sha256()
    h.update(thread.model.encode())
    for b in thread.baseline:
        h.update(b.encode()); h.update((root / b).read_bytes())
    if thread.mcp:
        h.update((root / "mcp" / f"{thread.mcp}.json").read_bytes())
    for d in thread.dirs:
        h.update(d.encode())
    h.update(thread.permission_mode.encode())
    h.update((thread.effort or "").encode())
    return h.hexdigest()
