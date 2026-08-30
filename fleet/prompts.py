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
    (re.compile(r"(^|[\s;&|])(sudo|ssh|scp)\b"), "privileged or remote"),
    (re.compile(r"(^|[\s;&|])curl\b[^|;&]*\s-(X\s*(POST|PUT|DELETE|PATCH)|d|F|T|-data|-upload-file)\b"), "curl write/egress"),
]
# Not in spec §3's deny list, but not routine either: an operator can look at
# these and say yes. `chmod`/`rsync` used to be hard denials, which left a
# thread no way to make its own script executable or to mirror a directory
# even with the operator watching. The chmod alternation is anchored to a
# command boundary as a whole - unanchored, the `+x` branch matched the word
# anywhere in a command line (e.g. inside an unrelated quoted string).
ESCALATE = [
    (re.compile(r"(^|[\s;&|])rsync\b"), "rsync"),
    (re.compile(r"(^|[\s;&|])chmod\s+(?:[0-7]*7[0-7]*\b|.*\+x)"), "chmod"),
]
PATH_TOKEN = re.compile(r"^(~|/|\./|\.\./)")
DEV_OK = ("/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr")
# Delete-safe zones besides <root>/state. A thread's own scratch files live in
# /tmp (/private/tmp is the same directory on macOS, after symlink
# resolution), so cleaning them up is routine work, not a destructive act.
# Only paths strictly INSIDE these count: `rm -rf /tmp` is everyone's scratch
# space, not just this thread's.
TMP_ZONES = ("/tmp", "/private/tmp")
SEGMENT_RE = re.compile(r"\s*(?:;|&&|\|\||\||&|\n|\$\(|\(|`|\{)\s*")

# Commands that delete. `rm` keeps its own recursive+force rule below; the
# others delete unconditionally, so any path argument is enough.
DELETE_VERBS = frozenset({"rm", "rmdir", "unlink"})
EXEC_PRIMARIES = frozenset({"-exec", "-execdir", "-ok", "-okdir"})
XARGS_OPTS_WITH_ARG = frozenset({"-n", "-I", "-L", "-P", "-s", "-d", "-E", "-a", "-J", "-R", "-S"})


def _xargs_utility(rest: list[str]) -> str:
    """The utility xargs will run: the first operand after its options.

    Only that position is a deletion - `xargs grep -l rm` searches for the
    word, it does not delete anything.
    """
    skip = False
    for t in rest:
        if skip:
            skip = False; continue
        if t.startswith("-"):
            skip = t in XARGS_OPTS_WITH_ARG
            continue
        return t
    return ""
# A token that is the argument of one of these carries a whole program, which
# decide_auto re-runs on itself rather than treating as an opaque string.
CODE_OPTS = frozenset({"-c", "--command", "-e", "--eval"})
CODE_VERBS = frozenset({"eval", "exec", "source", "."})
MAX_WRAP_DEPTH = 3
WS_IN_TOKEN = re.compile(r"\s")
# Deny-class content inside a single quoted argument. A multi-word token is
# NOT a path and never reaches _path_ok, so `sh -c "..."`, `eval "..."` and
# `python3 -c "..."` used to be auto-allowed whole. Recursion (above) catches
# shell payloads; this catches payloads whose language is not shell - a
# recursive decide_auto on `import shutil; shutil.rmtree('/x')` sees only
# harmless-looking tokens.
QUOTED_DENY_RE = re.compile(
    r"\b(rm|rmdir|unlink|xargs|sudo|ssh|scp|rsync|curl|chmod)\b"
    r"|shutil\.rmtree|\.rmtree\s*\(|\bunlink\s*\(|\bglob\s*\("
    r"|os\.(remove|unlink|rmdir|removedirs)"
    r"|\.unlink\s*\("
    r"|\bgit\s+(push|reset|clean)\b"
    r"|\bfind\b.*-delete\b",
    re.IGNORECASE,
)


def _tokens(command: str) -> list[str]:
    try:
        return shlex.split(command, posix=True)
    except ValueError:
        return command.split()


def _is_path_candidate(tok: str) -> bool:
    if tok == "/":
        return False  # a bare slash is division/a separator in wrapped code, not a path
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
    operands = set(_plain_args(tokens))  # redirections and their targets are not operands
    for tok in tokens:
        if tok not in operands and not tok.startswith("-"):
            continue
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


def _delete_safe(p: str, root: Path) -> bool:
    """Is this resolved path in a zone a thread may delete unattended?

    <root>/state (its own bookkeeping), the DEV_OK devices, and anything
    strictly inside /tmp or /private/tmp (its own scratch files).
    """
    if p in DEV_OK:
        return True
    state_dir = os.path.normpath(str(root / "state"))
    if p == state_dir or p.startswith(state_dir + "/"):
        return True
    return any(p.startswith(z + "/") for z in TMP_ZONES)


def _all_args_in_state(args: list[str], root: Path) -> bool:
    """Every argument must land in a delete-safe zone (see _delete_safe) in
    BOTH its raw form and its _clean_arg form. The cleaned form exists only to
    tolerate a closing delimiter left attached by the raw-text segment split;
    a literal filename that really ends in )/`/}/; must not benefit from that
    stripping."""
    for a in args:
        for cand in (a, _clean_arg(a)):
            if not _delete_safe(_resolve(cand, root), root):
                return False
    return True


REDIRECT_RE = re.compile(r"^(\d*[<>]+&?\d*|&>)")


def _plain_args(tokens: list[str]) -> list[str]:
    """Operands only: no option flags, no shell redirections (`2>/dev/null`,
    `>x`, `2>&1`, `< list`) and no redirection *targets* when the operator
    token stood alone (`2> /dev/null`)."""
    out, skip = [], False
    for t in tokens:
        if skip:
            skip = False; continue
        if REDIRECT_RE.match(t):
            skip = REDIRECT_RE.fullmatch(t) is not None  # bare operator: target is next token
            continue
        if t == "-" or not t.startswith("-"):
            out.append(t)
    return out


def _delete_denied(command: str, root: Path) -> str | None:
    """Token-based check on the whole delete family: deny recursive+force rm,
    rmdir, unlink, `find ... -delete`/`-exec rm`, and `xargs rm` unless every
    path argument resolves under <root>/state.

    The raw command is split into shell segments on ;, &&, ||, |, &,
    newline, (, $(, `, and { before tokenizing, so chained invocations
    written without surrounding whitespace (e.g. "echo a;rm -rf x" or
    "true&&rm -rf x") and invocations inside a subshell, command
    substitution, backtick substitution, or brace group (e.g.
    "(rm -rf x)", "$(rm -rf x)", "`rm -rf x`", "{ rm -rf x; }")
    are still detected -- shlex.split alone only isolates those as
    standalone tokens when whitespace surrounds them, and closing
    )/`/} characters are not split points so they land stuck to the
    last argument token. Such an argument is accepted only if BOTH its
    raw form and its _clean_arg form resolve under <root>/state, so a
    quoted literal path that really ends in ) or } (e.g. rm -rf "state)")
    is denied rather than being truncated into an in-state path.
    """
    for segment in SEGMENT_RE.split(command):
        segment = segment.strip()
        if not segment:
            continue
        tokens = _tokens(segment)
        if not tokens:
            continue
        verb, rest = tokens[0], tokens[1:]
        if verb == "rm":
            has_recursive, has_force, args = _rm_flags_and_args(rest)
            # A non-recursive rm of one in-repo file is routine work
            # (`rm -f state/gui-token`); only recursive+force is destructive.
            if has_recursive and has_force and not _all_args_in_state(args, root):
                return "rm -rf outside state/ and /tmp"
        elif verb in ("rmdir", "unlink"):
            if not _all_args_in_state(_plain_args(rest), root):
                return f"{verb} outside state/ and /tmp"
        elif verb == "find":
            deletes = "-delete" in rest or any(
                t in EXEC_PRIMARIES and i + 1 < len(rest) and _clean_arg(rest[i + 1]) in DELETE_VERBS
                for i, t in enumerate(rest)
            )
            if deletes:
                # find's paths are its leading operands, before the first
                # -primary. With none given it walks "." - the thread's own
                # cwd, which is not necessarily under state/.
                args = []
                for t in rest:
                    if t.startswith("-"):
                        break
                    args.append(t)
                if not _all_args_in_state(args or ["."], root):
                    return "find -delete outside state/ and /tmp"
        elif verb == "xargs":
            # Denied outright when the utility deletes: xargs' operands arrive
            # on stdin, so there is no path argument to check against state/
            # (`xargs rm -rf < list` names nothing dangerous inline).
            if _clean_arg(_xargs_utility(rest)) in DELETE_VERBS:
                return "xargs delete (paths come from stdin; unverifiable)"
    return None


def _wrapped_verdict(command: str, root: Path, depth: int) -> tuple[str, str] | None:
    """Judge every multi-word token, i.e. every quoted argument.

    Such a token is not a path, so _path_ok waves it through, and the DENY
    regexes are written against shell text - which is how a whole program
    handed over as one argument (`sh -c "rm -rf /Users/pup"`, `eval "..."`,
    `python3 -c "..."`) was auto-allowed with "resolves inside the repo".

    Two rules, both narrow enough to leave the recorded fixture lines (which
    contain quoted multi-word args like `echo "===== $f ====="` and
    `python3 -c "from fleet import status; ..."`) auto-allowed:

    1. If the token is the argument of -c/--command/-e/--eval or of
       eval/exec/source/., it IS a command line: re-run decide_auto on it and
       propagate anything other than allow-auto.
    2. Otherwise (or if the recursion cleared it), escalate when the token
       carries deny-class content. Escalate rather than deny: the operator can
       still look at it, and a quoted string is too ambiguous to refuse
       outright.
    """
    tokens = _tokens(command)
    for i, tok in enumerate(tokens):
        prev = tokens[i - 1] if i else ""
        is_code = prev in CODE_OPTS or prev in CODE_VERBS
        # A code payload is judged whatever its shape: a space-free one-liner
        # (`perl -e "unlink(glob('/x'))"`) is as executable as a spaced one.
        if not is_code and not WS_IN_TOKEN.search(tok):
            continue
        if is_code and depth < MAX_WRAP_DEPTH:
            d, why = decide_auto(tok, root, _depth=depth + 1)
            if d != "allow-auto":
                return d, f"wrapped code ({prev}): {why}"
        m = QUOTED_DENY_RE.search(tok)
        if m:
            return "escalate", f"quoted argument contains {m.group(0)!r}"
    return None


def decide_auto(command: str, root: Path, _depth: int = 0) -> tuple[str, str]:
    delete_why = _delete_denied(command, root)
    if delete_why:
        return "deny", delete_why
    for rx, why in DENY:
        if rx.search(command):
            return "deny", why
    for rx, why in ESCALATE:
        if rx.search(command):
            return "escalate", why
    wrapped = _wrapped_verdict(command, root, _depth)
    if wrapped:
        return wrapped
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
    """Stamp the decision onto the prompt file atomically.

    wait_decision polls this file from another process. A plain write_text
    truncates first, so that poll could read an empty (or half-written) file
    exactly when the answer arrives - json.JSONDecodeError, treated as "still
    undecided", and on a tight deadline that is a lost `allow`. Write a
    sibling .tmp and os.replace it in, the same trick registry.save uses.
    """
    path = _dir(profile) / f"{thread}-{pid}.json"
    rec = json.loads(path.read_text())
    rec["decision"] = decision; rec["decided_t"] = time.time()
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(rec))
    os.replace(tmp, path)
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
