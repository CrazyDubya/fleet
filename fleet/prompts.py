"""Permission decisions for unattended lanes (spec §3).

decide_auto: deny the destructive/egress patterns; allow anything whose
path tokens all resolve inside ROOT or /tmp; escalate the rest to the
operator through a prompt file the dashboard renders.
"""
import json
import os
import re
import shlex
import time
from pathlib import Path

from . import packet as packet_mod
from .paths import profile_state

DENY = [
    (re.compile(r"(^|[\s;&|])rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?!(/Users/pup/fleet/)?state/)"), "rm -rf outside state/"),
    (re.compile(r"(^|[\s;&|])git\s+push\b"), "git push"),
    (re.compile(r"(^|[\s;&|])git\s+reset\s+--hard\b"), "git reset --hard"),
    (re.compile(r"(^|[\s;&|])git\s+clean\s+-[a-zA-Z]*f"), "git clean -f"),
    (re.compile(r"(^|[\s;&|])(sudo|ssh|scp|rsync)\b"), "privileged or remote"),
    (re.compile(r"(^|[\s;&|])curl\b[^|;&]*\s-(X\s*(POST|PUT|DELETE|PATCH)|d|F|T|-data|-upload-file)\b"), "curl write/egress"),
    (re.compile(r"(^|[\s;&|])chmod\s+[0-7]*7[0-7]*\b|chmod\s+.*\+x"), "chmod"),
]
PATH_TOKEN = re.compile(r"^(~|/|\./|\.\./)")
INSIDE = ("/Users/pup/fleet", "/tmp", "/private/tmp")
DEV_OK = ("/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr")


def _tokens(command: str) -> list[str]:
    try:
        return shlex.split(command, posix=True)
    except ValueError:
        return command.split()


def _path_ok(tok: str, root: Path) -> bool:
    # strip shell decorations: redirections, option=paths, trailing punctuation
    tok = tok.lstrip("<>=").rstrip(";&|)")
    if "=" in tok and not tok.startswith("/"):
        tok = tok.split("=", 1)[1]
    if not PATH_TOKEN.match(tok):
        return True  # not a path
    p = os.path.expanduser(tok)
    p = os.path.normpath(p if p.startswith("/") else os.path.join(str(root), p))
    if p in DEV_OK:
        return True
    return any(p == base or p.startswith(base + "/") for base in (str(root), *INSIDE))


def decide_auto(command: str, root: Path) -> tuple[str, str]:
    for rx, why in DENY:
        if rx.search(command):
            return "deny", why
    for tok in _tokens(command):
        if not _path_ok(tok, root):
            return "escalate", f"path outside repo: {tok}"
    return "allow-auto", "in-repo, no deny match"


def _dir(profile: str) -> Path:
    d = profile_state(profile) / "prompts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def open_prompt(thread: str, tool: str, command: str, cwd: str, profile: str) -> Path:
    pid = packet_mod.new_id()
    path = _dir(profile) / f"{thread}-{pid}.json"
    path.write_text(json.dumps({"id": pid, "thread": thread, "tool": tool, "command": command, "cwd": cwd, "t": time.time()}))
    return path


def pending(profile: str) -> list[dict]:
    out = []
    for p in sorted(_dir(profile).glob("*.json")):
        try:
            rec = json.loads(p.read_text())
        except json.JSONDecodeError:
            continue
        if "decision" not in rec:
            out.append(rec)
    return out


def record_decision(thread: str, pid: str, decision: str, profile: str) -> Path:
    path = _dir(profile) / f"{thread}-{pid}.json"
    rec = json.loads(path.read_text())
    rec["decision"] = decision; rec["decided_t"] = time.time()
    path.write_text(json.dumps(rec))
    return path


def wait_decision(path: Path, timeout: float, sleep=time.sleep) -> str | None:
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                rec = json.loads(path.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                rec = {}
            if rec.get("decision") in ("allow", "deny"):
                return rec["decision"]
            if time.monotonic() >= deadline:
                return None
            sleep(0.5)
    finally:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
