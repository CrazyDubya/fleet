"""How the shell will read a command, as far as a gate that runs first can tell.

The gate used to judge a path as it is SPELLED. The shell opens it as it is
EXPANDED, and the gap was a live bypass: `cat $HOME/.aws/credentials` resolved
to <root>/$HOME/.aws/credentials - in-repo, allow-auto - while zsh read the
real file (Fable audit, 2026-09-12). Braces (`~/{.ssh,x}/id_rsa`), globs
(`.en?`, zsh `*(D)`), ANSI-C quoting (`$'\\x2f'`) and a bare `cd` were the same
bug. So this module does the expansions a static reader can do, and names the
ones it cannot - a variable set by `read` or `$(...)`, a substitution's output
- instead of guessing at them.

It is deliberately not a shell parser. It answers three questions for
fleet.prompts, each conservatively: what words a command has (with the quoting
facts that decide which expansions apply), what the substitutions and heredocs
inside it run, and what paths a word can expand to.
"""
import codecs
import glob
import dataclasses
import itertools
import os
import queue
import re
import threading
import time
from dataclasses import dataclass, field

MAX_EXPANSIONS = 64
MAX_VALUES = 1024       # a directory listing's worth of candidate values
MAX_GLOB_MATCHES = 256
GLOB_BUDGET_S = 0.5

GLOB_CHARS = re.compile(r"[*?\[]")
# zsh glob qualifier, e.g. `*(D)` - D alone turns on dotfile matching. The ")"
# may already have been stripped as trailing punctuation by the caller.
ZSH_QUALIFIER_RE = re.compile(r"\([^()/]*\)?$")
BRACE_RE = re.compile(r"\{([^{}]*)\}")
BRACE_RANGE_RE = re.compile(r"(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])")
ASSIGN_RE = re.compile(r"^([A-Za-z_]\w*)(\+?)=(.*)$", re.S)
NAME_RE = re.compile(r"^[A-Za-z_]\w*$")

# A substitution scan() has lifted out of the text; its body is in Scope.subs.
PLACEHOLDER = "\x00{}\x00"
_ids = itertools.count()
VAR_RE = re.compile(
    r"\x00(?P<ph>\d+)\x00"
    r"|\$\(\((?P<arith>[^()]*)\)\)"
    r"|\$\{(?P<braced>[A-Za-z_]\w*)\}"
    r"|\$\{(?P<dname>[A-Za-z_]\w*):?-(?P<default>[^}]*)\}"
    r"|\$\{(?P<number>#[^}]*|(?:PIPESTATUS|pipestatus)\[\d*\])\}"
    r"|\$\{(?P<tname>[A-Za-z_]\w*)(?P<trim>##?|%%?)(?P<pat>[^}]*)\}"
    r"|\$\{(?P<complex>[^}]*)\}?"
    r"|\$(?P<name>[A-Za-z_]\w*)"
    r"|\$(?P<special>[?#$!\-0-9@*])"
    r"|\$(?P<subst>\()"
)
# A substitution whose output is a number or a date cannot name a file. Short
# on purpose, and every argument is checked too: `date +.ssh` prints ".ssh".
NON_PATH_OUTPUT = frozenset({"date", "wc", "id", "whoami", "hostname", "uname", "nproc",
                             "uuidgen", "true", "false"})
NON_PATH_ARG_RE = re.compile(r"[./~$\\`\x00*?\[{]")
# Words after which the next word is a command, not an argument.
KEYWORDS = frozenset({"do", "then", "else", "elif", "if", "while", "until", "!", "{", "(",
                      "time", "&&", "||", "|", ";", "&", ";;", "|&"})
DECLARE_VERBS = frozenset({"export", "local", "declare", "typeset", "readonly"})
SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh"})
INTERPRETERS = frozenset({"python", "python3", "node", "ruby", "perl", "php", "deno", "bun",
                          "osascript", "swift"})


@dataclass
class Word:
    text: str                  # after quote removal, as shlex.split gives it
    raw: str = ""              # as written
    expands: bool = True       # an unquoted * ? [ or {: brace and glob expansion apply
    bare_var: bool = True      # an unquoted $: its value is split and globbed too
    literal: bool = False      # nothing expands at all (a quoted-heredoc payload)
    live_dollar: bool = True   # a $ or ` outside single quotes: parameter expansion applies
    nl_before: bool = False
    starts_command: bool = False


def split(command: str) -> list[Word] | None:
    """Words exactly as shlex.split(posix=True) splits them, plus quoting facts.

    Same splitting on purpose: fleet.prompts indexes roles, bases and inert
    scope by shlex position, and these words ride alongside. Returns None where
    shlex would raise (unbalanced quote, trailing backslash), so the caller
    falls back exactly as it did before. The one deliberate difference in text:
    $'...' is decoded, because `$'\\x2fUsers\\x2fpup\\x2f.ssh'` is a slashed
    path to the shell and a slash-free word to shlex.
    """
    words: list[Word] = []
    n = len(command)
    i = 0
    nl = True
    while i < n:
        c = command[i]
        if c in " \t\r\n":
            nl = nl or c == "\n"
            i += 1
            continue
        start, buf = i, []
        expands = bare = live = False
        quote = None
        while i < n:
            c = command[i]
            if quote == "'":
                if c == "'":
                    quote = None
                else:
                    buf.append(c)
                i += 1
                continue
            if quote == '"':
                if c == '"':
                    quote = None
                elif c == "\\" and i + 1 < n and command[i + 1] in '"\\':
                    buf.append(command[i + 1]); i += 1
                else:
                    live = live or c in "$`\x00"
                    buf.append(c)
                i += 1
                continue
            if c in " \t\r\n":
                break
            if c == "\\":
                if i + 1 >= n:
                    return None
                buf.append(command[i + 1]); i += 2
                continue
            if c == "$" and command.startswith("$'", i):
                j = i + 2
                while j < n and command[j] != "'":
                    j += 2 if command[j] == "\\" else 1
                if j >= n:
                    return None
                body = command[i + 2:j]
                try:
                    buf.append(codecs.decode(body, "unicode_escape"))
                except (UnicodeDecodeError, ValueError):
                    buf.append(body)
                i = j + 1
                continue
            if c in "'\"":
                quote = c
            else:
                expands = expands or c in "*?[{"
                bare = bare or c in "$\x00"
                live = live or c in "$`\x00"
                buf.append(c)
            i += 1
        if quote:
            return None
        words.append(Word("".join(buf), command[start:i], expands, bare, live_dollar=live, nl_before=nl))
        nl = False
    _mark_command_starts(words)
    return words


def _mark_command_starts(words: list[Word]) -> None:
    start = True
    for w in words:
        start = start or w.nl_before
        w.starts_command = start and w.raw not in KEYWORDS - {"!", "{", "(", "time"}
        bare = w.raw.lstrip("({")
        if w.raw in KEYWORDS:
            start = True
        elif start and ASSIGN_RE.match(bare):
            start = True            # an assignment prefix; a command may follow
        elif w.raw.endswith((";", "&", "|")) and not w.raw.endswith(("\\;", "'", '"')):
            start = True
        else:
            start = False


@dataclass
class Scope:
    """What the command itself binds, by word index: `S=/x`, `export S=/x`,
    `for f in a b`, `f=$(ls -t dir | head -1)`, and - as unknowable - `read f`.

    Bindings are evaluated when asked for, not when found, so a value that
    depends on the directory a substitution lists is computed once, and a
    binding that refers to itself (`X=$X/a` in a loop) resolves as unknowable
    rather than recursing.
    """
    words: list[Word] = field(default_factory=list)
    depth: int = 0
    outer: dict[str, list[str] | None] = field(default_factory=dict)
    # (index, name, how, what): how is "value" (raw text), "items" (for-loop
    # words) or "unknown"
    binds: list[tuple[int, str, str, object]] = field(default_factory=list)
    subs: dict[str, tuple[str, str]] = field(default_factory=dict)  # id -> (kind, body)
    base: str = "."
    _memo: dict = field(default_factory=dict)
    _busy: set = field(default_factory=set)

    def _bound(self, k: int) -> list[str] | None:
        if k in self._memo:
            return self._memo[k]
        if k in self._busy:
            return None
        self._busy.add(k)
        i, _, how, what = self.binds[k]
        vals: list[str] | None
        if how == "value":
            got, unresolved = expand_vars(str(what), self, i)
            vals = None if unresolved else got
        elif how == "items":
            vals = []
            for j, item in what:
                got, unresolved = expand(item, self, j, self.base, split_words=True)
                if unresolved:
                    vals = None
                    break
                vals += got
        else:
            vals = None
        self._busy.discard(k)
        self._memo[k] = vals
        return vals

    def values(self, name: str, at: int) -> list[str] | None:
        """Every value `name` can hold at word `at`, or None when one of them
        is unknowable. Assignments before `at` win over the environment; ones
        after it still count, because a loop can run them first."""
        ks = [k for k, (i, n, _, _) in enumerate(self.binds) if n == name]
        before = [k for k in ks if self.binds[k][0] < at]
        vals: list[str] = []
        if not before:
            if name in self.outer:
                if self.outer[name] is None:
                    return None
                vals += self.outer[name]
            elif name in os.environ:
                vals.append(os.environ[name])
            elif len(ks) == 0:
                return None
        elif name in os.environ:
            vals.append(os.environ[name])      # a conditional assignment may not run
        for k in ks:
            got = self._bound(k)
            if got is None:
                return None
            vals += got
        return list(dict.fromkeys(vals)) or None

    def flat(self) -> dict[str, list[str] | None]:
        """Everything bound anywhere, index-free: the scope a substitution or a
        wrapped payload inherits."""
        out = dict(self.outer)
        for k, (_, n, _, _) in enumerate(self.binds):
            v = self._bound(k)
            if v is None or out.get(n, []) is None:
                out[n] = None
            else:
                out[n] = list(dict.fromkeys(out.get(n, []) + v))
        return out


def scope(words: list[Word], depth: int = 0, outer: dict | None = None, base: str = ".",
          subs: dict | None = None) -> Scope:
    s = Scope(words, depth, dict(outer or {}), subs=dict(subs or {}), base=base)
    i = 0
    while i < len(words):
        w = words[i]
        if not w.starts_command:
            i += 1
            continue
        head = w.text.lstrip("({")
        verb = os.path.basename(head)
        m = ASSIGN_RE.match(head)
        if m:
            s.binds.append((i, m.group(1), "unknown" if m.group(2) else "value", m.group(3).rstrip(";")))
        elif verb in DECLARE_VERBS:
            j = i + 1
            while j < len(words) and not words[j].starts_command and not words[j].nl_before:
                a = ASSIGN_RE.match(words[j].text.rstrip(";"))
                if a:
                    s.binds.append((j, a.group(1), "unknown" if a.group(2) else "value", a.group(3)))
                j += 1
        elif verb in ("read", "mapfile", "readarray", "getopts"):
            j = i + 1
            while j < len(words) and not words[j].nl_before:
                t = words[j].text.rstrip(";")
                if NAME_RE.match(t):
                    s.binds.append((j, t, "unknown", None))
                if words[j].raw.endswith(";") or words[j].raw in KEYWORDS:
                    break
                j += 1
        elif verb in ("for", "select") and i + 1 < len(words):
            name = words[i + 1].text.rstrip(";")
            items: list[tuple[int, Word]] = []
            how = "items"
            j = i + 2
            if j < len(words) and words[j].text == "in":
                j += 1
                while j < len(words) and words[j].text not in ("do", ";") and not words[j].nl_before:
                    t = words[j].text
                    end = t.endswith(";")
                    items.append((j, dataclasses.replace(words[j], text=t[:-1] if end else t)))
                    j += 1
                    if end:
                        break
            else:
                how = "unknown"                # `for x; do` iterates "$@"
            if NAME_RE.match(name):
                s.binds.append((i + 1, name, how, items))
        i += 1
    return s


# Filters whose output lines are a subset of their input lines.
SUBSET_FILTERS = frozenset({"head", "tail", "grep", "egrep", "fgrep", "sort", "uniq", "cat"})
MAX_LISTING = 256


def _substitution_values(kind: str, body: str, s: "Scope", at: int) -> list[str] | None:
    """What a substitution can PRINT, when that can be known without running
    it - which is what ends up inside the path. None when it cannot. The body
    itself is judged as a command elsewhere; this is only about its output.

    Evaluated, not guessed, for the fleet's own idioms: `ls DIR | head -1` is
    one of DIR's entries, so the gate lists DIR (read-only, capped) and judges
    every entry. `ls -a`/`-R`/`-l` and anything it cannot list stay unknowable.
    """
    if kind in ("<(", ">("):
        return ["/dev/stdin"]                        # a pipe the shell names /dev/fd/N
    base = s.base
    if "`" in body or "\x00" in body or re.search(r"\$\(|[<>]\(|<<", body):
        return None                                  # nested: judged, but not evaluated
    words = split(body)
    if words is None:
        return None
    alts: list[list[list[Word]]] = [[[]]]
    for w in words:
        if w.raw in ("||", "&&", ";") or w.nl_before and alts[-1][-1]:
            alts.append([[]])
            if w.raw in ("||", "&&", ";"):
                continue
        if w.raw == "|":
            alts[-1].append([])
            continue
        if re.search(r"[|;&]", re.sub(r"'[^']*'|\"[^\"]*\"", "", w.raw)):
            return None                              # an operator glued to a word
        if not REDIRECT_RE.match(w.raw):
            alts[-1][-1].append(w)
    out: list[str] = []
    for cmds in alts:
        if not cmds or not cmds[0]:
            continue
        first, last = cmds[0], cmds[-1]
        verb, args = os.path.basename(first[0].text), first[1:]
        tail_ok = all(c and os.path.basename(c[0].text) in SUBSET_FILTERS for c in cmds[1:])
        if last and os.path.basename(last[0].text) in NON_PATH_OUTPUT:
            if any(NON_PATH_ARG_RE.search(a.raw) for a in last[1:]):
                return None
            out.append("0")
        elif verb == "ls" and tail_ok:
            listed = _ls_output([a.text for a in args], base, s, at, [a for a in args])
            if listed is None:
                return None
            out += listed
        elif verb == "mktemp" and len(cmds) == 1 and [a for a in args if not a.text.startswith("-")]:
            # mktemp [-d] TEMPLATE creates beside its template: the path is the
            # template's directory, which is what gets judged.
            tmpl = [a for a in args if not a.text.startswith("-")][-1]
            got, unresolved = expand_vars(tmpl.text, s, at) if tmpl.live_dollar else ([tmpl.text], [])
            if unresolved:
                return None
            out += [os.path.join(os.path.dirname(g) or ".", "mktemp") for g in got]
        elif any(a.live_dollar and VAR_RE.search(a.text) for c in cmds for a in c):
            return None                              # only ls and mktemp operands are expanded
        elif verb == "echo" and len(cmds) == 1:
            if any(NON_PATH_ARG_RE.search(a.raw) for a in args):
                return None
            out.append(" ".join(a.text for a in args))
        elif verb == "mktemp" and len(cmds) == 1:
            out.append("/tmp/mktemp")                # a fresh scratch path (see below)
        elif verb == "pwd" and len(cmds) == 1:
            out.append(base)
        elif verb == "git" and [a.text for a in args[:2]] == ["rev-parse", "--show-toplevel"] \
                and len(cmds) == 1:
            top = _git_toplevel(base)
            if top is None:
                return None
            out.append(top)
        else:
            return None
    return list(dict.fromkeys(out)) or [""]


REDIRECT_RE = re.compile(r"^\d*[<>]")


def _git_toplevel(base: str) -> str | None:
    d = os.path.abspath(base)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def _ls_output(args: list[str], base: str, s: "Scope", at: int,
               words: list[Word] | None = None) -> list[str] | None:
    opts = "".join(a[1:] for a in args if a.startswith("-") and not a.startswith("--"))
    if set(opts) & set("aAlRLnogfF") or any(a.startswith("--") for a in args):
        return None                                  # dotfiles, recursion or long lines
    operands: list[str] = []
    for a in args:
        if a.startswith("-"):
            continue
        got, unresolved = expand_vars(a, s, at) if VAR_RE.search(a) else ([a], [])
        if words is not None and not any(w.text == a and w.live_dollar for w in words):
            got, unresolved = [a], []
        if unresolved or len(got) > MAX_EXPANSIONS:
            return None
        operands += got
    operands = operands or ["."]
    out: list[str] = []
    for op in operands:
        if VAR_RE.search(op) or BRACE_RE.search(op):
            return None
        p = os.path.expanduser(op)
        p = os.path.normpath(p if p.startswith("/") else os.path.join(base, p))
        paths = [p]
        if GLOB_CHARS.search(op):
            paths, complete = glob_matches(p)
            if not complete:
                return None
            # the shell prints a glob's matches as spelled, relative or not
            out += [op.rsplit("/", 1)[0] + "/" + os.path.basename(m) if "/" in op else os.path.basename(m)
                    for m in paths]
            out += paths
        for q in paths:
            if "d" in opts or not os.path.isdir(q):
                out.append(op if not GLOB_CHARS.search(op) else q)
                continue
            try:
                names = [e for e in os.listdir(q) if not e.startswith(".")]
            except OSError:
                return None
            if len(names) > MAX_LISTING:
                return None
            out += names
    return out


def expand_vars(text: str, s: Scope | None, at: int = 0) -> tuple[list[str], list[str]]:
    """Every string `text` can become after parameter expansion, and what could
    not be expanded (left as spelled in the results)."""
    s = s or Scope()
    outs = [""]
    unresolved: list[str] = []
    pos = 0
    for m in VAR_RE.finditer(text):
        lit = text[pos:m.start()]
        pos = m.end()
        g = m.groupdict()
        name = g["braced"] or g["name"]
        if g["ph"] is not None:
            kind, body = s.subs.get(g["ph"], ("$(", ""))
            got = _substitution_values(kind, body, s, at)
            if got is None:
                unresolved.append("$(...)"); vals = [m.group(0)]
            else:
                vals = got
        elif g["number"] is not None:
            vals = ["0"]
        elif g["tname"]:
            got = s.values(g["tname"], at)
            pat = g["pat"]
            if got is None or VAR_RE.search(pat) or GLOB_CHARS.search(pat):
                unresolved.append(m.group(0)); vals = [m.group(0)]
            elif g["trim"].startswith("#"):
                vals = [v[len(pat):] if v.startswith(pat) else v for v in got]
            else:
                vals = [v[:-len(pat)] if pat and v.endswith(pat) else v for v in got]
        elif g["arith"] is not None:
            if "$(" in g["arith"] or "`" in g["arith"]:
                unresolved.append(m.group(0)); vals = [m.group(0)]
            else:
                vals = ["0"]                   # a number: no slash, no dot, no glob
        elif name == "_":
            unresolved.append("$_"); vals = [m.group(0)]
        elif name:
            got = s.values(name, at)
            if got is None:
                unresolved.append(f"${name}"); vals = [m.group(0)]
            else:
                vals = got
        elif g["dname"]:
            got = s.values(g["dname"], at)
            dflt, more = expand_vars(g["default"], s, at)
            unresolved += more
            vals = (got or []) + dflt
        elif g["special"]:
            sp = g["special"]
            if sp in "?#$!":
                vals = ["0"]
            elif sp == "-":
                vals = ["hB"]
            elif s.depth == 0 and sp in "123456789@*":
                vals = [""]                    # the Bash tool's shell has no arguments
            elif sp == "0":
                vals = ["zsh"]
            else:
                unresolved.append(m.group(0)); vals = [m.group(0)]
        else:                                  # ${complex}, $(
            unresolved.append("$(...)" if g["subst"] else m.group(0))
            vals = [m.group(0)]
        outs = [o + lit + v for o in outs for v in vals][:MAX_VALUES + 1]
    outs = [o + text[pos:] for o in outs]
    if "`" in text:
        unresolved.append("`...`")
    if len(outs) > MAX_VALUES:
        unresolved.append("more variable values than can be enumerated")
        outs = outs[:MAX_VALUES]
    return outs, unresolved


def expand_braces(s: str) -> list[str] | None:
    """{a,b} and {1..3}, innermost first. None when there are too many."""
    done: list[str] = []
    todo = [s]
    while todo:
        cur = todo.pop()
        for m in BRACE_RE.finditer(cur):
            body, alts = m.group(1), None
            if "," in body:
                alts = body.split(",")
            elif r := BRACE_RANGE_RE.fullmatch(body):
                a, b = r.groups()
                if a.lstrip("-").isdigit() and b.lstrip("-").isdigit():
                    lo, hi = int(a), int(b)
                    if abs(hi - lo) >= MAX_EXPANSIONS:
                        return None
                    step = 1 if hi >= lo else -1
                    alts = [str(k) for k in range(lo, hi + step, step)]
                elif a.isalpha() and b.isalpha():
                    step = 1 if b >= a else -1
                    alts = [chr(k) for k in range(ord(a), ord(b) + step, step)]
            if alts is not None:
                todo.extend(cur[:m.start()] + alt + cur[m.end():] for alt in alts)
                break
        else:
            done.append(cur)
        if len(done) + len(todo) > MAX_EXPANSIONS:
            return None
    return done


def glob_matches(pattern: str) -> tuple[list[str], bool]:
    """What an absolute glob matches on disk, dotfiles included - a superset of
    bash's and zsh's defaults and of zsh's (D) qualifier, which is the point.
    (matches, complete): incomplete when the cap or the time budget ran out."""
    pat = ZSH_QUALIFIER_RE.sub("", pattern)
    if not GLOB_CHARS.search(pat):
        return ([pat] if pat != pattern else []), True
    # The walk runs on a daemon thread against a deadline: iglob can spend
    # unbounded time between two matches (`~/**/x`), and the hook calling this
    # has about three seconds in total. Budget is shared by one decision.
    remaining = min(GLOB_BUDGET_S, _budget_deadline[0] - time.monotonic())
    if remaining <= 0:
        return [], False
    q: queue.Queue = queue.Queue()
    stop = threading.Event()
    end = object()

    def walk() -> None:
        try:
            for m in glob.iglob(pat, recursive=True, include_hidden=True):
                if stop.is_set():
                    return
                q.put(m)
        finally:
            q.put(end)

    threading.Thread(target=walk, daemon=True).start()
    out: list[str] = []
    deadline = time.monotonic() + remaining
    try:
        while True:
            try:
                m = q.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                return out, False
            if m is end:
                return out, True
            out.append(os.path.normpath(m))
            if len(out) > MAX_GLOB_MATCHES:
                return out, False
    finally:
        stop.set()


GLOB_DECISION_BUDGET_S = 1.5
_budget_deadline = [time.monotonic() + GLOB_DECISION_BUDGET_S]


def begin_decision() -> None:
    """Start the glob time budget for one top-level gate decision."""
    _budget_deadline[0] = time.monotonic() + GLOB_DECISION_BUDGET_S


def glob_truncation_safe(pattern: str) -> bool:
    """Can the matches past the cap be left unjudged? Only when no unjudged
    match could be a credential: no component that can match a dotfile (the
    shell's `*` does not, without (D) or a leading dot), and a fixed prefix that
    does not contain the home directory, where Library/Keychains sits under a
    plain `*/Keychains`. Judged on the pattern, never on the matches."""
    if ZSH_QUALIFIER_RE.search(pattern) or "**" in pattern:
        return False
    parts = pattern.split("/")
    fixed = []
    for part in parts:
        if GLOB_CHARS.search(part):
            break
        fixed.append(part)
    glob_parts = parts[len(fixed):]
    if any(part.startswith((".", "[", "?")) for part in glob_parts):
        return False
    prefix = "/".join(fixed) or "/"
    home = os.path.expanduser("~")
    return not (home == prefix or home.startswith(prefix.rstrip("/") + "/"))


def expand(word: Word, s: Scope | None, at: int, base: str,
           split_words: bool = False) -> tuple[list[str], list[str]]:
    """Every string `word` can expand to - relative ones left relative, globs
    matched from `base` - and what could not be expanded. The spelling after
    parameter expansion is always among the results, so a verdict the spelling
    alone earns is never lost to an unexpandable part."""
    if word.literal:
        return [word.text], []
    if word.live_dollar and ("$" in word.text or "`" in word.text or "\x00" in word.text):
        texts, unresolved = expand_vars(word.text, s, at)
    else:
        texts, unresolved = [word.text], []
    if word.bare_var and "$" in word.text:
        # Unquoted, a value is split on whitespace: X="a /etc/passwd"; cat $X
        texts = list(dict.fromkeys(texts + [p for t in texts for p in t.split() if p != t]))
    out: list[str] = []
    for t in texts:
        alts = expand_braces(t) if word.expands or word.bare_var else [t]
        if alts is None:
            unresolved.append("a brace expansion too large to enumerate")
            alts = [t]
        for a in alts:
            out.append(a)
            if (word.expands or word.bare_var) and (GLOB_CHARS.search(a) or ZSH_QUALIFIER_RE.search(a)):
                p = os.path.expanduser(a)
                p = os.path.normpath(p if p.startswith("/") else os.path.join(base, p))
                matches, complete = glob_matches(p)
                out.extend(matches)
                if not complete and not glob_truncation_safe(p):
                    unresolved.append("a glob too large to expand")
    if split_words:
        out = [o for o in out if o]
    return list(dict.fromkeys(out)), list(dict.fromkeys(unresolved))


def words_for(tokens: list[str]) -> list[Word]:
    """Words for tokens that did not come from split() - the fallback when a
    command does not tokenize. Nothing is known about quoting, so everything
    is assumed to expand."""
    words = [Word(t, t) for t in tokens]
    _mark_command_starts(words)
    return words


# --- substitutions and heredocs -------------------------------------------

@dataclass
class Scan:
    text: str                                        # heredoc contents cut out
    bodies: list[str] = field(default_factory=list)  # commands $( ) ` ` <( ) >( ) run
    payloads: list[tuple[str, str, bool]] = field(default_factory=list)  # (verb, contents, quoted)
    pipe_verb: str = ""                              # an interpreter the command pipes into
    subs: dict[str, tuple[str, str]] = field(default_factory=dict)  # placeholder id -> (kind, body)


def scan(command: str) -> Scan:
    """The command with heredoc contents removed, the substitutions it runs, and
    heredocs fed to an interpreter.

    A heredoc's contents are data - judging a commit message as a command
    escalated on its Claude-Session URL - unless an interpreter reads them, in
    which case they are code and come back as a payload. An unquoted heredoc
    still runs the substitutions inside it; those come back as bodies.
    """
    res = Scan("")
    piped = PIPED_INTO_RE.search(command)
    res.pipe_verb = os.path.basename(piped.group(1)) if piped else ""
    _, res.text = _scan(command, 0, None, res, lift=True)
    return res


# `cat <<EOF | bash`: the heredoc's own verb is cat, its reader is bash.
PIPED_INTO_RE = re.compile(r"\|\s*((?:\S*/)?(?:sh|bash|zsh|dash|ksh|python3?|node|perl|ruby))\b")


def _is_reader(verb: str) -> bool:
    return verb in SHELLS or verb in INTERPRETERS or bool(re.match(r"python3?(\.\d+)?$", verb))


def _heredoc_at(text: str, i: int) -> tuple[int, str, bool, bool] | None:
    k = i + 2
    if text.startswith("<", k):
        return None                                   # <<< here-string
    strip = text.startswith("-", k)
    k += strip
    while k < len(text) and text[k] in " \t":
        k += 1
    m = re.match(r"""(['"])(.*?)\1|([^\s;&|()<>]+)""", text[k:])
    if not m:
        return None
    if m.group(1):
        return k + m.end(), m.group(2), strip, True
    word = m.group(3)
    return k + m.end(), word.replace("\\", "").replace("'", "").replace('"', ""), strip, \
        any(q in word for q in "\\'\"")


def _segment_verb(done: str) -> str:
    seg = re.split(r"[;&|\n(]", done)[-1].split()
    while seg and ASSIGN_RE.match(seg[0]):
        seg = seg[1:]
    return os.path.basename(seg[0]) if seg else ""


def _scan(text: str, i: int, closer: str | None, res: Scan, quotes: bool = True,
          lift: bool = False) -> tuple[int, str]:
    n = len(text)
    out: list[str] = []
    sq = dq = False
    depth = 0
    heredocs: list[tuple[str, bool, bool, str]] = []
    while i < n:
        c = text[i]
        if sq:
            out.append(c); i += 1
            sq = c != "'"
            continue
        if c == "\\":
            out.append(text[i:i + 2]); i += 2
            continue
        if closer == "`" and c == "`":
            return i + 1, "".join(out)
        if quotes and c == "'" and not dq:
            sq = True; out.append(c); i += 1
            continue
        if quotes and c == '"':
            dq = not dq; out.append(c); i += 1
            continue
        if (text.startswith(("$(", "<(", ">("), i) and (c == "$" or (quotes and not dq))
                and not text.startswith("$((", i)) or c == "`":
            # The body is kept as written - its own heredocs and substitutions
            # are found when it is judged in turn - and at the top level the
            # substitution is lifted out of the text for a placeholder, so the
            # words around it split the way the shell splits them rather than
            # at every space inside `$(ls -t dir | head -1)`.
            kind, skip = (c + "(", 2) if c != "`" else ("`", 1)
            j, _ = _scan(text, i + skip, ")" if c != "`" else "`", Scan(""))
            body = text[i + skip:j - 1] if j <= n and text[j - 1:j] == (")" if c != "`" else "`") \
                else text[i + skip:j]
            res.bodies.append(body)
            if lift:
                sid = str(next(_ids))
                res.subs[sid] = (kind, body)
                out.append(PLACEHOLDER.format(sid))
            else:
                out.append(text[i:j])
            i = j
            continue
        if dq or not quotes:
            out.append(c); i += 1
            continue
        if c == "#" and (i == 0 or text[i - 1] in " \t\n;&|("):
            eol = text.find("\n", i)
            i = n if eol < 0 else eol
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            if closer == ")" and depth == 0:
                return i + 1, "".join(out)
            depth -= 1
        elif c == "<" and text.startswith("<<", i):
            h = _heredoc_at(text, i)
            if h:
                end, delim, strip, quoted = h
                heredocs.append((delim, strip, quoted, _segment_verb("".join(out))))
                out.append(text[i:end]); i = end
                continue
        elif c == "\n" and heredocs:
            out.append(c); i += 1
            for delim, strip, quoted, verb in heredocs:
                start = i
                end = n
                while i < n:
                    eol = text.find("\n", i)
                    eol = n if eol < 0 else eol
                    line = text[i:eol]
                    nxt = min(eol + 1, n)
                    if (line.lstrip("\t") if strip else line) == delim:
                        end = i
                        i = nxt
                        break
                    i = nxt
                contents = text[start:end]
                inner = Scan("")
                if not quoted:
                    _scan(contents, 0, None, inner, quotes=False)
                res.bodies += inner.bodies
                if not _is_reader(verb) and res.pipe_verb:
                    verb = res.pipe_verb
                if _is_reader(verb):
                    res.payloads.append((verb, contents, quoted))
                out.append(delim + "\n")
            heredocs = []
            continue
        out.append(c); i += 1
    return n, "".join(out)
