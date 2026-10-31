"""
The AI video (Wan 2.2) backend, without a GPU.

The engine only runs on a real card, so what is pinned here is everything
around it: request validation and defaults, the two load profiles, the
HTTP job protocol (the same one the gateway already speaks for presenter
clips), and that every host downloads the same files and the same pins.
"""

import json
import os
import re
import sys
import time

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from backend.wan import install, service  # noqa: E402
from backend.wan import settings as S  # noqa: E402


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


class TestSettings:
    def test_defaults_on_modal_are_a_5_second_720p_clip(self):
        s = S.build_settings({"prompt": "a fox in snow"}, "full")
        assert (s["width"], s["height"]) == (1280, 704)
        assert s["num_frames"] == 121 and s["fps"] == 24 and s["duration"] == 5.04
        assert s["steps"] == 50 and s["guidance"] == 5.0
        assert s["negative_prompt"] == S.DEFAULT_NEGATIVE_PROMPT
        assert 0 <= s["seed"] <= 2**32 - 1

    def test_notebooks_default_to_480p(self):
        s = S.build_settings({"prompt": "x"}, "low_vram")
        assert (s["width"], s["height"]) == (832, 480)

    def test_vertical_swaps_the_sides_for_shorts(self):
        s = S.build_settings({"prompt": "x", "aspect": "Vertical", "quality": "720p"}, "low_vram")
        assert (s["width"], s["height"]) == (704, 1280)

    def test_every_size_is_a_multiple_of_32(self):
        for w, h in S.QUALITIES.values():
            assert w % 32 == 0 and h % 32 == 0

    def test_a_given_seed_is_kept(self):
        assert S.build_settings({"prompt": "x", "seed": 42}, "full")["seed"] == 42
        assert S.build_settings({"prompt": "x", "seed": "7"}, "full")["seed"] == 7

    @pytest.mark.parametrize("bad, words", [
        ({"prompt": "   "}, "empty"),
        ({"prompt": "x" * (S.MAX_PROMPT_CHARS + 1)}, "limit"),
        ({"prompt": "x", "aspect": "square"}, "aspect"),
        ({"prompt": "x", "quality": "4k"}, "quality"),
        ({"prompt": "x", "num_frames": 120}, "4k+1"),
        ({"prompt": "x", "num_frames": 125}, "4k+1"),
        ({"prompt": "x", "num_frames": "lots"}, "number"),
        ({"prompt": "x", "steps": 0}, "steps"),
        ({"prompt": "x", "guidance": 50}, "guidance"),
        ({"prompt": "x", "seed": 2**33}, "seed"),
    ])
    def test_bad_requests_say_what_to_fix(self, bad, words):
        with pytest.raises(S.SettingsError, match=re.escape(words)):
            S.build_settings(bad, "full")

    def test_profiles_follow_the_host(self, monkeypatch):
        monkeypatch.delenv("VOICEFORGE_WAN_PROFILE", raising=False)
        assert S.profile_for("modal") == "full"
        assert S.profile_for("colab") == "low_vram"
        assert S.profile_for("kaggle") == "low_vram"
        monkeypatch.setenv("VOICEFORGE_WAN_PROFILE", "full")
        assert S.profile_for("colab") == "full"

    def test_t4_profile_avoids_bf16(self):
        # A T4 has no bf16; fp16 compute with 4-bit weights is what fits it.
        assert S.PROFILES["low_vram"]["dtype"] == "float16"
        assert S.PROFILES["low_vram"]["quantize"] is True


class TestEveryHostGetsTheSameCode:
    def test_modal_image_pins_match_settings(self):
        src = read("modal", "voiceforge_wan.py")
        block = src[src.index("WAN_PACKAGES = ["):]
        block = block[: block.index("]") + 1]
        pins = re.findall(r'"([^"]+)"', block)
        assert pins == S.WAN_PACKAGES

    def test_server_fetches_every_package_file(self):
        src = read("backend", "voiceforge_server.py")
        listed = re.search(r"WAN_FILES = \(([^)]*)\)", src).group(1)
        names = set(re.findall(r'"([^"]+\.py)"', listed))
        on_disk = {f for f in os.listdir(os.path.join(ROOT, "backend", "wan")) if f.endswith(".py")}
        assert names == on_disk

    def test_notebook_downloads_every_package_file(self):
        nb = json.loads(read("colab", "voiceforge_server.ipynb"))
        code = "".join("".join(c["source"]) for c in nb["cells"])
        loop = re.search(r"for f in ([\w ]+); do wget[^\n]*backend/wan/\$f\.py", code)
        assert loop, "the notebook no longer downloads backend/wan/"
        on_disk = {f[:-3] for f in os.listdir(os.path.join(ROOT, "backend", "wan")) if f.endswith(".py")}
        assert set(loop.group(1).split()) == on_disk

    def test_notebook_has_video_on_but_waits_for_the_admin_switch(self):
        nb = json.loads(read("colab", "voiceforge_server.ipynb"))
        code = "".join("".join(c["source"]) for c in nb["cells"])
        assert "ENABLE_AI_VIDEO = True" in code
        assert 'os.environ["VOICEFORGE_WAN_GATED"] = "1"' in code
        # Acted on after registering and on every heartbeat.
        assert code.count("apply_app_features(") >= 2
        server = read("backend", "voiceforge_server.py")
        assert 'os.environ.get("VOICEFORGE_WAN", "0") == "1"' in server
        assert 'os.environ.get("VOICEFORGE_WAN_GATED") == "1"' in server


def _apply_app_features(wan_service):
    """The server's real apply_app_features, lifted out of a file that needs
    torch to import, run against a fake mounted service."""
    import ast

    src = read("backend", "voiceforge_server.py")
    fn = next(
        n for n in ast.parse(src).body
        if isinstance(n, ast.FunctionDef) and n.name == "apply_app_features"
    )
    from typing import Optional

    scope = {"Optional": Optional, "_WAN_SERVICE": wan_service}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), "voiceforge_server.py", "exec"), scope)
    return scope["apply_app_features"]


class _FakeInstall:
    def __init__(self):
        self.started = 0
        self.INSTALL = {"state": "idle"}

    def start_install_in_background(self):
        self.started += 1


class _FakeService:
    def __init__(self):
        self.install = _FakeInstall()


class TestAdminSwitch:
    def test_installs_only_when_the_app_says_ai_video_is_on(self):
        svc = _FakeService()
        apply = _apply_app_features(svc)
        assert "no download" in apply({"voice": True, "presenter": True, "clips": False})
        assert svc.install.started == 0
        assert "installing" in apply({"clips": True})
        assert svc.install.started == 1

    def test_an_answer_without_features_counts_as_on(self):
        # An app from before the switches existed sends no `features`.
        svc = _FakeService()
        _apply_app_features(svc)(None)
        assert svc.install.started == 1

    def test_says_so_when_the_notebook_has_video_off(self):
        assert "ENABLE_AI_VIDEO = False" in _apply_app_features(None)({"clips": True})

    def test_service_never_imports_torch_at_module_level(self):
        for name in ("settings.py", "install.py", "service.py"):
            src = read("backend", "wan", name)
            top = [line for line in src.splitlines() if line.startswith(("import ", "from "))]
            assert not any("torch" in line or "diffusers" in line for line in top), name


@pytest.fixture
def client(monkeypatch, tmp_path):
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient

    monkeypatch.setattr(service, "WORK_ROOT", str(tmp_path))
    service.RENDERS.clear()

    def check(secret):
        if secret != "s3cret":
            raise HTTPException(status_code=401, detail="bad backend secret")

    app = FastAPI()
    app.include_router(service.create_wan_router(check, provider="kaggle"), prefix="/wan")
    return TestClient(app)


H = {"X-Backend-Secret": "s3cret"}


def wait_for(client, job_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/wan/render/{job_id}", headers=H).json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.05)
    raise AssertionError("job never finished")


class TestHttp:
    def test_health_claims_nothing_until_the_engine_is_ready(self, client, monkeypatch):
        monkeypatch.setattr(service, "is_ready", lambda: False)
        h = client.get("/wan/health").json()
        assert h["capabilities"] == [] and h["profile"] == "low_vram"
        monkeypatch.setattr(service, "is_ready", lambda: True)
        h = client.get("/wan/health").json()
        assert h["capabilities"] == ["text-to-video"]
        assert h["limits"]["default_quality"] == "480p" and h["limits"]["max_frames"] == 121

    def test_secret_is_required(self, client):
        assert client.post("/wan/render", json={"prompt": "x"}).status_code == 401

    def test_bad_input_is_a_400_before_any_gpu_work(self, client, monkeypatch):
        monkeypatch.setattr(service, "is_ready", lambda: True)
        r = client.post("/wan/render", json={"prompt": "  "}, headers=H)
        assert r.status_code == 400 and "empty" in r.json()["detail"]

    def test_not_ready_is_a_503_so_the_gateway_moves_on(self, client, monkeypatch):
        monkeypatch.setattr(service, "is_ready", lambda: False)
        assert client.post("/wan/render", json={"prompt": "x"}, headers=H).status_code == 503

    def test_a_clip_is_made_collected_and_deleted(self, client, monkeypatch):
        monkeypatch.setattr(service, "is_ready", lambda: True)

        def fake_engine(job_id, settings, out_path, work):
            service._progress(job_id, 25, 50)
            with open(out_path, "wb") as f:
                f.write(b"MP4")
            return {"gen_seconds": 1.5, "load_seconds": 0.5, "gpu": "Tesla T4"}

        monkeypatch.setattr(service, "_run_subprocess", fake_engine)
        r = client.post("/wan/render", json={"prompt": "a fox", "seed": 9, "callback_token": "tok"}, headers=H)
        assert r.status_code == 202
        job_id = r.json()["job_id"]
        assert r.json()["settings"]["seed"] == 9

        job = wait_for(client, job_id)
        assert job["status"] == "done" and job["bytes"] == 3 and job["duration"] == 5.04
        assert job["settings"]["prompt"] == "a fox"
        assert "path" not in job and "token" not in job  # never leak local paths or tokens

        assert client.get(f"/wan/render/{job_id}/video").status_code == 401
        assert client.get(f"/wan/render/{job_id}/video?token=tok").content == b"MP4"
        assert client.delete(f"/wan/render/{job_id}", headers=H).json() == {"ok": True}
        assert client.get(f"/wan/render/{job_id}", headers=H).status_code == 404

    def test_engine_failure_reaches_the_job(self, client, monkeypatch, tmp_path):
        # The real subprocess path, with this Python standing in for the
        # virtualenv: engine.py runs, cannot import torch here, and must
        # report that as a JSON error event the service turns into the
        # job's error.
        monkeypatch.setattr(service, "is_ready", lambda: True)
        monkeypatch.setattr(install, "venv_python", lambda: sys.executable)
        r = client.post("/wan/render", json={"prompt": "x"}, headers=H)
        job = wait_for(client, r.json()["job_id"])
        assert job["status"] == "error"
        assert "torch" in job["error"] or "diffusers" in job["error"]
        assert job["oom"] is False
