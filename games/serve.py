#!/usr/bin/env python3
"""Static server for games/, with caching turned OFF.

Why this exists rather than `python3 -m http.server`:

`http.server` sends `Last-Modified` and no `Cache-Control`. Browsers then apply
*heuristic* caching, and an ES module graph is fetched by each module's own URL —
a query string on the page does not reach them. So after editing a source file you
can reload and still be running the old module, with no indication anything is stale.

Observed 2026-09-04: the pinball page failed with "does not provide an export named
KICKBACK_SPEED" while the file on disk and the file the server returned both had it.
The browser held a 2,723-byte copy; a forced re-fetch got 3,210 bytes. Node imported
it fine throughout. Roughly fifteen minutes went into chasing a bug that did not exist,
and the same trap had already cost time earlier the same day on a texture fix.

That matters more than a stale page: this server is the instrument for tuning physics
constants by hand in the sandbox. A cached constants.js means turning a slider and
measuring the *previous* value.

Usage:  python3 games/serve.py [port] [host]     (serves the games/ dir)

  serve.py                      127.0.0.1:8100
  serve.py 0                    127.0.0.1 on a free port the OS picks
  serve.py 0 100.98.216.13      tailnet address, free port
  serve.py 8100 100.98.216.13   tailnet address, fixed port

Port 0 means "any free port". A busy fixed port falls back to a free one and says
so — the bound URL is always printed, so the fallback cannot mislead you about
where it is actually listening.

The default bind is loopback on purpose: there is no auth here, so reaching it
from another machine has to be typed out, never inherited from a default.
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # no-store is the strong one: do not write to cache at all, so a module
        # graph cannot hold a stale copy across a reload.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter: one line per request is enough
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def _serve(host: str, port: int, root: str):
    """Bind, or raise OSError. Port 0 asks the OS for any free port."""
    handler = functools.partial(NoCacheHandler, directory=root)
    return http.server.ThreadingHTTPServer((host, port), handler)


def main() -> int:
    # Port 0 means "any free port" — the OS picks and we print what it chose.
    # Several of these run at once (loopback for local work, a tailnet address for
    # a phone, a scratch one per playtest), so a fixed port is the exception.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8100
    # Second arg is the bind address. Default stays loopback: this server has no auth,
    # so reaching it from another machine has to be an explicit choice, not a default.
    # A Tailscale IP here exposes it to the tailnet only, which is narrower than 0.0.0.0.
    host = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    root = os.path.dirname(os.path.abspath(__file__))

    try:
        httpd = _serve(host, port, root)
    except OSError as exc:
        if port == 0:
            print(f"cannot bind {host}: {exc}", file=sys.stderr)
            return 1
        # Asked for a specific port and something else holds it. Fall back to a free
        # one rather than failing — but say so, and print the real URL. A silent port
        # change would be worse than an error; an announced one is just convenient.
        print(f"port {port} on {host} is busy ({exc}); taking a free port instead",
              file=sys.stderr)
        try:
            httpd = _serve(host, 0, root)
        except OSError as exc2:
            print(f"cannot bind {host}: {exc2}", file=sys.stderr)
            return 1

    with httpd:
        bound_host, bound_port = httpd.server_address[:2]
        if isinstance(bound_host, bytes):
            bound_host = bound_host.decode()
        shown = f"[{bound_host}]" if ":" in str(bound_host) else bound_host
        print(f"serving {root} on http://{shown}:{bound_port}/ (no-store)", file=sys.stderr)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
