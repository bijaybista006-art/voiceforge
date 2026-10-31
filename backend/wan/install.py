"""
Wan 2.2 — getting the engine and its weights onto a host.

  * Modal: download_weights() runs once, in the `download` function of
    modal/voiceforge_wan.py, into the `wan-models` volume. The image already
    has the libraries.
  * Colab / Kaggle: start_install_in_background() builds a private
    virtualenv (Wan's diffusers/transformers cannot share an environment with
    Chatterbox's pins) and downloads the weights into it, in a thread, after
    the voice server is already serving. Nothing waits for it; if it fails the
    voice server carries on and /wan/health says why.

No torch here: this module runs in the notebook's own Python.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional

try:
    from . import settings as S
except ImportError:  # loaded as a top-level module
    import settings as S  # type: ignore[no-redef]

# Where everything for Wan lives on a notebook. /tmp has the room on both
# Colab and Kaggle (/kaggle/working is capped at 20 GB; the weights are ~25).
INSTALL_ROOT = os.environ.get("VOICEFORGE_WAN_ROOT", "/tmp/voiceforge-wan")
VENV_PYTHON_VERSION = "3.11"

INSTALL: Dict[str, Any] = {"state": "idle", "stage": "", "error": "", "seconds": 0}
_STARTED = threading.Event()


def model_dir(root: Optional[str] = None) -> str:
    """Where the weights live: VOICEFORGE_WAN_MODEL_DIR (Modal sets it) or the install root."""
    base = root or os.environ.get("VOICEFORGE_WAN_MODEL_DIR") or os.path.join(INSTALL_ROOT, "models")
    return os.path.join(base, S.MODEL_ID)


def weights_ready(path: Optional[str] = None) -> bool:
    return os.path.exists(os.path.join(path or model_dir(), S.WEIGHTS_MARKER))


def venv_python() -> str:
    return os.path.join(INSTALL_ROOT, "venv", "bin", "python")


def engine_ready() -> bool:
    """Notebook: the private environment AND the weights are in place."""
    return os.path.exists(_env_marker()) and weights_ready()


def _env_marker() -> str:
    # Changes whenever the pins change, so a session that kept /tmp rebuilds.
    # (hashlib, not hash(): str hashes change between Python processes.)
    tag = hashlib.sha256("\n".join(S.WAN_PACKAGES).encode()).hexdigest()[:10]
    return os.path.join(INSTALL_ROOT, f".env-ready-{tag}")


def download_weights(dest: str, token: Optional[str] = None) -> None:
    """Download the model into dest and mark it complete. Needs huggingface_hub."""
    from huggingface_hub import snapshot_download

    snapshot_download(repo_id=S.MODEL_ID, revision=S.MODEL_REVISION, local_dir=dest, token=token or None)
    with open(os.path.join(dest, S.WEIGHTS_MARKER), "w", encoding="utf-8") as f:
        json.dump({"model": S.MODEL_ID, "revision": S.MODEL_REVISION, "at": time.time()}, f)


# The same download, run by the virtualenv's Python on a notebook.
_WEIGHTS_SCRIPT = r"""
import json, os, sys, time
from huggingface_hub import snapshot_download
model_id, revision, dest, marker = sys.argv[1:5]
snapshot_download(repo_id=model_id, revision=revision, local_dir=dest,
                  token=os.environ.get("HF_TOKEN") or None)
with open(os.path.join(dest, marker), "w") as f:
    json.dump({"model": model_id, "revision": revision, "at": time.time()}, f)
print("weights ready")
"""


def _clean_env() -> Dict[str, str]:
    """The notebook's environment minus what would leak its Python into ours.

    Kaggle's PYTHONPATH carries a sitecustomize that imports packages the
    private environment lacks; a Jupyter MPLBACKEND breaks matplotlib imports.
    """
    env = dict(os.environ)
    for name in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "VIRTUAL_ENV", "PIP_REQUIRE_VIRTUALENV"):
        env.pop(name, None)
    env["MPLBACKEND"] = "Agg"
    return env


def _step(stage: str, cmd: List[str], timeout: int = 60 * 45) -> None:
    INSTALL["stage"] = stage
    print(f"[wan] install: {stage}", flush=True)
    proc = subprocess.run(cmd, env=_clean_env(), capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        lines = [
            line for line in (proc.stderr or proc.stdout or "").splitlines()
            if "sitecustomize" not in line
        ]
        raise RuntimeError(f"{stage} failed: " + "\n".join(lines)[-700:])


def _install() -> None:
    t0 = time.time()
    python = venv_python()
    venv = os.path.dirname(os.path.dirname(python))
    try:
        INSTALL["state"] = "installing"
        os.makedirs(INSTALL_ROOT, exist_ok=True)

        if not os.path.exists(_env_marker()):
            if not os.path.exists(python):
                # uv fetches a standalone Python, so the install does not
                # depend on which Python the notebook host happens to run.
                shutil.rmtree(venv, ignore_errors=True)
                _step("getting an installer", [sys.executable, "-m", "pip", "install", "--quiet", "uv"])
                _step(f"creating a Python {VENV_PYTHON_VERSION} environment",
                      [sys.executable, "-m", "uv", "venv", "--seed", "--python", VENV_PYTHON_VERSION, venv])
            _step("installing the video libraries (the slow part)",
                  [sys.executable, "-m", "uv", "pip", "install", "--quiet", "--python", python, *S.WAN_PACKAGES])
            with open(_env_marker(), "w", encoding="utf-8") as f:
                f.write(str(time.time()))

        if not weights_ready():
            dest = model_dir()
            os.makedirs(dest, exist_ok=True)
            script = os.path.join(INSTALL_ROOT, "weights.py")
            with open(script, "w", encoding="utf-8") as f:
                f.write(_WEIGHTS_SCRIPT)
            _step("downloading the weights (~25 GB)",
                  [python, script, S.MODEL_ID, S.MODEL_REVISION, dest, S.WEIGHTS_MARKER],
                  timeout=60 * 90)

        INSTALL.update(state="ready", stage="ready", error="", seconds=round(time.time() - t0))
        print(f"[wan] engine ready ({INSTALL['seconds']}s)", flush=True)
    except Exception as e:  # noqa: BLE001 - reported on /wan/health
        INSTALL.update(state="failed", error=str(e)[:600], seconds=round(time.time() - t0))
        print("[wan] install failed:", e, flush=True)


def start_install_in_background() -> None:
    """Begin installing once. Returns immediately."""
    if _STARTED.is_set():
        return
    _STARTED.set()
    threading.Thread(target=_install, daemon=True).start()
