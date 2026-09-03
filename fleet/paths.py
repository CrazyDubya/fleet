from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / "state"
LEDGER = ROOT / "ledger"
CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def thread_dir(name: str) -> Path:
    return ROOT / name


def thread_cwd(thread) -> Path:
    """Where a thread actually runs.

    ROOT/<name> for fleet's own threads; an absolute `dir` for a thread that
    steers another repo. One definition, because the launcher set this in
    three places and each one would have had to learn about projects.
    """
    d = getattr(thread, "dir", None)
    return Path(d) if d else thread_dir(thread.name)


def profile_state(profile: str) -> Path:
    return STATE if profile == "v1" else STATE / profile


def transcript_path(cwd: Path, session_id: str) -> Path:
    key = str(cwd).replace("/", "-")
    return CLAUDE_PROJECTS / key / f"{session_id}.jsonl"
