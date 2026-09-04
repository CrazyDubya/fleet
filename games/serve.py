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

Usage:  python3 games/serve.py [port]        (default 8100, serves the games/ dir)
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


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8100
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {root} on http://127.0.0.1:{port}/ (no-store)", file=sys.stderr)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
