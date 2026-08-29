import hashlib
import importlib
import os
import sys
import threading
import time
from pathlib import Path

GUI_DIR = Path(__file__).resolve().parent
ROOT = GUI_DIR.parent


def _files(root: Path, suffixes: set[str]) -> list[Path]:
    if not root.exists():
        return []
    return sorted(
        p for p in root.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and p.suffix in suffixes
    )


def _hash(paths: list[Path]) -> str:
    h = hashlib.md5()
    for p in paths:
        try:
            st = p.stat()
        except FileNotFoundError:
            continue
        h.update(f"{p}{st.st_mtime_ns}{st.st_size}".encode())
    return h.hexdigest()


def _widget_watch_paths() -> dict[str, list[Path]]:
    out = {}
    widgets_dir = GUI_DIR / "widgets"
    if not widgets_dir.is_dir():
        return out
    for d in sorted(widgets_dir.iterdir()):
        if not (d / "server.py").is_file():
            continue
        try:
            mod = importlib.import_module(f"gui.widgets.{d.name}.server")
        except Exception:
            continue
        paths = []
        for pat in getattr(mod, "WATCH", []):
            paths.extend(ROOT.glob(pat))
        out[d.name] = sorted(paths)
    return out


def run(bus, interval: float = 0.5) -> None:
    py_hash = _hash(_files(GUI_DIR, {".py"}))
    asset_hash = _hash(_files(GUI_DIR, {".js", ".css", ".html", ".webmanifest"}))
    widget_paths = _widget_watch_paths()
    widget_hashes = {wid: _hash(paths) for wid, paths in widget_paths.items()}

    while True:
        time.sleep(interval)

        new_py = _hash(_files(GUI_DIR, {".py"}))
        if new_py != py_hash:
            # `-m gui` (not `-m gui.server`): the package entry point keeps one
            # gui.server module identity, so widget HttpErrors stay catchable.
            os.execv(sys.executable, [sys.executable, "-m", "gui", *sys.argv[1:]])

        new_asset = _hash(_files(GUI_DIR, {".js", ".css", ".html", ".webmanifest"}))
        if new_asset != asset_hash:
            asset_hash = new_asset
            bus.publish("core:reload")

        new_widget_paths = _widget_watch_paths()
        for wid, paths in new_widget_paths.items():
            h = _hash(paths)
            if h != widget_hashes.get(wid):
                widget_hashes[wid] = h
                bus.publish(f"w:{wid}:changed")
        widget_paths = new_widget_paths


def start(bus, interval: float = 0.5) -> threading.Thread:
    t = threading.Thread(target=run, args=(bus, interval), daemon=True)
    t.start()
    return t
