"""The presenter engine test notebook (colab/presenter_engine_test.ipynb) stays valid Python
and keeps reusing VoiceForge's own LatentSync path, so the baseline is what the app runs."""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NB = os.path.join(ROOT, "colab", "presenter_engine_test.ipynb")


def cells():
    with open(NB, encoding="utf-8") as f:
        return json.load(f)["cells"]


def test_every_code_cell_compiles():
    for i, c in enumerate(cells()):
        if c["cell_type"] == "code":
            compile("".join(c["source"]), f"cell {i}", "exec")


def test_baseline_uses_the_apps_own_engine_code():
    src = "".join("".join(c["source"]) for c in cells())
    for name in ("vp._install_engine()", "vp.engine_command(", "vp.stream_engine(", "vp.clamp_steps(None)"):
        assert name in src
    for engine in ("latentsync15", "musetalk15", "echomimic3_flash"):
        assert f'"{engine}"' in src


def test_no_outputs_or_secrets_are_committed():
    for c in cells():
        if c["cell_type"] == "code":
            assert c.get("outputs") == []
    src = "".join("".join(c["source"]) for c in cells())
    assert "REGISTRATION_TOKEN" not in src and "BACKEND_SECRET" not in src
