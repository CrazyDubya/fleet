import subprocess
import tempfile
from pathlib import Path

SESSION = "fleet"


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


def new_window(name: str, cwd: Path, command: str) -> None:
    ensure_session()
    _run("new-window", "-d", "-t", f"{SESSION}:", "-n", name, "-c", str(cwd), command)


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


def capture(name: str, lines: int = 50) -> str:
    return _run("capture-pane", "-p", "-t", _target(name), "-S", f"-{lines}", capture=True).stdout
