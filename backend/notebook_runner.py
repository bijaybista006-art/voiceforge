"""
VoiceForge notebook runner: one Run All, no "Restart session".

Why it exists: Cell 1 of the Colab/Kaggle notebook pip-installs packages
(numpy above all) into a kernel that already imported its own numpy at
startup, so the old Cells 2-3 only worked after Runtime > Restart session
and running Cell 0 and Cell 2 again by hand. This script does what those
cells did — load the models, serve, open the tunnel, register and heartbeat —
in a FRESH Python process, which always sees exactly what Cell 1 installed.
The notebook's "Start" cell launches it and streams its output.

    cd /content && python -u -m backend.notebook_runner

Reads its settings from the environment, which Cell 0 fills in:
    VOICEFORGE_APP_URL, REGISTRATION_TOKEN, VOICEFORGE_PROVIDER,
    BACKEND_SECRET, VOICEFORGE_VOICES_DIR, VOICEFORGE_WAN, ... (server env)

Imports only the standard library at module level: the notebook kernel
imports newer_notebook_notice from here without loading torch, and CI tests
the pure helpers without a GPU.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

PORT = int(os.environ.get("VOICEFORGE_PORT", "8000"))
NOTEBOOK_RAW_URL = (
    "https://raw.githubusercontent.com/bijaybista006-art/voiceforge/main/colab/voiceforge_server.ipynb"
)
_TUNNEL_RE = re.compile(r"https://[-\w]+\.trycloudflare\.com")
_VERSION_RE = re.compile(r'NOTEBOOK_VERSION\s*=\s*"([0-9][0-9.]*)"')


# ---------------------------------------------------------------------------
# pure helpers (tested in backend/tests/test_notebook_runner.py)
# ---------------------------------------------------------------------------

def numpy_in_range(version: str, py313: bool) -> bool:
    """The numpy window the voice stack needs (see the notebook's Cell 1)."""
    try:
        major, minor = (int(x) for x in version.split(".")[:2])
    except ValueError:
        return False
    return (2, 0) <= (major, minor) < (2, 3) if py313 else major == 1


def tunnel_url(line: str) -> Optional[str]:
    """The public URL in a line of cloudflared output, if there is one."""
    m = _TUNNEL_RE.search(line or "")
    return m.group(0) if m else None


def registration_payload(provider: str, url: str, gpu: str, models: List[str], version: str) -> Dict[str, Any]:
    return {
        "provider": provider,
        "url": url,
        "gpu": gpu,
        "models": models,
        "version": version,
        # One tunnel serves both, so the gateway needs no separate render URL.
        "capabilities": ["tts", "render"],
    }


def with_status(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Add the server's status (AI video install state, disk, GPU memory).

    Best-effort: a server file from before backend_status existed, or any
    error, sends the plain registration, which the app has always accepted.
    """
    try:
        from backend.voiceforge_server import backend_status

        return {**payload, "status": backend_status()}
    except Exception:  # noqa: BLE001
        return payload


# Exit code that tells Cell 2 "stopped because nothing was used": on Colab it
# then releases the GPU machine (runtime.unassign()), like Disconnect and
# delete runtime.
IDLE_EXIT_CODE = 75


def status_line(
    provider: str,
    url: str,
    status: Optional[Dict[str, Any]],
    idle_stop_minutes: Optional[int],
    ok: bool = True,
    error: str = "",
    now: Optional[float] = None,
) -> str:
    """One line per heartbeat, so the bottom of Cell 2 always says whether
    this backend is up, at which address, and what it is doing."""
    stamp = time.strftime("%H:%M UTC", time.gmtime(now or time.time()))
    if not ok:
        return f"{stamp}  ✗ NOT connected ({provider}) · heartbeat failed: {error[:160]} · retrying"
    parts = [f"{stamp}  ● connected ({provider})", url]
    wan = (status or {}).get("wan") or {}
    state = wan.get("state")
    if state == "ready":
        parts.append("AI video: ready")
    elif state == "installing":
        stage = ((wan.get("install") or {}).get("stage") or "").strip()
        parts.append(f"AI video: installing ({stage})" if stage else "AI video: installing")
    elif state == "failed":
        err = ((wan.get("install") or {}).get("error") or "").strip()
        parts.append(f"AI video: failed ({err[:80]})" if err else "AI video: failed")
    elif state == "off":
        parts.append("AI video: off")
    system = (status or {}).get("system") or {}
    idle = system.get("idle_seconds")
    if isinstance(idle, (int, float)):
        if idle <= 0:
            parts.append("working")
        else:
            text = f"idle {int(idle // 60)} min"
            if idle_stop_minutes:
                text += f" (stops itself at {idle_stop_minutes})"
            parts.append(text)
    if isinstance(system.get("disk_free_gb"), (int, float)):
        parts.append(f"disk {system['disk_free_gb']:.0f} GB free")
    return " · ".join(parts)


def should_stop(status: Optional[Dict[str, Any]], idle_stop_minutes: Optional[int]) -> bool:
    """True once the backend has done nothing for the limit set in Admin -> Settings."""
    if not idle_stop_minutes or idle_stop_minutes <= 0:
        return False
    idle = ((status or {}).get("system") or {}).get("idle_seconds")
    return isinstance(idle, (int, float)) and idle >= idle_stop_minutes * 60


def version_tuple(v: str) -> Tuple[int, ...]:
    return tuple(int(p) for p in re.findall(r"\d+", v or ""))


def notebook_version_in(notebook_json: str) -> Optional[str]:
    """NOTEBOOK_VERSION as written in a notebook file (its JSON text)."""
    try:
        cells = json.loads(notebook_json).get("cells", [])
        code = "".join("".join(c.get("source", [])) for c in cells)
    except (ValueError, AttributeError):
        return None
    m = _VERSION_RE.search(code)
    return m.group(1) if m else None


def newer_notebook_notice(
    local_version: str,
    fetch: Optional[Callable[[str], str]] = None,
) -> str:
    """A loud notice when GitHub has a newer notebook than this copy, else "".

    This is what makes it safe to keep ONE saved copy of the notebook (so
    Colab/Kaggle remember its secret access and stop asking every time): the
    server code is downloaded fresh on every run anyway, and the notebook
    itself says when its own cells are out of date. Never raises.
    """
    try:
        text = (fetch or _http_get)(NOTEBOOK_RAW_URL)
    except Exception:  # noqa: BLE001 - no network or GitHub hiccup: say nothing
        return ""
    latest = notebook_version_in(text)
    if not latest or version_tuple(latest) <= version_tuple(local_version):
        return ""
    bar = "!" * 66
    return (
        f"\n{bar}\n"
        f"  A NEWER NOTEBOOK IS AVAILABLE: {latest} (this copy is {local_version}).\n"
        "  Everything still works, but some fixes need the new cells.\n"
        "  Open it from Admin -> Backends -> Open in Colab / Open in Kaggle,\n"
        "  then save that copy and use it from now on.\n"
        f"{bar}\n"
    )


def _http_get(url: str, timeout: int = 15) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310
        return r.read().decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# the run
# ---------------------------------------------------------------------------

def _log(msg: str) -> None:
    print(msg, flush=True)


def _fail(msg: str) -> None:
    _log("\n*** " + msg.replace("\n", "\n*** "))
    sys.exit(1)


def _check_environment() -> None:
    """Fail in one readable line instead of deep inside a model load."""
    import numpy as np
    import torch

    if not torch.cuda.is_available():
        _fail("No GPU. Colab: Runtime > Change runtime type > T4 GPU. "
              "Kaggle: Session options > Accelerator > GPU T4 x2.")
    _log(f"{torch.cuda.get_device_name(0)} | torch {torch.__version__} | numpy {np.__version__} "
         f"| py {sys.version_info.major}.{sys.version_info.minor}")
    if not numpy_in_range(np.__version__, sys.version_info >= (3, 13)):
        _fail(f"numpy {np.__version__} is outside the range the voice model needs.\n"
              "Runtime > Disconnect and delete runtime, then Run all on a fresh one.")
    # Where a mismatched numpy actually bites; import now so it is readable.
    import numba  # noqa: F401
    import scipy.special  # noqa: F401

    if not shutil.which("ffmpeg"):
        _fail("ffmpeg is missing - run: !apt-get -qq install -y ffmpeg")


def _start_server(app) -> None:
    import uvicorn

    threading.Thread(
        target=lambda: uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="error"),
        daemon=True,
    ).start()
    deadline = time.time() + 90
    while time.time() < deadline:
        try:
            _http_get(f"http://127.0.0.1:{PORT}/health", timeout=5)
            return
        except Exception:  # noqa: BLE001
            time.sleep(1)
    _fail(f"The server did not start on port {PORT} within 90 s.")


def _open_tunnel() -> Tuple[subprocess.Popen, str]:
    """A cloudflared quick tunnel. Tried three times: it occasionally fails."""
    for attempt in range(1, 4):
        proc = subprocess.Popen(
            ["cloudflared", "tunnel", "--url", f"http://localhost:{PORT}"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        found: List[str] = []

        def read(p=proc, out=found):
            for line in p.stdout:  # type: ignore[union-attr]
                url = tunnel_url(line)
                if url and not out:
                    out.append(url)
            # Keep draining afterwards so cloudflared never blocks on a full pipe.

        threading.Thread(target=read, daemon=True).start()
        deadline = time.time() + 60
        while time.time() < deadline and not found and proc.poll() is None:
            time.sleep(0.5)
        if found:
            return proc, found[0]
        proc.kill()
        _log(f"tunnel attempt {attempt} failed; retrying...")
    _fail("Could not open a tunnel (cloudflared). Re-run this cell.")
    raise AssertionError  # unreachable


def _minutes(value: Any) -> Optional[int]:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _stop_idle(app_url: str, token: str, payload: Dict[str, Any], minutes: int, tunnel) -> None:
    """Tell the app this backend is going away (it shows Offline at once and
    sends work elsewhere), then end the process. Cell 2 sees IDLE_EXIT_CODE
    and, on Colab, releases the GPU machine."""
    _log("\n" + "=" * 62)
    _log(f"  Nothing to do for {minutes} min: stopping to save your free GPU time.")
    _log("  Start it again (Run all) when you need it.")
    _log("=" * 62)
    goodbye = dict(payload)
    goodbye["status"] = {**(payload.get("status") or {}), "stopping": True}
    try:
        _register(app_url, token, goodbye)
    except Exception as e:  # noqa: BLE001 - the app ages it out anyway
        _log(f"  (could not tell the app: {e}; it shows Offline within a few minutes)")
    try:
        tunnel.kill()
    except Exception:  # noqa: BLE001
        pass
    sys.stdout.flush()
    os._exit(IDLE_EXIT_CODE)


def _register(app_url: str, token: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    req = urllib.request.Request(
        app_url.rstrip("/") + "/api/backends/register",
        data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Registration-Token": token},
    )
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
        return json.loads(r.read().decode())


def main() -> None:
    app_url = os.environ.get("VOICEFORGE_APP_URL", "").strip()
    token = os.environ.get("REGISTRATION_TOKEN", "").strip()
    provider = os.environ.get("VOICEFORGE_PROVIDER", "custom").strip() or "custom"
    if not app_url or not token:
        _fail("VOICEFORGE_APP_URL / REGISTRATION_TOKEN are not set. Run Cell 0 first.")

    t0 = time.time()
    _log("[1/4] checking the environment...")
    _check_environment()

    _log("[2/4] loading the voice models (2-4 min on a fresh session)...")
    sys.path.insert(0, os.getcwd())
    from backend.voiceforge_server import VERSION, apply_app_features, create_app, gpu_name, load_models

    models = load_models()
    _log(f"      models ready: {models}")

    _log("[3/4] starting the server and opening a tunnel...")
    app = create_app(provider=provider)
    _start_server(app)
    tunnel, public_url = _open_tunnel()
    _log(f"      tunnel: {public_url}")

    _log("[4/4] registering with your app...")
    heartbeat = 150
    idle_stop: Optional[int] = None
    try:
        payload = with_status(registration_payload(provider, public_url, gpu_name(), models, VERSION))
        result = _register(app_url, token, payload)
        heartbeat = int(result.get("heartbeat_seconds", heartbeat))
        idle_stop = _minutes(result.get("idle_stop_minutes"))
        _log("\n" + "=" * 62)
        _log("  REGISTERED - nothing to copy. Check Admin -> Backends.")
        _log(f"  provider: {provider}   heartbeat: every {heartbeat}s   ready in {time.time() - t0:.0f}s")
        _log("  " + apply_app_features(result.get("features")))
        if idle_stop:
            _log(f"  stops itself after {idle_stop} min with nothing to do (Admin -> Settings)")
        _log("=" * 62 + "\n")
        _log(status_line(provider, public_url, payload.get("status"), idle_stop))
    except Exception as e:  # noqa: BLE001
        _log(f"\n*** REGISTRATION FAILED: {e}")
        _log("*** Check VOICEFORGE_APP_URL and REGISTRATION_TOKEN in Cell 0.")
        _log(f"*** The backend is running: add {public_url} under Admin -> Backends -> Custom.")

    _log("Running. Keep this tab open while you generate; this cell never finishes.")
    while True:
        time.sleep(heartbeat)
        if tunnel.poll() is not None:
            # Quick tunnels sometimes drop. Open a new one and register its
            # URL, so the app follows without anyone noticing.
            _log("tunnel dropped; opening a new one...")
            tunnel, public_url = _open_tunnel()
            _log(f"      tunnel: {public_url}")
        try:
            payload = with_status(registration_payload(provider, public_url, gpu_name(), models, VERSION))
            result = _register(app_url, token, payload)
            # Carries the Admin -> Backends switches: turning AI video on
            # later starts its install within one heartbeat.
            apply_app_features(result.get("features"))
            idle_stop = _minutes(result.get("idle_stop_minutes"))
            _log(status_line(provider, public_url, payload.get("status"), idle_stop))
            if should_stop(payload.get("status"), idle_stop):
                _stop_idle(app_url, token, payload, idle_stop, tunnel)
        except Exception as e:  # noqa: BLE001
            _log(status_line(provider, public_url, None, idle_stop, ok=False, error=str(e)))


if __name__ == "__main__":
    main()
