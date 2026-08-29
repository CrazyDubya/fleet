import hashlib
import json
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
    # Path (relative to ROOT) of a Claude Code settings JSON passed as
    # --settings. Part of the frozen prefix: its bytes go into spec_hash, so
    # editing the file flags the thread STALE-SPEC until it is respawned.
    settings: str | None = None
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


@dataclass
class Profile:
    name: str
    session: str
    briefs: str
    threads: dict[str, Thread]


def load_profile(name: str, path: Path | None = None) -> Profile:
    data = _read(path)
    if name == "v1":
        return Profile("v1", "fleet", "briefs", load_specs(path))
    body = data.get("profile", {})[name]  # KeyError for unknown profiles is the contract
    threads = {n: Thread(name=n, **b) for n, b in body.get("thread", {}).items()}
    return Profile(name, body.get("session", f"fleet-{name}"), body.get("briefs", f"briefs/{name}"), threads)


def _toml_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return json.dumps(v)  # TOML basic strings and JSON strings escape alike
    if isinstance(v, list):
        return "[" + ", ".join(_toml_value(x) for x in v) + "]"
    raise TypeError(f"cannot render {v!r} as TOML")


def render_stanza(t: Thread, profile: str = "v1") -> str:
    """`[thread.<name>]` (v1) or `[profile.<profile>.thread.<name>]` (any other
    profile) for a thread created at runtime.

    Spec §4: "Experts and extra tools are new [thread.<name>] entries with
    fork_of = ...". Without the stanza a forked child exists only in the
    registry, so wake/respawn answer "no thread named", status shows tier
    `?`, spec_stale is never computed and respawn_usd is 0. Under a non-v1
    profile the same problem applies to that profile's own readers
    (`load_profile(profile)`) - a bare `[thread.<name>]` lands in the v1
    namespace, which `fleet wake`/`status` never look at when
    FLEET_PROFILE=<profile>. Fields that are None are omitted rather than
    written as a null TOML has no word for.
    """
    fields: list[tuple[str, object]] = [
        ("model", t.model), ("tier", t.tier), ("persist", t.persist), ("baseline", t.baseline),
        ("mcp", t.mcp), ("dirs", t.dirs or None), ("permission_mode", t.permission_mode),
        ("settings", t.settings), ("effort", t.effort), ("forkable", t.forkable), ("fork_of", t.fork_of),
        ("resume_policy", t.resume_policy)]
    body = "".join(f"{k} = {_toml_value(v)}\n" for k, v in fields if v is not None)
    header = f"[thread.{t.name}]" if profile == "v1" else f"[profile.{profile}.thread.{t.name}]"
    return f"{header}\n{body}"


def append_thread(t: Thread, path: Path | None = None, profile: str = "v1") -> None:
    """Append `t`'s stanza to fleet.toml, under `profile`'s own namespace.
    Refuses to shadow an existing thread name within that same profile."""
    p = path or ROOT / "fleet.toml"
    existing = load_specs(p) if profile == "v1" else load_profile(profile, p).threads
    if t.name in existing:
        raise ValueError(f"a thread named {t.name!r} already exists in profile {profile!r} in {p}")
    p.write_text(p.read_text().rstrip("\n") + "\n\n" + render_stanza(t, profile))


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
    if thread.settings:
        # The settings file is part of the prefix's meaning: editing an
        # allowlist changes what the thread may do, so it must show up as
        # STALE-SPEC until the operator respawns.
        h.update(thread.settings.encode()); h.update((root / thread.settings).read_bytes())
    h.update((thread.effort or "").encode())
    return h.hexdigest()
