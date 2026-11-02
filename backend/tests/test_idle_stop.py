"""
A notebook says it is up (with its address) on every heartbeat, and stops
itself after sitting idle so a forgotten tab stops spending the free GPU
allowance. On Colab, Cell 2 then gives the GPU machine back.
"""

import ast
import json
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from backend import notebook_runner as nr  # noqa: E402

URL = "https://quiet-river.trycloudflare.com"
T = 1767225600  # 2026-01-01 00:00 UTC


class TestStatusLine:
    def test_connected_line_has_the_address_and_what_it_is_doing(self):
        line = nr.status_line("kaggle", URL, {
            "wan": {"state": "installing", "install": {"stage": "downloading the weights"}},
            "system": {"idle_seconds": 720, "disk_free_gb": 46.3},
        }, 30, now=T)
        assert line == (f"00:00 UTC  ● connected (kaggle) · {URL} · AI video: installing (downloading the weights)"
                        " · idle 12 min (stops itself at 30) · disk 46 GB free")

    def test_working_and_ready(self):
        line = nr.status_line("colab", URL, {"wan": {"state": "ready"}, "system": {"idle_seconds": 0}}, 30, now=T)
        assert "AI video: ready · working" in line

    def test_never_stopping_says_no_limit(self):
        line = nr.status_line("colab", URL, {"system": {"idle_seconds": 300}}, None, now=T)
        assert line.endswith("idle 5 min")

    def test_failed_heartbeat_is_loud(self):
        line = nr.status_line("kaggle", URL, None, 30, ok=False, error="timed out", now=T)
        assert line == "00:00 UTC  ✗ NOT connected (kaggle) · heartbeat failed: timed out · retrying"


class TestShouldStop:
    def test_after_the_limit(self):
        assert nr.should_stop({"system": {"idle_seconds": 1800}}, 30)
        assert not nr.should_stop({"system": {"idle_seconds": 1799}}, 30)

    def test_never_when_off_or_unknown(self):
        assert not nr.should_stop({"system": {"idle_seconds": 99999}}, None)
        assert not nr.should_stop({"system": {"idle_seconds": 99999}}, 0)
        assert not nr.should_stop({"system": {}}, 30)
        assert not nr.should_stop(None, 30)

    def test_minutes_from_the_app(self):
        assert nr._minutes(30) == 30 and nr._minutes("45") == 45
        assert nr._minutes(0) is None and nr._minutes(None) is None and nr._minutes("x") is None


def _server(*names, **scope):
    src = open(os.path.join(ROOT, "backend", "voiceforge_server.py"), encoding="utf-8").read()
    tree = ast.parse(src)
    fns = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    from typing import Any, Dict, Optional

    env = {"time": time, "threading": threading, "Any": Any, "Dict": Dict, "Optional": Optional, **scope}
    exec(compile(ast.Module(body=fns, type_ignores=[]), "voiceforge_server.py", "exec"), env)
    return env


class FakeService:
    def __init__(self, renders):
        self.RENDERS = renders


class TestIdleClock:
    def scope(self, **over):
        base = dict(_LAST_WORK=[1000.0], _GPU_LOCK=threading.Lock(), _ENGINE_LOCK=threading.Lock(),
                    _JOB_LOCK=threading.Lock(), JOBS={}, _PRESENTER_SERVICE=None, _WAN_SERVICE=None)
        base.update(over)
        return _server("note_work", "busy_now", "idle_seconds", **base)

    def test_counts_from_the_last_work(self):
        env = self.scope()
        assert env["idle_seconds"](now=1000.0 + 600) == 600

    def test_anything_running_is_not_idle(self):
        for over in (
            {"JOBS": {"a": {"status": "running"}}},
            {"_WAN_SERVICE": FakeService({"c": {"status": "queued"}})},
            {"_PRESENTER_SERVICE": FakeService({"p": {"status": "running"}})},
        ):
            env = self.scope(**over)
            assert env["idle_seconds"](now=99999) == 0
        lock = threading.Lock()
        lock.acquire()
        assert self.scope(_GPU_LOCK=lock)["idle_seconds"](now=99999) == 0

    def test_finished_work_does_not_keep_it_awake(self):
        env = self.scope(JOBS={"a": {"status": "done"}}, _WAN_SERVICE=FakeService({"c": {"status": "error"}}))
        assert env["idle_seconds"](now=1000.0 + 60) == 60

    def test_health_checks_are_not_work(self):
        src = open(os.path.join(ROOT, "backend", "voiceforge_server.py"), encoding="utf-8").read()
        mw = src.split("async def _count_work", 1)[1].split("return await call_next", 1)[0]
        assert 'endswith("/health")' in mw and "note_work()" in mw

    def test_heartbeat_carries_idle_seconds(self):
        src = open(os.path.join(ROOT, "backend", "voiceforge_server.py"), encoding="utf-8").read()
        assert '"idle_seconds": idle_seconds()' in src


class TestStopping:
    def test_goodbye_then_the_idle_exit_code(self, monkeypatch):
        sent, exits, logs = [], [], []
        monkeypatch.setattr(nr, "_register", lambda url, tok, payload: sent.append(payload) or {})
        monkeypatch.setattr(nr, "_log", logs.append)
        monkeypatch.setattr(nr.os, "_exit", lambda code: exits.append(code))

        class Tunnel:
            killed = False

            def kill(self):
                Tunnel.killed = True

        nr._stop_idle("https://app", "tok", {"provider": "colab", "status": {"system": {"idle_seconds": 1800}}}, 30, Tunnel())
        assert sent[0]["status"]["stopping"] is True and sent[0]["provider"] == "colab"
        assert Tunnel.killed and exits == [nr.IDLE_EXIT_CODE] == [75]
        assert any("Nothing to do for 30 min" in l for l in logs)

    def test_cell_2_gives_a_colab_gpu_back_on_that_code(self):
        nb = json.load(open(os.path.join(ROOT, "colab", "voiceforge_server.ipynb"), encoding="utf-8"))
        cell = next("".join(c["source"]) for c in nb["cells"] if "Cell 2 — Start everything" in "".join(c["source"]))
        assert "_proc.returncode == 75" in cell and "runtime.unassign()" in cell
        compile(cell.replace("ONE_CLICK_START", "True"), "cell2", "exec")
