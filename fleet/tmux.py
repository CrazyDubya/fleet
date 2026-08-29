import subprocess
import tempfile
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


def paste(name: str, text: str) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(text); path = f.name
    try:
        _run("load-buffer", "-b", "fleet-paste", path)
        _run(*paste_argv(name))
    finally:
        Path(path).unlink()
    _run("send-keys", "-t", _target(name), "Enter")


def capture(name: str, lines: int = 50, join: bool = False) -> str:
    """`join=True` appends tmux's own `-J` (join wrapped lines back together
    for copy), which undoes tmux's line-wrapping of a long pane line. It does
    NOT undo Claude Code's own TUI soft-wrap, which renders continuation
    lines with a 2-space indent regardless of tmux wrapping - callers that
    need to see past that must handle it themselves (see fleet.ask)."""
    args = ["capture-pane", "-p"]
    if join:
        args.append("-J")
    args += ["-t", _target(name), "-S", f"-{lines}"]
    return _run(*args, capture=True).stdout
