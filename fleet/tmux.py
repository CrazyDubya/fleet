import re
import subprocess
import tempfile
import time
from pathlib import Path

SESSION = "fleet"


def use_session(name: str) -> None:
    """Point every tmux call at another session (profiles, spec §4)."""
    global SESSION
    SESSION = name


def _run(*args, check=True, capture=False) -> subprocess.CompletedProcess:
    return subprocess.run(["tmux", *args], check=check, capture_output=capture, text=True)


def ensure_session() -> None:
    if _run("has-session", "-t", SESSION, check=False, capture=True).returncode != 0:
        _run("new-session", "-d", "-s", SESSION, "-n", "fleet-home")


def _target(name: str) -> str:
    return f"{SESSION}:={name}"


def window_exists(name: str) -> bool:
    r = _run("list-windows", "-t", SESSION, "-F", "#{window_name}", check=False, capture=True)
    return r.returncode == 0 and name in r.stdout.split("\n")


def new_window(name: str, cwd: Path, command: str, remain_on_exit: bool = False) -> None:
    """Create a detached window running `command` in `cwd`.

    With remain_on_exit the pane survives the command exiting, so a spawn
    that dies immediately can still have its stderr read back (spec §9). It
    is set in the SAME tmux invocation as new-window: a separate call would
    race a command that exits before the option lands.
    """
    ensure_session()
    args = ["new-window", "-d", "-t", f"{SESSION}:", "-n", name, "-c", str(cwd), command]
    if remain_on_exit:
        args += [";", "set-option", "-w", "-t", _target(name), "remain-on-exit", "on"]
    _run(*args)


def remain_on_exit(name: str) -> str:
    """The window's *effective* remain-on-exit (inherited value included)."""
    r = _run("display", "-p", "-t", _target(name), "#{remain-on-exit}", check=False, capture=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def clear_remain_on_exit(name: str) -> None:
    _run("set-option", "-w", "-t", _target(name), "-u", "remain-on-exit", check=False)


def pane_dead(name: str) -> bool:
    """True when the window's command has exited but the pane is being kept."""
    r = _run("display", "-p", "-t", _target(name), "#{pane_dead}", check=False, capture=True)
    return r.returncode == 0 and r.stdout.strip() == "1"


def kill_window(name: str) -> None:
    if not window_exists(name):
        return
    _run("kill-window", "-t", _target(name))


def paste_argv(name: str, buffer: str = "fleet-paste") -> list[str]:
    """`paste-buffer` args for delivering one packet as a single input event.

    `-p` is load-bearing: it wraps the paste in bracketed-paste escapes when
    the receiving application has asked for that mode. Claude Code has, and
    without the brackets it treats every newline as a submit - so a
    multi-line packet arrives as N separate messages, each answered before
    the rest of the packet has even been read. `-d` deletes the buffer after
    pasting; the Enter that follows is still sent explicitly, because a
    bracketed paste deliberately does not submit by itself.
    """
    return ["paste-buffer", "-b", buffer, "-t", _target(name), "-d", "-p"]


PROMPT_MARK = "\u276f"  # the TUI's input-box caret


class DirtyInputBox(RuntimeError):
    """The pane's input box holds text that could not be cleared."""


DIM = "\x1b[2m"
SGR_RE = re.compile(r"\x1b\[[0-9;]*m")


def parse_input_box(pane: str) -> str | None:
    """Text sitting UNSENT in a captured pane's input box, "" when the box holds
    nothing the thread would actually send, None when there is no input box on
    screen at all.

    REQUIRES an escape-preserving capture (`capture(..., escapes=True)`).
    Without the SGR codes this cannot do its main job, because the box renders
    two completely different things identically in plain text:

        real draft:  \u276f REAL DRAFT HERE
        suggestion:  \u276f \x1b[2mcheck for more bench packets\x1b[0m

    The second is Claude Code's dim-rendered *suggested* next prompt. It is not
    in any buffer, no keystroke clears it, and it is discarded the instant real
    input arrives - it is decoration. Treating it as a draft reports healthy
    threads as wedged, which is exactly the mistake that cost opus2 a respawn.

    The box is the LAST caret-led line: submitted prompts echo into scrollback
    with the same caret and are always above the live box. None is a real third
    state, not a parse failure - a permission dialog replaces the box entirely.
    """
    for line in reversed(pane.splitlines()):
        stripped = line.strip()
        plain = SGR_RE.sub("", stripped)
        if not plain.startswith(PROMPT_MARK):
            continue
        after = stripped[stripped.index(PROMPT_MARK) + len(PROMPT_MARK):].lstrip()
        if after.startswith(DIM):
            return ""  # a suggestion, not content
        return SGR_RE.sub("", after).strip()
    return None


def input_box(name: str) -> str | None:
    return parse_input_box(capture(name, lines=40, escapes=True))


CLEAR_ATTEMPTS = 6
CLEAR_BACKOFF_S = 0.5


def clear_input(name: str, attempts: int = CLEAR_ATTEMPTS, sleep=time.sleep) -> str:
    """Empty the input box. Returns whatever text refused to clear ("" on success).

    C-u is the TUI's kill-line. It lands on an IDLE pane and is ignored by a
    pane mid-turn, so a leftover draft on a still-thinking thread needs a few
    seconds of retry rather than an immediate refusal - that is the ordinary
    case of two sends in quick succession, and failing it would break
    `fleet ask`.

    Some drafts never clear: two panes carrying long-lived ones accepted C-u
    (rc=0) and C-c without changing, and only a respawn cleared them. So this
    reports what is left rather than assuming success.
    """
    for i in range(attempts):
        cur = input_box(name)
        if not cur:  # "" (empty box) or None (no box: dialog, non-TUI)
            return ""
        _run("send-keys", "-t", _target(name), "C-u")
        sleep(CLEAR_BACKOFF_S * (i + 1))
    return input_box(name) or ""


def paste(name: str, text: str) -> None:
    # Anything left in the input box is NOT replaced by the paste - it is
    # prefixed to it. Proven live 2026-09-03: a pane holding "LEFTOVER DRAFT
    # TEXT" received the next packet as
    #     LEFTOVER DRAFT TEXT @to haiku-fs2  @from operator  @lane lookup ...
    # so the protocol header is corrupted, arbitrary text rides into the
    # thread as part of a dispatch, and ledger.event's sha256 records only the
    # bytes fleet SENT - not the bytes the thread READ, which is the whole
    # point of logging the digest. Refuse rather than concatenate.
    leftover = clear_input(name)
    if leftover:
        raise DirtyInputBox(
            f"{name} has unsent text in its input box that will not clear: {leftover[:120]!r}. "
            f"Pasting would prepend it to this message. `fleet respawn {name}` first."
        )
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(text); path = f.name
    try:
        _run("load-buffer", "-b", "fleet-paste", path)
        _run(*paste_argv(name))
    finally:
        Path(path).unlink()
    _run("send-keys", "-t", _target(name), "Enter")


def capture(name: str, lines: int = 50, join: bool = False, escapes: bool = False) -> str:
    """`join=True` appends tmux's own `-J` (join wrapped lines back together
    for copy), which undoes tmux's line-wrapping of a long pane line. It does
    NOT undo Claude Code's own TUI soft-wrap, which renders continuation
    lines with a 2-space indent regardless of tmux wrapping - callers that
    need to see past that must handle it themselves (see fleet.ask)."""
    args = ["capture-pane", "-p"]
    if join:
        args.append("-J")
    if escapes:
        args.append("-e")  # keep SGR codes: parse_input_box needs them
    args += ["-t", _target(name), "-S", f"-{lines}"]
    return _run(*args, capture=True).stdout
