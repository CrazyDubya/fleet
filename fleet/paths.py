from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / "state"
LEDGER = ROOT / "ledger"
CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def thread_dir(name: str) -> Path:
    return ROOT / name


def profile_state(profile: str) -> Path:
    return STATE if profile == "v1" else STATE / profile


def transcript_path(cwd: Path, session_id: str) -> Path:
    key = str(cwd).replace("/", "-")
    return CLAUDE_PROJECTS / key / f"{session_id}.jsonl"
