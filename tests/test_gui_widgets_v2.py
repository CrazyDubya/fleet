import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import gui.server
from fleet import ledger, prompts, tmux
from gui.widgets.prompts import server as psrv
from gui.widgets.hooks import server as hsrv

GUI_DIR = Path(__file__).resolve().parents[1] / "gui"
ROOT = GUI_DIR.parent


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def ctx(method="GET", query=None, body=None):
    return SimpleNamespace(method=method, query=query or {}, json=lambda: body or {}, publish=lambda *a: None)


class PromptsWidgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.state = Path(self.tmp.name)
        self.p = mock.patch("fleet.prompts.profile_state", return_value=self.state); self.p.start()
        self.cap = mock.patch("gui.widgets.prompts.server.tmux.capture", return_value="line1\nline2\n"); self.cap.start()
        # _session() mutates the fleet.tmux module global; keep it out of every
        # other test in this process.
        self.session = tmux.SESSION

    def tearDown(self):
        tmux.use_session(self.session)
        self.cap.stop(); self.p.stop(); self.tmp.cleanup()

    def test_list_includes_pane_tail(self):
        prompts.open_prompt("sonnet2", "Bash", "cat ~/x", "/Users/pup/fleet/sonnet2", "v2")
        out = psrv.get(ctx())
        self.assertEqual(out["items"][0]["command"], "cat ~/x")
        self.assertEqual(out["items"][0]["pane"], ["line1", "line2"])

    def test_decide_writes_decision(self):
        rec = json.loads(prompts.open_prompt("sonnet2", "Bash", "x", "/c", "v2").read_text())
        out = psrv.decide(ctx("POST", body={"thread": "sonnet2", "id": rec["id"], "decision": "allow"}))
        self.assertEqual(out["ok"], True)
        self.assertEqual(prompts.pending("v2"), [])

    def test_keypress_validates(self):
        with mock.patch("gui.widgets.prompts.server.tmux._run") as run, \
                mock.patch("gui.widgets.prompts.server.tmux.window_exists", return_value=True):
            psrv.keypress(ctx("POST", body={"thread": "sonnet2", "key": "1"}))
            run.assert_called_once()
        with self.assertRaises(Exception):
            psrv.keypress(ctx("POST", body={"thread": "sonnet2", "key": "rm -rf"}))

    def test_get_filters_malformed_thread_names(self):
        prompts.open_prompt("<img src=x onerror=alert(1)>", "Bash", "x", "/c", "v2")
        out = psrv.get(ctx())
        self.assertEqual(out["items"], [])

    def test_keypress_targets_the_profiles_session(self):
        # H3: the widget never activated the profile, so a v2 keypress was
        # aimed at tmux session "fleet" (v1).
        with mock.patch.dict(os.environ, {"FLEET_PROFILE": "v2"}), \
                mock.patch("gui.widgets.prompts.server.tmux._run") as run, \
                mock.patch("gui.widgets.prompts.server.tmux.window_exists", return_value=True):
            psrv.keypress(ctx("POST", body={"thread": "sonnet2", "key": "1"}))
        target = run.call_args.args[2]
        self.assertTrue(target.startswith("fleet2:"), target)

    def test_keypress_dead_window_404(self):
        with mock.patch("gui.widgets.prompts.server.tmux.window_exists", return_value=False):
            with self.assertRaises(psrv.HttpError) as cm:
                psrv.keypress(ctx("POST", body={"thread": "sonnet2", "key": "1"}))
            self.assertEqual(cm.exception.code, 404)


class HooksWidgetTests(unittest.TestCase):
    def test_tail_and_counts(self):
        with tempfile.TemporaryDirectory() as d:
            ev = Path(d) / "events.jsonl"
            ledger.event("hook", path=ev, hook="gate", thread="sonnet2", decision="allow", ms=3, why="ok")
            ledger.event("hook", path=ev, hook="perm", thread="sonnet2", decision="escalate", ms=0, why="path")
            ledger.event("send", path=ev, thread="x")
            with mock.patch("gui.widgets.hooks.server.ledger.EVENTS", ev):
                out = hsrv.get(ctx(query={"n": "10"}))
        self.assertEqual([e["hook"] for e in out["events"]], ["perm", "gate"])
        self.assertEqual(out["counts"]["sonnet2"], {"allow": 1, "escalate": 1})

    def _big_ledger(self, d: Path) -> Path:
        """A ledger longer than MAX_LINES, with a marker at the very top."""
        ev = d / "events.jsonl"
        lines = [json.dumps({"ev": "hook", "t": 0.0, "hook": "gate", "thread": "ancient", "decision": "allow"})]
        lines += [json.dumps({"ev": "send", "t": float(i), "thread": "filler"})
                  for i in range(hsrv.MAX_LINES + 500)]
        lines += [json.dumps({"ev": "hook", "t": 9.0, "hook": "perm", "thread": "sonnet2", "decision": "allow"})]
        ev.write_text("\n".join(lines) + "\n")
        return ev

    def test_only_the_tail_of_a_large_ledger_is_read(self):
        with tempfile.TemporaryDirectory() as d:
            ev = self._big_ledger(Path(d))
            self.assertGreater(len(ev.read_text().splitlines()), hsrv.MAX_LINES)
            with mock.patch("gui.widgets.hooks.server.ledger.EVENTS", ev):
                out = hsrv.get(ctx(query={"n": "10"}))
        self.assertEqual([e["thread"] for e in out["events"]], ["sonnet2"])
        # the marker sits before the window, so it must not be counted either
        self.assertNotIn("ancient", out["counts"])
        self.assertEqual(out["window"], hsrv.MAX_LINES)

    def test_tail_helper_reads_from_the_end(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "big.txt"
            f.write_text("".join(f"line{i}\n" for i in range(hsrv.MAX_LINES * 3)))
            got = ledger.tail_lines(f, 3)
        self.assertEqual(got, [f"line{i}" for i in range(hsrv.MAX_LINES * 3 - 3, hsrv.MAX_LINES * 3)])

    def test_non_numeric_n_is_a_400_not_a_500(self):
        with self.assertRaises(gui.server.HttpError) as cm:
            hsrv.get(ctx(query={"n": "; rm -rf /"}))
        self.assertEqual(cm.exception.code, 400)

    def test_negative_n_is_clamped_to_zero(self):
        # `evs[-n:]` with a negative n is a suffix slice of the WHOLE list:
        # n=-1 used to return every event but the last.
        with tempfile.TemporaryDirectory() as d:
            ev = Path(d) / "events.jsonl"
            for i in range(3):
                ledger.event("hook", path=ev, hook="gate", thread="sonnet2", decision="allow", ms=i, why="ok")
            with mock.patch("gui.widgets.hooks.server.ledger.EVENTS", ev):
                self.assertEqual(hsrv.get(ctx(query={"n": "-5"}))["events"], [])
                self.assertEqual(hsrv.get(ctx(query={"n": "0"}))["events"], [])
                self.assertEqual(len(hsrv.get(ctx(query={"n": "2"}))["events"]), 2)


class WidgetJsStaticTests(unittest.TestCase):
    def test_widget_js_has_no_innerhtml(self):
        js = (GUI_DIR / "widgets" / "prompts" / "widget.js").read_text()
        self.assertNotIn("innerHTML", js)


class HostIdentityTests(unittest.TestCase):
    """C1b: gui/server.py must have exactly one module identity, or
    `_widget_route`'s `except HttpError` misses the widgets' HttpError and
    every 400/403/404 becomes a 500."""

    def test_httperror_identity_in_a_fresh_interpreter(self):
        # Vacuous in-process: under pytest both names already resolve to the
        # same module object. Ask a fresh interpreter instead.
        r = subprocess.run(
            [sys.executable, "-c",
             "import gui.server as a, gui.widgets.prompts.server as b\n"
             "assert a.HttpError is b.HttpError\n"
             "import gui.widgets.hooks.server as c\n"
             "assert a.HttpError is c.HttpError\n"],
            cwd=str(ROOT), capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_dash_m_gui_server_delegates_to_the_package(self):
        """`python3 -m gui.server` must reach the canonical gui.server.main -
        it prints the banner and serves, rather than running a second copy of
        the module under the name __main__."""
        port = _free_port()
        p = subprocess.Popen(
            [sys.executable, "-m", "gui.server", "--port", str(port), "--bind", "127.0.0.1"],
            cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        timer = threading.Timer(2.0, p.terminate)
        timer.start()
        try:
            out = p.communicate(timeout=10)[0]
        finally:
            timer.cancel()
            p.kill()
        self.assertIn("fleet gui", out)
        self.assertIn(f":{port}/?k=", out)

    def test_package_entry_point_exists(self):
        src = (GUI_DIR / "__main__.py").read_text()
        self.assertIn("from gui.server import main", src)

    def test_server_module_does_not_run_a_second_copy(self):
        src = (GUI_DIR / "server.py").read_text()
        tail = src.split('if __name__ == "__main__":')[1]
        self.assertIn("from gui.server import main", tail)
        self.assertNotIn("\n    main()", tail)

    def test_reload_reexecs_the_package(self):
        self.assertIn('"-m", "gui"', (GUI_DIR / "watch.py").read_text())
