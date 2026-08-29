"""Drop-in workspace: agents (or the operator) push markdown/HTML snippets;
files dropped directly into state/workspace/ show up the same way via WATCH."""
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from fleet.paths import ROOT

from gui.server import HttpError

WORKSPACE = ROOT / "state" / "workspace"
WATCH = ["state/workspace/*"]

EXT = {"md": ".md", "html": ".html"}


def _slug(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (title or "note").lower()).strip("-")
    return s or "note"


def _clamped(rel: str) -> Path:
    target = (WORKSPACE / rel).resolve()
    try:
        target.relative_to(WORKSPACE.resolve())
    except ValueError:
        raise HttpError(403, "forbidden")
    return target


def list_(ctx):
    if not WORKSPACE.is_dir():
        return {"items": []}
    items = []
    for p in sorted(WORKSPACE.iterdir(), reverse=True):
        if not p.is_file() or p.suffix not in (".md", ".html"):
            continue
        items.append({
            "name": p.name,
            "format": "html" if p.suffix == ".html" else "md",
            "mtime": p.stat().st_mtime,
        })
    return {"items": items}


def read(ctx):
    p = ctx.query.get("p")
    if not p:
        raise HttpError(400, "missing p")
    target = _clamped(p)
    if not target.is_file():
        raise HttpError(404, "not found")
    return {
        "name": target.name,
        "format": "html" if target.suffix == ".html" else "md",
        "body": target.read_text(),
    }


def push(ctx):
    body = ctx.json()
    fmt = body.get("format", "md")
    if fmt not in EXT:
        raise HttpError(400, f"unknown format: {fmt}")
    text = body.get("body")
    if not text:
        raise HttpError(400, "missing body")
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    name = f"{stamp}-{_slug(body.get('title', ''))}{EXT[fmt]}"
    target = WORKSPACE / name
    target.write_text(text)
    ctx.publish("changed", {"name": name})
    return {"name": name}


ROUTES = {"": list_, "read": read, "push": push}
