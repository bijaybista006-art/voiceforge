"""
The one-click notebook start, without a GPU.

backend/notebook_runner.py replaces the old "Restart session, then run Cell 0
and Cell 2" dance by running the server in a fresh Python process. What is
pinned here: its pure decisions, that it can be imported without torch (the
notebook kernel imports it before anything is installed), and that the
notebook actually wires it up — the Start cell launches it, Run All cannot
fall through into the classic cells, and the "newer notebook" check works.
"""

import ast
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from backend import notebook_runner as nr  # noqa: E402


def notebook():
    with open(os.path.join(ROOT, "colab", "voiceforge_server.ipynb"), encoding="utf-8") as f:
        return json.load(f)


def cells():
    return ["".join(c["source"]) for c in notebook()["cells"]]


class TestPureHelpers:
    @pytest.mark.parametrize("version, py313, ok", [
        ("1.26.4", False, True),
        ("2.0.2", False, False),
        ("2.2.6", True, True),
        ("2.3.0", True, False),
        ("1.26.4", True, False),
        ("garbage", True, False),
    ])
    def test_numpy_window_matches_the_install_cell(self, version, py313, ok):
        assert nr.numpy_in_range(version, py313) is ok

    def test_finds_the_tunnel_url_in_cloudflared_output(self):
        line = "2026-10-31 INF |  https://quiet-river-1234.trycloudflare.com  |"
        assert nr.tunnel_url(line) == "https://quiet-river-1234.trycloudflare.com"
        assert nr.tunnel_url("INF Starting tunnel") is None

    def test_registers_exactly_what_the_old_cell_did(self):
        p = nr.registration_payload("kaggle", "https://x.trycloudflare.com", "Tesla T4", ["chatterbox"], "2.1")
        assert p == {
            "provider": "kaggle",
            "url": "https://x.trycloudflare.com",
            "gpu": "Tesla T4",
            "models": ["chatterbox"],
            "version": "2.1",
            "capabilities": ["tts", "render"],
        }

    def test_versions_compare_as_numbers(self):
        assert nr.version_tuple("2026.10.31") < nr.version_tuple("2026.11.1")
        assert nr.version_tuple("2026.10.31.2") > nr.version_tuple("2026.10.31")


class TestNewerNotebookNotice:
    def _remote(self, version):
        return json.dumps({"cells": [{"source": [f'NOTEBOOK_VERSION = "{version}"\n']}]})

    def test_says_nothing_when_up_to_date(self):
        assert nr.newer_notebook_notice("2026.10.31", fetch=lambda _u: self._remote("2026.10.31")) == ""

    def test_says_so_when_github_is_newer(self):
        notice = nr.newer_notebook_notice("2026.10.31", fetch=lambda _u: self._remote("2026.11.05"))
        assert "NEWER NOTEBOOK" in notice and "2026.11.05" in notice and "Open in Colab" in notice

    def test_never_raises_without_network(self):
        def offline(_u):
            raise OSError("no network")

        assert nr.newer_notebook_notice("2026.10.31", fetch=offline) == ""

    def test_reads_the_real_notebooks_own_version(self):
        with open(os.path.join(ROOT, "colab", "voiceforge_server.ipynb"), encoding="utf-8") as f:
            v = nr.notebook_version_in(f.read())
        assert v and nr.version_tuple(v) >= nr.version_tuple("2026.10.31")


class TestImportsWithoutTorch:
    def test_module_level_imports_are_standard_library_only(self):
        with open(os.path.join(ROOT, "backend", "notebook_runner.py"), encoding="utf-8") as f:
            tree = ast.parse(f.read())
        top = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                top.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                top.add(node.module.split(".")[0])
        assert not top & {"torch", "numpy", "uvicorn", "fastapi", "backend", "scipy", "numba"}


class TestNotebookWiring:
    def test_cell_0_has_a_version_the_switch_and_exports_the_runner_settings(self):
        c0 = cells()[1]
        assert 'NOTEBOOK_VERSION = "' in c0
        assert "ONE_CLICK_START = True" in c0
        for name in ("VOICEFORGE_APP_URL", "REGISTRATION_TOKEN", "VOICEFORGE_PROVIDER"):
            assert f'os.environ["{name}"]' in c0

    def test_install_cell_downloads_the_runner_and_checks_for_a_newer_notebook(self):
        c1 = cells()[2]
        assert "backend/notebook_runner.py" in c1
        assert "newer_notebook_notice(NOTEBOOK_VERSION)" in c1
        assert "Restart session" not in c1.split("if ONE_CLICK_START:")[-1].split("else:")[0]

    def test_start_cell_launches_the_runner_in_a_fresh_process(self):
        start = cells()[3]
        assert '"-m", "backend.notebook_runner"' in start
        assert "sys.executable" in start
        assert "KeyboardInterrupt" in start

    def test_classic_cells_refuse_to_run_after_a_one_click_start(self):
        # Run All continues past the Start cell only if the runner exits; the
        # classic cells must not then try to start a second server.
        for body in cells()[4:]:
            assert body.lstrip().startswith("# Classic")
            assert "if ONE_CLICK_START:\n    raise SystemExit(" in body
