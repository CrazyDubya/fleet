"""fleet gui-fable: stdlib-only live GUI server. No build step.

Routes
  GET  /                      core page
  GET  /widgets/              JSON list of widget modules (drop a .js in widgets/)
  GET  /widgets/<f>.js        widget module
  GET  /api/status            fleet status rows as JSON
  GET  /api/ledger?n=30       last n ledger events
  GET  /api/handoffs?n=10     newest handoffs (path, first line)
  GET  /api/inbox             workspace items (files in inbox/, newest first)
  POST /api/push              {"title","body","kind":"md|html"} -> writes inbox/<ts>-<slug>.md
  POST /api/send              {"thread","text"} -> fleet send
  GET  /events                SSE: 'reload' on any file change under gui-fable/, inbox/, ledger/
"""
import json, os, sys, time, subprocess, threading, re, hashlib
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from dataclasses import asdict

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
from fleet import status as fstatus, ledger as fledger  # noqa: E402

WATCH = [HERE, HERE / "widgets", HERE / "inbox", ROOT / "ledger", ROOT / "ledger" / "handoffs", ROOT / "state"]
_subs: list = []
_lock = threading.Lock()


def _snapshot():
    h = hashlib.md5()
    for d in WATCH:
        for p in sorted(d.rglob("*")) if d.exists() else []:
            if p.is_file() and "__pycache__" not in p.parts:
                st = p.stat(); h.update(f"{p}{st.st_mtime_ns}{st.st_size}".encode())
    return h.hexdigest()


def _watcher():
    last = _snapshot()
    while True:
        time.sleep(1)
        cur = _snapshot()
        if cur != last:
            last = cur
            with _lock:
                for q in _subs:
                    q.append("reload")


def _status_rows():
    out = []
    for r in fstatus.rows():
        d = asdict(r)
        out.append(d)
    return out


def _handoffs(n):
    root = ROOT / "ledger" / "handoffs"
    files = sorted(root.rglob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)[:n]
    res = []
    for p in files:
        first = p.read_text(errors="replace").splitlines()[:1]
        res.append({"path": str(p.relative_to(ROOT)), "thread": p.parent.name, "title": first[0] if first else "", "mtime": p.stat().st_mtime})
    return res


def _inbox():
    d = HERE / "inbox"
    files = sorted(d.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [{"name": p.name, "mtime": p.stat().st_mtime, "body": p.read_text(errors="replace")} for p in files if p.is_file()]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj, default=str).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def _file(self, p: Path, ctype):
        if not p.is_file():
            return self._json({"error": "not found"}, 404)
        b = p.read_bytes()
        self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        path, _, qs = self.path.partition("?")
        q = dict(kv.split("=", 1) for kv in qs.split("&") if "=" in kv)
        n = int(q.get("n", 20))
        if path == "/":
            return self._file(HERE / "index.html", "text/html; charset=utf-8")
        if path == "/manifest.json":
            return self._file(HERE / "manifest.json", "application/manifest+json")
        if path == "/widgets/":
            return self._json(sorted(p.name for p in (HERE / "widgets").glob("*.js")))
        if path.startswith("/widgets/") and path.endswith(".js") and "/" not in path[9:]:
            return self._file(HERE / "widgets" / path[9:], "text/javascript")
        if path == "/api/status":
            try:
                return self._json(_status_rows())
            except Exception as e:  # registry lock etc.
                return self._json({"error": str(e)}, 503)
        if path == "/api/ledger":
            return self._json(fledger.read_events()[-n:][::-1])
        if path == "/api/handoffs":
            return self._json(_handoffs(n))
        if path == "/api/inbox":
            return self._json(_inbox())
        if path == "/events":
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-cache"); self.end_headers()
            q = []
            with _lock:
                _subs.append(q)
            try:
                while True:
                    if q:
                        q.clear(); self.wfile.write(b"event: reload\ndata: 1\n\n")
                    else:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush(); time.sleep(1)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with _lock:
                    if q in _subs: _subs.remove(q)
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/send":
            thread, text = body.get("thread", ""), body.get("text", "")
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", thread) or not text.strip():
                return self._json({"error": "bad thread/text"}, 400)
            r = subprocess.run([str(ROOT / "bin" / "fleet"), "send", "--", thread, text], capture_output=True, text=True)
            return self._json({"rc": r.returncode, "out": r.stdout + r.stderr})
        if self.path == "/api/push":
            title = body.get("title", "untitled"); slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "item"
            ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
            ext = "html" if body.get("kind") == "html" else "md"
            p = HERE / "inbox" / f"{ts}-{slug}.{ext}"
            p.write_text(body.get("body", ""))
            return self._json({"path": str(p)})
        self._json({"error": "not found"}, 404)


def main():
    host = os.environ.get("GUI_HOST", "0.0.0.0"); port = int(os.environ.get("GUI_PORT", "8765"))
    threading.Thread(target=_watcher, daemon=True).start()
    ip = subprocess.run(["sh", "-c", "tailscale ip -4 2>/dev/null || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 2>/dev/null || ipconfig getifaddr en0"], capture_output=True, text=True).stdout.strip().splitlines()
    print(f"gui-fable: http://{ip[0] if ip else host}:{port}/  (widgets: {HERE/'widgets'})", flush=True)
    ThreadingHTTPServer((host, port), H).serve_forever()


if __name__ == "__main__":
    main()
