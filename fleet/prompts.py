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
    (re.compile(r"(^|[\s;&|])git\s+push\b"), "git push"),
    (re.compile(r"(^|[\s;&|])git\s+reset\s+--hard\b"), "git reset --hard"),
    (re.compile(r"(^|[\s;&|])git\s+clean\s+-[a-zA-Z]*f"), "git clean -f"),
    (re.compile(r"(^|[\s;&|])(sudo|ssh|scp|rsync)\b"), "privileged or remote"),
    (re.compile(r"(^|[\s;&|])curl\b[^|;&]*\s-(X\s*(POST|PUT|DELETE|PATCH)|d|F|T|-data|-upload-file)\b"), "curl write/egress"),
    (re.compile(r"(^|[\s;&|])chmod\s+[0-7]*7[0-7]*\b|chmod\s+.*\+x"), "chmod"),
]
PATH_TOKEN = re.compile(r"^(~|/|\./|\.\./)")
DEV_OK = ("/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr")
SEGMENT_RE = re.compile(r"\s*(?:;|&&|\|\||\||&|\n|\$\(|\(|`|\{)\s*")


def _tokens(command: str) -> list[str]:
    try:
        return shlex.split(command, posix=True)
    except ValueError:
        return command.split()


def _is_path_candidate(tok: str) -> bool:
    return bool(PATH_TOKEN.match(tok)) or "/" in tok or ".." in tok


def _resolve(tok: str, root: Path) -> str:
    p = os.path.expanduser(tok)
    return os.path.normpath(p if p.startswith("/") else os.path.join(str(root), p))


def _clean_arg(tok: str) -> str:
    """Strip trailing shell-grouping punctuation left attached to an
    argument by the raw-text segment split (e.g. "(rm -rf state/x)"
    tokenizes its last argument as "state/x)")."""
    return tok.rstrip(")`};")


def _path_ok(tok: str, root: Path) -> bool:
    # strip shell decorations: redirections, option=paths, trailing punctuation
    tok = tok.lstrip("<>=").rstrip(";&|)")
    if "=" in tok and not tok.startswith("/"):
        tok = tok.split("=", 1)[1]
    if not _is_path_candidate(tok):
        return True  # not a path
    p = _resolve(tok, root)
    if p in DEV_OK:
        return True
    inside = (str(root), "/tmp", "/private/tmp")
    return any(p == base or p.startswith(base + "/") for base in inside)


def _rm_flags_and_args(tokens: list[str]) -> tuple[bool, bool, list[str]]:
    has_recursive = False
    has_force = False
    args: list[str] = []
    for tok in tokens:
        if tok == "--recursive":
            has_recursive = True
        elif tok == "--force":
            has_force = True
        elif tok.startswith("-") and tok != "-":
            for ch in tok[1:]:
                if ch in "rR":
                    has_recursive = True
                elif ch in "fF":
                    has_force = True
        else:
            args.append(tok)
    return has_recursive, has_force, args


def _rm_denied(command: str, root: Path) -> str | None:
    """Token-based rm -rf check: deny recursive+force rm unless every
    non-flag argument resolves under <root>/state.

    The raw command is split into shell segments on ;, &&, ||, |, &,
    newline, (, $(, `, and { before tokenizing, so chained invocations
    written without surrounding whitespace (e.g. "echo a;rm -rf x" or
    "true&&rm -rf x") and invocations inside a subshell, command
    substitution, backtick substitution, or brace group (e.g.
    "(rm -rf x)", "$(rm -rf x)", "`rm -rf x`", "{ rm -rf x; }")
    are still detected -- shlex.split alone only isolates those as
    standalone tokens when whitespace surrounds them, and closing
    )/`/} characters are not split points so they land stuck to the
    last argument token (cleaned up via _clean_arg before resolving).
    """
    state_dir = os.path.normpath(str(root / "state"))
    for segment in SEGMENT_RE.split(command):
        segment = segment.strip()
        if not segment:
            continue
        tokens = _tokens(segment)
        if not tokens or tokens[0] != "rm":
            continue
        has_recursive, has_force, args = _rm_flags_and_args(tokens[1:])
        if has_recursive and has_force:
            for a in args:
                p = _resolve(_clean_arg(a), root)
                if not (p == state_dir or p.startswith(state_dir + "/")):
                    return "rm -rf outside state/"
    return None


def decide_auto(command: str, root: Path) -> tuple[str, str]:
    rm_why = _rm_denied(command, root)
    if rm_why:
        return "deny", rm_why
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
        except (FileNotFoundError, json.JSONDecodeError):
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
