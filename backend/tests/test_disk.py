"""
Disk space on notebooks.

A free Colab VM has ~112 GB, shared by the voice server, the presenter engine
and the AI video engine. A full disk breaks narration too. Pinned here:
installs keep no download caches, AI video fetches only the folders the
pipeline loads, each big step checks for room first (and fails with a plain
reason rather than filling the disk), and a failed half download is removed.
"""

import ast
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from backend import voiceforge_presenter as vp  # noqa: E402
from backend.wan import install  # noqa: E402

# The shape of Wan2.2-TI2V-5B-Diffusers' model_index.json.
WAN_INDEX = {
    "_class_name": "WanPipeline",
    "_diffusers_version": "0.35.0.dev0",
    "boundary_ratio": None,
    "expand_timesteps": True,
    "scheduler": ["diffusers", "UniPCMultistepScheduler"],
    "text_encoder": ["transformers", "UMT5EncoderModel"],
    "tokenizer": ["transformers", "T5TokenizerFast"],
    "transformer": ["diffusers", "WanTransformer3DModel"],
    "transformer_2": [None, None],
    "vae": ["diffusers", "AutoencoderKLWan"],
}


class TestOnlyWhatThePipelineLoads:
    def test_patterns_are_the_index_and_each_component_folder(self):
        assert install.component_patterns(WAN_INDEX) == [
            "model_index.json",
            "scheduler/*",
            "text_encoder/*",
            "tokenizer/*",
            "transformer/*",
            "vae/*",
        ]

    def test_empty_components_and_settings_are_skipped(self):
        pats = install.component_patterns(WAN_INDEX)
        assert "transformer_2/*" not in pats
        assert not any(p.startswith(("boundary_ratio", "expand_timesteps", "_")) for p in pats)

    def test_notebook_script_uses_the_same_function(self):
        script = install._WEIGHTS_SCRIPT
        compile(script, "weights.py", "exec")
        tree = ast.parse(script)
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "component_patterns")
        scope: dict = {}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), "weights.py", "exec"), scope)
        assert scope["component_patterns"](WAN_INDEX) == install.component_patterns(WAN_INDEX)
        assert "allow_patterns=patterns" in script

    def test_modal_download_is_filtered_too(self):
        src = open(os.path.join(ROOT, "backend", "wan", "install.py"), encoding="utf-8").read()
        body = src.split("def download_weights", 1)[1].split("\ndef ", 1)[0]
        assert "allow_patterns=patterns" in body


class TestNoInstallerCaches:
    @pytest.mark.parametrize("module", [install, vp], ids=["wan", "presenter"])
    def test_installs_run_without_pip_or_uv_caches(self, module):
        env = module._clean_env()
        assert env["PIP_NO_CACHE_DIR"] == "1"
        assert env["UV_NO_CACHE"] == "1"

    def test_server_clears_cell_1_caches_at_start(self, tmp_path, monkeypatch, capsys):
        src = open(os.path.join(ROOT, "backend", "voiceforge_server.py"), encoding="utf-8").read()
        fn = next(
            n for n in ast.parse(src).body
            if isinstance(n, ast.FunctionDef) and n.name == "_free_installer_caches"
        )
        import shutil

        scope = {"os": os, "shutil": shutil}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), "voiceforge_server.py", "exec"), scope)

        monkeypatch.setenv("HOME", str(tmp_path))
        for sub in ("pip/http", "uv/wheels"):
            d = tmp_path / ".cache" / sub
            d.mkdir(parents=True)
            (d / "torch.whl").write_bytes(b"x" * 1000)
        keep = tmp_path / ".cache" / "huggingface" / "hub"
        keep.mkdir(parents=True)
        (keep / "model.safetensors").write_bytes(b"y")

        scope["_free_installer_caches"]()

        assert not (tmp_path / ".cache" / "pip").exists()
        assert not (tmp_path / ".cache" / "uv").exists()
        # Model weights the engines load at run time are left alone.
        assert (keep / "model.safetensors").exists()
        assert "freed" in capsys.readouterr().out

    def test_server_only_clears_caches_on_notebooks(self):
        src = open(os.path.join(ROOT, "backend", "voiceforge_server.py"), encoding="utf-8").read()
        i = src.rindex("_free_installer_caches()")
        assert 'if provider in ("colab", "kaggle"):' in src[i - 200 : i]


class TestRoomFirst:
    @pytest.mark.parametrize("module", [install, vp], ids=["wan", "presenter"])
    def test_plain_reason_when_there_is_no_room(self, module):
        with pytest.raises(module.DiskSpaceError) as e:
            module.ensure_space(27, free=12.4)
        msg = str(e.value)
        assert "not enough disk space" in msg
        assert "12 GB is left" in msg
        assert "Disconnect and delete runtime" in msg

    @pytest.mark.parametrize("module", [install, vp], ids=["wan", "presenter"])
    def test_passes_with_room_for_the_step_and_the_headroom(self, module):
        headroom = getattr(module, "HEADROOM_GB", None) or module.PRESENTER_HEADROOM_GB
        module.ensure_space(10, free=10 + headroom)
        with pytest.raises(module.DiskSpaceError):
            module.ensure_space(10, free=10 + headroom - 0.1)

    def test_free_gb_measures_the_nearest_existing_folder(self, tmp_path):
        assert install.free_gb(str(tmp_path / "not" / "made" / "yet")) > 0
        assert vp.free_gb(str(tmp_path / "missing")) > 0

    def test_ai_video_reports_no_room_without_writing_anything(self, tmp_path, monkeypatch):
        monkeypatch.setattr(install, "INSTALL_ROOT", str(tmp_path / "wan"))
        monkeypatch.setattr(install, "free_gb", lambda _p: 15.0)
        ran = []
        monkeypatch.setattr(install, "_step", lambda *a, **k: ran.append(a))
        install._install()
        assert install.INSTALL["state"] == "failed"
        assert "not enough disk space for AI video" in install.INSTALL["error"]
        assert ran == []
        assert not os.path.exists(install.model_dir())

    def test_a_failed_download_gives_the_space_back(self, tmp_path, monkeypatch):
        monkeypatch.setattr(install, "INSTALL_ROOT", str(tmp_path / "wan"))
        monkeypatch.setattr(install, "free_gb", lambda _p: 500.0)
        os.makedirs(install.INSTALL_ROOT, exist_ok=True)
        open(install._env_marker(), "w").close()  # libraries already installed

        def step(stage, cmd, timeout=0):
            # Half the weights land, then the download dies.
            os.makedirs(install.model_dir(), exist_ok=True)
            with open(os.path.join(install.model_dir(), "part.safetensors"), "wb") as f:
                f.write(b"z" * 100)
            raise RuntimeError("downloading the weights (~25 GB) failed: connection reset")

        monkeypatch.setattr(install, "_step", step)
        install._install()
        assert install.INSTALL["state"] == "failed"
        assert not os.path.exists(install.model_dir())

    def test_presenter_reports_no_room_without_writing_anything(self, tmp_path, monkeypatch):
        monkeypatch.setattr(vp, "INSTALL_ROOT", str(tmp_path / "presenter"))
        monkeypatch.setattr(vp, "free_gb", lambda _p: 10.0)
        ran = []
        monkeypatch.setattr(vp, "_step", lambda *a, **k: ran.append(a))
        vp._install_engine()
        assert vp.INSTALL["state"] == "failed"
        assert "not enough disk space for the presenter engine" in vp.INSTALL["error"]
        assert ran == []
        assert not os.path.exists(vp.INSTALL_ROOT)

    def test_disk_report_is_one_short_line(self):
        assert install.disk_report().startswith("disk: ")
        assert vp.disk_report().startswith("disk: ")


def test_index_fixture_is_valid_json():
    assert json.loads(json.dumps(WAN_INDEX))["transformer"][1] == "WanTransformer3DModel"
