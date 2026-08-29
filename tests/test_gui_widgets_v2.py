import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import gui.server
from fleet import ledger, prompts, tmux
from gui.widgets.prompts import server as psrv
from gui.widgets.hooks import server as hsrv

GUI_DIR = Path(__file__).resolve().parents[1] / "gui"


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


class WidgetJsStaticTests(unittest.TestCase):
    def test_widget_js_has_no_innerhtml(self):
        js = (GUI_DIR / "widgets" / "prompts" / "widget.js").read_text()
        self.assertNotIn("innerHTML", js)


class HostIdentityTests(unittest.TestCase):
    """C1b: gui/server.py must have exactly one module identity, or
    `_widget_route`'s `except HttpError` misses the widgets' HttpError and
    every 400/403/404 becomes a 500."""

    def test_httperror_identity(self):
        self.assertIs(psrv.HttpError, gui.server.HttpError)

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
