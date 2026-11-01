"""
What a notebook tells the app with every heartbeat, and how its two video
engines share the second GPU.

The app used to learn that AI video was ready only by asking when someone
pressed Generate, so a notebook that had just finished installing was skipped
and the clip went to Modal (paid). Now the state rides on the heartbeat.
"""

import ast
import os
import shutil
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from backend import notebook_runner as nr  # noqa: E402
from backend import voiceforge_presenter as vp  # noqa: E402
from backend.wan import service as wan_service  # noqa: E402
from backend.wan import settings as S  # noqa: E402


def _server_functions(*names, **scope):
    """Lift functions out of voiceforge_server.py, which needs torch to import."""
    src = open(os.path.join(ROOT, "backend", "voiceforge_server.py"), encoding="utf-8").read()
    fns = [n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name in names]
    from typing import Any, Dict, Optional

    env = {"os": os, "shutil": shutil, "Any": Any, "Dict": Dict, "Optional": Optional, "idle_seconds": lambda: 0, **scope}
    exec(compile(ast.Module(body=fns, type_ignores=[]), "voiceforge_server.py", "exec"), env)
    return env


class FakeWan:
    def __init__(self, report):
        self.report = report

    def health_report(self):
        return self.report


class TestBackendStatus:
    def test_ready_ai_video_is_reported_with_its_limits(self, monkeypatch):
        monkeypatch.setenv("VOICEFORGE_WAN", "1")
        env = _server_functions("system_report", "backend_status",
                                _WAN_SERVICE=FakeWan({"capabilities": ["text-to-video"], "limits": {"max_frames": 121}}))
        st = env["backend_status"]()
        assert st["wan"] == {"state": "ready", "capabilities": ["text-to-video"], "install": None, "limits": {"max_frames": 121}}
        assert st["system"]["disk_free_gb"] > 0 and st["system"]["disk_total_gb"] > 0

    def test_installing_says_which_step(self, monkeypatch):
        monkeypatch.setenv("VOICEFORGE_WAN", "1")
        env = _server_functions("system_report", "backend_status", _WAN_SERVICE=FakeWan({
            "capabilities": [], "install": {"state": "installing", "stage": "downloading the weights (~25 GB)"}}))
        wan = env["backend_status"]()["wan"]
        assert wan["state"] == "installing" and wan["install"]["stage"].startswith("downloading")

    def test_off_in_the_notebook_says_off(self, monkeypatch):
        monkeypatch.setenv("VOICEFORGE_WAN", "0")
        env = _server_functions("system_report", "backend_status", _WAN_SERVICE=None)
        assert env["backend_status"]()["wan"] == {"state": "off", "capabilities": []}

    def test_a_broken_service_is_a_failure_not_a_crash(self, monkeypatch):
        monkeypatch.setenv("VOICEFORGE_WAN", "1")

        class Broken:
            def health_report(self):
                raise RuntimeError("boom")

        env = _server_functions("system_report", "backend_status", _WAN_SERVICE=Broken())
        assert env["backend_status"]()["wan"]["state"] == "failed"


class TestHeartbeatPayload:
    def test_status_is_added_when_the_server_has_it(self, monkeypatch):
        import types

        fake = types.ModuleType("backend.voiceforge_server")
        fake.backend_status = lambda: {"wan": {"state": "ready"}}
        monkeypatch.setitem(sys.modules, "backend.voiceforge_server", fake)
        payload = nr.with_status({"provider": "kaggle", "url": "https://k"})
        assert payload == {"provider": "kaggle", "url": "https://k", "status": {"wan": {"state": "ready"}}}

    def test_an_older_server_still_registers(self, monkeypatch):
        import types

        monkeypatch.setitem(sys.modules, "backend.voiceforge_server", types.ModuleType("backend.voiceforge_server"))
        assert nr.with_status({"provider": "kaggle"}) == {"provider": "kaggle"}

    def test_both_registrations_carry_status(self):
        src = open(os.path.join(ROOT, "backend", "notebook_runner.py"), encoding="utf-8").read()
        assert src.count("with_status(registration_payload(") == 2


class TestEnginesTakeTurns:
    def test_presenter_waits_for_the_engine_lock(self, monkeypatch):
        lock = threading.Lock()
        vp.configure(shared_lock=None, before_engine=None, engine_lock=lock)
        ran = []
        monkeypatch.setattr(vp, "stream_engine", lambda *a, **k: ran.append(time.time()) or "ok")
        monkeypatch.setattr(vp, "_engine_env", lambda: {})
        lock.acquire()
        t = threading.Thread(target=lambda: vp._run_engine(["x"]))
        t.start()
        time.sleep(0.2)
        assert ran == []  # held back while the other engine runs
        lock.release()
        t.join(5)
        assert len(ran) == 1
        vp.configure(shared_lock=None, before_engine=None, engine_lock=None)

    def test_lock_order_is_engine_then_voice_in_both_services(self):
        vsrc = open(os.path.join(ROOT, "backend", "voiceforge_presenter.py"), encoding="utf-8").read()
        body = vsrc.split("def _run_engine(", 1)[1].split("\ndef ", 1)[0]
        assert body.index("_ENGINE_LOCK") < body.index("_SHARED_GPU_LOCK")
        wsrc = open(os.path.join(ROOT, "backend", "wan", "service.py"), encoding="utf-8").read()
        line = next(l for l in wsrc.splitlines() if "with _GPU_LOCK" in l and "engine_lock" in l)
        assert line.index("engine_lock") < line.index("shared or")

    def test_server_gives_both_services_the_same_lock(self):
        src = open(os.path.join(ROOT, "backend", "voiceforge_server.py"), encoding="utf-8").read()
        assert src.count("engine_lock=_ENGINE_LOCK") == 3  # presenter, presenter after reload, AI video

    def test_wan_configure_keeps_the_engine_lock(self):
        lock = threading.Lock()
        wan_service.configure("kaggle", engine_lock=lock)
        assert wan_service._CONFIG["engine_lock"] is lock
        wan_service.configure("custom")


def test_t4_profile_moves_parts_on_and_off_the_gpu():
    assert S.PROFILES["low_vram"]["cpu_offload"] is True
    assert S.PROFILES["low_vram"]["quantize"] is True
    assert S.PROFILES["full"]["cpu_offload"] is False  # Modal unchanged
