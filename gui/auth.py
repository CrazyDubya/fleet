import secrets
from pathlib import Path


def load_or_create_token(path: Path, rotate: bool = False) -> str:
    if not rotate and path.exists():
        return path.read_text().strip()
    token = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token)
    path.chmod(0o600)
    return token


def check_cookie(handler, token: str) -> bool:
    cookie = handler.headers.get("Cookie", "")
    for part in cookie.split(";"):
        part = part.strip()
        if part.startswith("fleet_gui="):
            return part[len("fleet_gui="):] == token
    return False
