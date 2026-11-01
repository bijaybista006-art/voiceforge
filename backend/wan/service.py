"""
Wan 2.2 TI2V-5B — the HTTP service. Text in, MP4 clip out.

The job protocol mirrors backend/voiceforge_presenter.py, so the gateway
collects a clip exactly like a presenter clip (the 4.5 MB rule: the video is
never in a request body; the gateway GETs it, then DELETEs our copy):

POST   /render               -> 202 {job_id}; body: prompt + options, callback_url/token
GET    /render/{id}          -> status, stage, progress, settings
GET    /render/{id}/video    -> the finished MP4 (secret header, or the job's callback token)
DELETE /render/{id}          -> drop the file once collected
GET    /health               -> capabilities: ["text-to-video"] once ready, plus limits

Every call except /health and a token-carrying video GET needs X-Backend-Secret.

Hosts:
  * Modal  - standalone app (create_wan_app), engine in-process, model loaded
             once per container. See modal/voiceforge_wan.py.
  * Colab / Kaggle - mounted under /wan in the voice server, engine run as a
             subprocess in a private virtualenv (see install.py).

No torch at module level: this file is imported by the notebook's Python and
by CI.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.request
import uuid
from typing import Any, Callable, Dict, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse

try:
    from . import install
    from . import settings as S
except ImportError:  # loaded as a top-level module
    import install  # type: ignore[no-redef]
    import settings as S  # type: ignore[no-redef]

WORK_ROOT = os.environ.get("VOICEFORGE_WAN_WORK", tempfile.gettempdir())
ENGINE_TIMEOUT = 60 * 90  # a 720p clip on a T4 can take most of an hour

RENDERS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()  # guards RENDERS
_GPU_LOCK = threading.Lock()  # one clip at a time

_CONFIG: Dict[str, Any] = {
    "provider": "custom",
    "shared_lock": None,  # the voice server's GPU lock, when we share its GPU
    "before_engine": None,  # e.g. torch.cuda.empty_cache in the voice process
    # Shared with the presenter engine in the same notebook, so the two never
    # load onto the same (second Kaggle) GPU at once.
    "engine_lock": None,
}


def configure(
    provider: str,
    shared_lock: Optional[Any] = None,
    before_engine: Optional[Callable[[], None]] = None,
    engine_lock: Optional[Any] = None,
) -> None:
    _CONFIG.update(provider=provider, shared_lock=shared_lock, before_engine=before_engine, engine_lock=engine_lock)


def _in_process() -> bool:
    """Modal runs the engine in this process; notebooks run it in the virtualenv."""
    return _CONFIG["provider"] == "modal"


def profile() -> str:
    return S.profile_for(_CONFIG["provider"])


def is_ready() -> bool:
    return install.weights_ready() if _in_process() else install.engine_ready()


# ---------------------------------------------------------------------------
# GPU facts without importing torch
# ---------------------------------------------------------------------------

def _nvidia_smi(query: str) -> list:
    try:
        out = subprocess.run(
            ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10,
        )
        return [line.strip() for line in out.stdout.splitlines() if line.strip()]
    except Exception:  # noqa: BLE001
        return []


def _gpu_name() -> str:
    names = _nvidia_smi("name")
    return names[-1] if names else "unknown"


def _engine_env() -> Dict[str, str]:
    """Environment for the subprocess engine. On a two-GPU Kaggle session it
    gets the second card to itself, so narration and video never collide."""
    env = install._clean_env()
    gpus = _nvidia_smi("name")
    if len(gpus) > 1:
        env["CUDA_VISIBLE_DEVICES"] = str(len(gpus) - 1)
    return env


def _shares_gpu_with_voice() -> bool:
    return _CONFIG["shared_lock"] is not None and len(_nvidia_smi("name")) <= 1


# ---------------------------------------------------------------------------
# worker
# ---------------------------------------------------------------------------

def _set(job_id: str, **patch: Any) -> None:
    with _LOCK:
        if job_id in RENDERS:
            RENDERS[job_id].update(patch)


def _keep_awake(job_id: str, self_url: str) -> None:
    """Keep a scale-to-zero container busy while a clip renders.

    The work runs in a thread and the host judges idleness by requests, so a
    request to our own /health every 40 s stops it scaling down mid-clip.
    """
    while True:
        time.sleep(40)
        with _LOCK:
            status = (RENDERS.get(job_id) or {}).get("status")
        if status not in ("queued", "running"):
            return
        try:
            with urllib.request.urlopen(f"{self_url}/health", timeout=20) as r:  # noqa: S310
                r.read()
        except Exception:  # noqa: BLE001
            pass


def _progress(job_id: str, step: int, total: int) -> None:
    # 5% for loading, 90% for denoising, the rest for encoding the MP4.
    _set(job_id, progress=min(95, 5 + int(90 * step / max(total, 1))), stage=f"generating ({step}/{total})")


def _run_in_process(job_id: str, settings: Dict[str, Any], out_path: str) -> Dict[str, Any]:
    try:
        from . import engine
    except ImportError:
        import engine  # type: ignore[no-redef]

    _set(job_id, stage="loading the model")
    pipe, load_seconds = engine.load_pipeline(install.model_dir(), S.PROFILES[settings["profile"]])
    gen_seconds = engine.generate(pipe, settings, out_path, on_progress=lambda s, t: _progress(job_id, s, t))
    return {"load_seconds": load_seconds, "gen_seconds": gen_seconds, "gpu": engine.gpu_name()}


def _run_subprocess(job_id: str, settings: Dict[str, Any], out_path: str, work: str) -> Dict[str, Any]:
    req_path = os.path.join(work, "request.json")
    with open(req_path, "w", encoding="utf-8") as f:
        json.dump({
            "model_path": install.model_dir(),
            "profile": S.PROFILES[settings["profile"]],
            "settings": settings,
            "out_path": out_path,
        }, f)
    engine_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine.py")
    log_path = os.path.join(work, "engine.log")
    result: Dict[str, Any] = {}

    with open(log_path, "w", encoding="utf-8") as log:
        proc = subprocess.Popen(
            [install.venv_python(), engine_file, req_path],
            stdout=subprocess.PIPE, stderr=log, text=True, env=_engine_env(),
        )
        killer = threading.Timer(ENGINE_TIMEOUT, proc.kill)
        killer.start()
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                try:
                    event = json.loads(line)
                except ValueError:
                    continue  # library chatter, not one of our events
                kind = event.get("event")
                if kind == "stage":
                    _set(job_id, stage=event.get("stage", ""))
                elif kind == "progress":
                    _progress(job_id, int(event.get("step", 0)), int(event.get("total", 1)))
                elif kind in ("done", "error"):
                    result = event
            proc.wait()
        finally:
            killer.cancel()

    if result.get("event") == "done" and proc.returncode == 0:
        facts = {k: result.get(k) for k in ("load_seconds", "gen_seconds", "gpu", "peak_vram_gb")}
        print(f"[wan] {job_id[:8]} done in {facts.get('gen_seconds')}s, peak GPU memory "
              f"{facts.get('peak_vram_gb')} GB on {facts.get('gpu')}", flush=True)
        return facts
    if result.get("error"):
        raise RuntimeError(result["error"])
    with open(log_path, encoding="utf-8", errors="replace") as f:
        tail = f.read()[-700:]
    if proc.returncode in (-9, 137):
        raise RuntimeError(f"the engine was stopped (timeout or out of RAM). {tail}")
    raise RuntimeError(f"the engine exited with code {proc.returncode}: {tail}")


def _run_clip(req: Dict[str, Any]) -> None:
    job_id = req["job_id"]
    settings = req["_settings"]
    work = tempfile.mkdtemp(prefix="vfw-", dir=WORK_ROOT)
    out_path = os.path.join(work, f"{job_id}.mp4")
    if req.get("_self_url"):
        threading.Thread(target=_keep_awake, args=(job_id, req["_self_url"]), daemon=True).start()

    try:
        _set(job_id, stage="waiting for the GPU")
        shared = _CONFIG["shared_lock"] if _shares_gpu_with_voice() else None
        # Lock order everywhere: own lock, engine lock, then the voice lock.
        with _GPU_LOCK, (_CONFIG["engine_lock"] or contextlib.nullcontext()), (shared or contextlib.nullcontext()):
            if shared is not None and _CONFIG["before_engine"]:
                with contextlib.suppress(Exception):
                    _CONFIG["before_engine"]()
            _set(job_id, status="running", stage="starting", progress=1, started_at=time.time())
            if _in_process():
                facts = _run_in_process(job_id, settings, out_path)
            else:
                facts = _run_subprocess(job_id, settings, out_path, work)

        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise RuntimeError("the engine finished without writing a video")
        _set(
            job_id, status="done", stage="done", progress=100,
            path=out_path, work=work, bytes=os.path.getsize(out_path),
            duration=settings["duration"], gen_seconds=facts.get("gen_seconds"),
            load_seconds=facts.get("load_seconds"), gpu=facts.get("gpu") or _gpu_name(),
            peak_vram_gb=facts.get("peak_vram_gb"),
        )
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(work, ignore_errors=True)
        print("[wan]", job_id, "failed:", e, traceback.format_exc()[-1200:], flush=True)
        _set(job_id, status="error", stage="error", progress=100, error=str(e)[:900],
             oom=str(e).startswith(S.OOM_PREFIX))

    _send_callback(req)


def _send_callback(req: Dict[str, Any]) -> None:
    """Tell the gateway either way; it collects the file with a GET."""
    callback = req.get("callback_url")
    if not callback:
        return
    with _LOCK:
        job = dict(RENDERS.get(req["job_id"]) or {})
    payload: Dict[str, Any] = {
        "job_id": req["job_id"],
        "kind": "clip",
        "status": job.get("status", "error"),
        "duration": job.get("duration"),
        "gen_seconds": job.get("gen_seconds"),
        "bytes": job.get("bytes"),
        "error": job.get("error"),
        "settings": job.get("settings"),
        "diagnostics": {
            "gpu": job.get("gpu"),
            "load_seconds": job.get("load_seconds"),
            "oom": job.get("oom"),
            "peak_vram_gb": job.get("peak_vram_gb"),
        },
    }
    # The gateway treats null as a wrong type, not "absent": leave empties out.
    payload["diagnostics"] = {k: v for k, v in payload["diagnostics"].items() if v is not None}
    payload = {k: v for k, v in payload.items() if v is not None}
    try:
        r = urllib.request.Request(
            callback, data=json.dumps(payload).encode(), method="POST",
            headers={"Content-Type": "application/json", "X-Callback-Token": req.get("callback_token", "")},
        )
        with urllib.request.urlopen(r, timeout=60) as resp:  # noqa: S310
            resp.read()
    except Exception as e:  # noqa: BLE001 - completion never depends on the callback
        print("[wan] callback failed:", e, flush=True)


def warm_up_in_background() -> None:
    """Modal: load the pipeline while the container boots, so the first clip
    does not pay for it on top of its own render. Holds the GPU lock, so a
    job that arrives meanwhile simply waits for the load to finish."""
    if not (_in_process() and is_ready()):
        return

    def go() -> None:
        try:
            try:
                from . import engine
            except ImportError:
                import engine  # type: ignore[no-redef]
            with _GPU_LOCK:
                _, seconds = engine.load_pipeline(install.model_dir(), S.PROFILES[profile()])
            print(f"[wan] model loaded in {seconds}s on {_gpu_name()}", flush=True)
        except Exception as e:  # noqa: BLE001 - the first job reports it properly
            print("[wan] warm-up failed:", e, flush=True)

    threading.Thread(target=go, daemon=True).start()


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

def health_report() -> Dict[str, Any]:
    with _LOCK:
        busy = any(j.get("status") in ("queued", "running") for j in RENDERS.values())
    ready = is_ready()
    report: Dict[str, Any] = {
        "ok": True,
        "provider": _CONFIG["provider"],
        # Only claimed when the engine and weights are really there: a
        # capability is a promise the gateway routes work on.
        "capabilities": [S.CAPABILITY] if ready else [],
        "model": S.MODEL_ID,
        "profile": profile(),
        "limits": S.limits(profile()),
        "version": S.WAN_VERSION,
        "busy": busy,
        "gpu": _gpu_name(),
    }
    if not _in_process() and install.INSTALL["state"] != "idle":
        report["install"] = dict(install.INSTALL)
    if _in_process() and not ready:
        report["install"] = {"state": "missing", "error": "weights not downloaded: run the download function"}
    return report


def create_wan_router(
    check_secret: Callable[[Optional[str]], None],
    provider: str = "custom",
    shared_lock: Optional[Any] = None,
    before_engine: Optional[Callable[[], None]] = None,
    engine_lock: Optional[Any] = None,
) -> APIRouter:
    """Routes, including /health. Mount at the root (Modal) or under /wan (a
    notebook, where the voice server already owns /render and /health)."""
    configure(provider, shared_lock=shared_lock, before_engine=before_engine, engine_lock=engine_lock)
    router = APIRouter()

    @router.get("/health")
    def health() -> dict:
        return health_report()

    @router.post("/render", status_code=202)
    async def start(request: Request, x_backend_secret: Optional[str] = Header(None)) -> dict:
        check_secret(x_backend_secret)
        req = await request.json()
        if not isinstance(req, dict):
            raise HTTPException(status_code=400, detail="body must be a JSON object")
        try:
            settings = S.build_settings(req, profile())
        except S.SettingsError as e:
            raise HTTPException(status_code=400, detail=str(e)) from None
        if not is_ready():
            # Refuse up front so the gateway moves on to another backend.
            raise HTTPException(status_code=503, detail="the video engine is not ready here")

        job_id = str(req.get("job_id") or uuid.uuid4().hex)
        req.update(job_id=job_id, _settings=settings)
        # Our public address as the caller reached us (includes a /wan mount),
        # used only to keep the container awake for the length of the job.
        host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
        path = request.url.path
        mount = path[: -len("/render")] if path.endswith("/render") else ""
        req["_self_url"] = f"https://{host}{mount}" if host and "localhost" not in host else ""
        with _LOCK:
            RENDERS[job_id] = {
                "status": "queued",
                "stage": "queued",
                "progress": 0,
                "settings": settings,
                "token": str(req.get("callback_token") or ""),
            }
        threading.Thread(target=_run_clip, args=(req,), daemon=True).start()
        return {"accepted": True, "job_id": job_id, "settings": settings}

    @router.get("/render/{job_id}")
    def status(job_id: str, x_backend_secret: Optional[str] = Header(None)) -> dict:
        check_secret(x_backend_secret)
        with _LOCK:
            job = RENDERS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="unknown render")
        return {k: v for k, v in job.items() if k not in ("path", "work", "token")}

    @router.get("/render/{job_id}/video")
    def video(job_id: str, token: Optional[str] = None, x_backend_secret: Optional[str] = Header(None)):
        with _LOCK:
            job = RENDERS.get(job_id)
        expected = (job or {}).get("token")
        if not (token and expected and token == expected):
            check_secret(x_backend_secret)
        if not job or job.get("status") != "done":
            raise HTTPException(status_code=404, detail="render not finished")
        path = job.get("path")
        if not path or not os.path.exists(path):
            raise HTTPException(status_code=410, detail="file already collected")
        return FileResponse(path, media_type="video/mp4", filename=f"{job_id}.mp4")

    @router.delete("/render/{job_id}")
    def delete(job_id: str, x_backend_secret: Optional[str] = Header(None)) -> dict:
        check_secret(x_backend_secret)
        with _LOCK:
            job = RENDERS.pop(job_id, None)
        if job and job.get("work"):
            shutil.rmtree(job["work"], ignore_errors=True)
        return {"ok": True}

    return router


def create_wan_app(provider: str = "custom"):
    """Standalone app: used by the Modal function."""
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="VoiceForge video (Wan 2.2)", version=S.WAN_VERSION)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    def check(secret: Optional[str]) -> None:
        expected = os.environ.get("BACKEND_SECRET")
        if expected and secret != expected:
            raise HTTPException(status_code=401, detail="bad backend secret")

    app.include_router(create_wan_router(check, provider=provider))
    warm_up_in_background()
    return app
