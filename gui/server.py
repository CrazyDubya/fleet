import json
import mimetypes
import os
import queue
import socket
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fleet.paths import ROOT  # noqa: E402

from . import auth, bus as bus_mod, watch  # noqa: E402

GUI_DIR = Path(__file__).resolve().parent
STATIC = GUI_DIR / "static"
WIDGETS_DIR = GUI_DIR / "widgets"
TOKEN_PATH = ROOT / "state" / "gui-token"
MAX_SSE_CLIENTS = 32

BUS = bus_mod.Bus()
TOKEN = ""  # set in main()


class HttpError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _mime(path: Path) -> str:
    if path.suffix == ".js":
        return "text/javascript"
    if path.suffix == ".webmanifest":
        return "application/manifest+json"
    return mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def _list_widget_ids() -> list[str]:
    if not WIDGETS_DIR.is_dir():
        return []
    return sorted(
        d.name for d in WIDGETS_DIR.iterdir()
        if d.is_dir() and (d / "widget.js").is_file()
    )


class WidgetCtx:
    def __init__(self, handler: "Handler", wid: str):
        self._handler = handler
        self.id = wid
        self.method = handler.command
        parts = urlsplit(handler.path)
        self.query = {k: v[0] for k, v in parse_qs(parts.query).items()}
        self._body = None

    @property
    def body(self) -> bytes:
        if self._body is None:
            n = int(self._handler.headers.get("Content-Length", 0))
            self._body = self._handler.rfile.read(n) if n else b""
        return self._body

    def json(self):
        return json.loads(self.body or b"{}")

    def publish(self, name: str, data=None) -> None:
        BUS.publish(f"w:{self.id}:{name}", data)


PUBLIC_STATIC = frozenset({"/static/manifest.webmanifest", "/static/icon-192.png", "/static/icon-512.png"})


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code: int = 200) -> None:
        b = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _static(self, base: Path, rel: str) -> None:
        rel = rel.lstrip("/")
        target = (base / rel).resolve()
        try:
            target.relative_to(base.resolve())
        except ValueError:
            return self._json({"error": "forbidden"}, 403)
        if not target.is_file():
            return self._json({"error": "not found"}, 404)
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", _mime(target))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authed(self) -> bool:
        parts = urlsplit(self.path)
        qs = parse_qs(parts.query)
        k = qs.get("k", [None])[0]
        if k == TOKEN:
            self.send_response(302)
            self.send_header(
                "Set-Cookie",
                f"fleet_gui={TOKEN}; Path=/; SameSite=Lax; Max-Age=31536000",
            )
            self.send_header("Location", parts.path)
            self.end_headers()
            return False  # response already sent; caller must return immediately
        if auth.check_cookie(self, TOKEN):
            return True
        self._json({"error": "unauthorized"}, 401)
        return False

    def _widget_route(self) -> None:
        rest = urlsplit(self.path).path[len("/w/"):]
        wid, _, sub = rest.partition("/")
        server_py = WIDGETS_DIR / wid / "server.py"
        if not server_py.is_file():
            return self._json({"error": "not found"}, 404)
        import importlib
        try:
            mod = importlib.import_module(f"gui.widgets.{wid}.server")
        except Exception as e:
            return self._json({"error": f"widget import failed: {e}"}, 500)
        handler = getattr(mod, "ROUTES", {}).get(sub)
        if handler is None:
            return self._json({"error": "not found"}, 404)
        ctx = WidgetCtx(self, wid)
        try:
            result = handler(ctx)
        except HttpError as e:
            return self._json({"error": e.message}, e.code)
        except Exception as e:
            return self._json({"error": str(e)}, 500)
        return self._json(result)

    def _sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b"retry: 2000\n\n")
        q = BUS.subscribe()
        try:
            last_ping = time.time()
            while True:
                try:
                    event, data = q.get(timeout=1)
                    payload = json.dumps(data if data is not None else {})
                    self.wfile.write(f"event: {event}\ndata: {payload}\n\n".encode())
                    self.wfile.flush()
                except queue.Empty:
                    pass
                if time.time() - last_ping > 15:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    last_ping = time.time()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            BUS.unsubscribe(q)

    def do_GET(self):
        path = urlsplit(self.path).path
        # Browsers fetch the manifest and icons without credentials; they are
        # not sensitive, and gating them breaks "Add to Home Screen".
        if path in PUBLIC_STATIC:
            return self._static(STATIC, path[len("/static/"):])
        if not self._authed():
            return
        if path.startswith("/w/"):
            return self._widget_route()
        if path == "/":
            return self._static(STATIC, "index.html")
        if path.startswith("/static/"):
            return self._static(STATIC, path[len("/static/"):])
        if path.startswith("/widgets/"):
            return self._static(WIDGETS_DIR, path[len("/widgets/"):])
        if path == "/api/widgets":
            return self._json(_list_widget_ids())
        if path == "/api/events":
            return self._sse()
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlsplit(self.path).path
        if not self._authed():
            return
        if path.startswith("/w/"):
            return self._widget_route()
        self._json({"error": "not found"}, 404)


def _lan_ip() -> str:
    try:
        out = subprocess.run(
            ["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=2
        )
        ip = out.stdout.strip().splitlines()[0] if out.returncode == 0 else ""
        if ip:
            return ip
    except (OSError, subprocess.SubprocessError, IndexError):
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return socket.gethostbyname(socket.gethostname())


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=int(os.environ.get("GUI_PORT", 8787)))
    p.add_argument("--bind", default=os.environ.get("GUI_BIND", "0.0.0.0"))
    p.add_argument("--new-token", action="store_true")
    args = p.parse_args(argv)

    global TOKEN
    TOKEN = auth.load_or_create_token(TOKEN_PATH, rotate=args.new_token)

    watch.start(BUS)

    httpd = ThreadingHTTPServer((args.bind, args.port), Handler)
    httpd.daemon_threads = True
    print(f"fleet gui  ->  http://{_lan_ip()}:{args.port}/?k={TOKEN}", flush=True)
    print(f"             (open once with ?k= on each device; token at {TOKEN_PATH})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    # `python3 -m gui.server` executes this file as `__main__`, which would give
    # gui/server.py a SECOND module identity alongside the `gui.server` every
    # widget imports - and two identities mean two HttpError classes, so
    # `_widget_route`'s `except HttpError` stops catching the widgets' one (see
    # gui/__main__.py). Delegate into the canonical module instead of calling
    # this copy's main(); `python3 -m gui` is the documented entry point.
    from gui.server import main as _main

    _main()
