"""
VoiceForge presenter backend — lip-synced clips from a recording.

Takes a short video of a presenter and a piece of narration, and returns the
same video with the mouth redrawn to match the narration. Everything outside
the mouth region is the original footage.

A separate app from the voice server on purpose. The engine (LatentSync)
pins its own torch, diffusers and numpy, which do not coexist with
Chatterbox's, and a presenter clip must never be able to break narration.
This file imports nothing from voiceforge_server.

The job protocol mirrors voiceforge_render so the gateway treats a presenter
clip like any other finished video:

POST   /render               -> 202; body: job_id, video_url, audio_url, ...
GET    /render/{id}          -> status, stage, progress
GET    /render/{id}/video    -> the finished MP4
DELETE /render/{id}          -> drop the file once it has been collected
GET    /health               -> capabilities: ["presenter-relip"]

Every call except /health and a token-carrying video GET needs the
X-Backend-Secret header.
"""

from __future__ import annotations

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
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse

PRESENTER_VERSION = "1.0.0"

# Where the LatentSync checkout lives. The engine resolves its configs and
# checkpoints relative to its own directory, so it is always run from there.
ENGINE_DIR = os.environ.get("VOICEFORGE_LATENTSYNC_DIR", "/opt/LatentSync")
# 1.6 is trained at 512 px and needs about 18 GB; 1.5 is 256 px and fits 8 GB.
# The config has to match the checkpoint, so both are set together.
UNET_CONFIG = os.environ.get("VOICEFORGE_LATENTSYNC_CONFIG", "configs/unet/stage2_512.yaml")
UNET_CKPT = os.environ.get("VOICEFORGE_LATENTSYNC_CKPT", "checkpoints/latentsync_unet.pt")
ENGINE_NAME = os.environ.get("VOICEFORGE_LATENTSYNC_NAME", "latentsync-1.6")

WORK_ROOT = os.environ.get("VOICEFORGE_PRESENTER_DIR", tempfile.gettempdir())
MAX_DOWNLOAD = 200 * 1024 * 1024
DOWNLOAD_TIMEOUT = 120
# A presenter clip is an intro or an outro, not a narration. The cap keeps a
# mistaken request from holding a paid GPU for an hour.
MAX_AUDIO_SECONDS = float(os.environ.get("VOICEFORGE_PRESENTER_MAX_SECONDS", "90"))
ENGINE_TIMEOUT = 60 * 25

RENDERS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()
_GPU_LOCK = threading.Lock()  # one clip at a time: a single GPU


# ---------------------------------------------------------------------------
# pure helpers (unit-tested — no torch, no GPU)
# ---------------------------------------------------------------------------

def clamp_steps(value: Any, default: int = 20) -> int:
    """Denoising steps. The engine's documented range is 20-50."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(10, min(50, n))


def clamp_guidance(value: Any, default: float = 1.5) -> float:
    """Guidance scale. Documented range 1.0-3.0: higher follows the audio
    more closely and starts to jitter."""
    try:
        g = float(value)
    except (TypeError, ValueError):
        return default
    return max(1.0, min(3.0, g))


def engine_command(
    video: str, audio: str, out: str, steps: int, guidance: float, seed: int, temp_dir: str
) -> List[str]:
    """The exact call the engine's own inference.sh makes."""
    return [
        "python", "-m", "scripts.inference",
        "--unet_config_path", UNET_CONFIG,
        "--inference_ckpt_path", UNET_CKPT,
        "--inference_steps", str(steps),
        "--guidance_scale", str(guidance),
        "--enable_deepcache",
        "--seed", str(seed),
        "--temp_dir", temp_dir,
        "--video_path", video,
        "--audio_path", audio,
        "--video_out_path", out,
    ]


def extension_of(url: str, fallback: str) -> str:
    tail = url.split("?")[0].rsplit("/", 1)[-1]
    ext = tail.rsplit(".", 1)[-1].lower() if "." in tail else ""
    return f".{ext}" if 1 <= len(ext) <= 5 and ext.isalnum() else fallback


def tail_of(text: str, limit: int = 600) -> str:
    """The end of an engine log — where the actual error is."""
    text = (text or "").strip()
    return text[-limit:] if len(text) > limit else text


# ---------------------------------------------------------------------------
# media helpers
# ---------------------------------------------------------------------------

def _download(url: str, dest: str) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": f"voiceforge-presenter/{PRESENTER_VERSION}"}
    )
    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as r, open(dest, "wb") as f:  # noqa: S310
        size = 0
        while chunk := r.read(262144):
            size += len(chunk)
            if size > MAX_DOWNLOAD:
                raise ValueError("input file is too large")
            f.write(chunk)
    return dest


def _probe_seconds(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, timeout=60,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def _ffmpeg(args: List[str], timeout: int = 600) -> None:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True, text=True, timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {tail_of(proc.stderr, 400)}")


def _gpu_name() -> str:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=15,
        )
        return out.stdout.strip().splitlines()[0] if out.returncode == 0 else "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


# ---------------------------------------------------------------------------
# worker
# ---------------------------------------------------------------------------

def _set(job_id: str, **patch: Any) -> None:
    with _LOCK:
        if job_id in RENDERS:
            RENDERS[job_id].update(patch)


def _run_presenter(req: Dict[str, Any]) -> None:
    job_id = req["job_id"]
    work = tempfile.mkdtemp(prefix="vfp-", dir=WORK_ROOT)
    t0 = time.time()

    try:
        with _GPU_LOCK:
            _set(job_id, status="running", stage="fetching", progress=2)

            src_video = _download(
                req["video_url"], os.path.join(work, "src" + extension_of(req["video_url"], ".mp4"))
            )
            src_audio = _download(
                req["audio_url"], os.path.join(work, "src" + extension_of(req["audio_url"], ".wav"))
            )

            audio_seconds = _probe_seconds(src_audio)
            if audio_seconds <= 0:
                raise ValueError("could not read the audio")
            if audio_seconds > MAX_AUDIO_SECONDS:
                raise ValueError(
                    f"the audio is {audio_seconds:.0f}s; a presenter clip is limited to "
                    f"{MAX_AUDIO_SECONDS:.0f}s"
                )

            # The engine works at 25 fps and reads 16 kHz speech. Normalising
            # here means its own resampling has nothing left to guess, and a
            # phone recording in a variable frame rate cannot drift out of sync.
            _set(job_id, stage="preparing", progress=8)
            video = os.path.join(work, "in.mp4")
            _ffmpeg([
                "-i", src_video, "-an", "-r", "25",
                # The engine holds every frame in memory at once. It only ever
                # needs as much footage as there is audio (it loops a shorter
                # recording itself), and the face it redraws is 512 px, so a
                # 1280 px frame loses nothing that survives to the result.
                "-t", f"{audio_seconds + 0.5:.2f}",
                "-vf", "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
                "-pix_fmt", "yuv420p", video,
            ])
            audio = os.path.join(work, "in.wav")
            _ffmpeg(["-i", src_audio, "-ac", "1", "-ar", "16000", audio])

            _set(job_id, stage="lip-syncing", progress=15)
            out = os.path.join(work, f"{job_id}.mp4")
            cmd = engine_command(
                video, audio, out,
                clamp_steps(req.get("steps")),
                clamp_guidance(req.get("guidance")),
                int(req.get("seed") or 1247),
                os.path.join(work, "tmp"),
            )
            t_engine = time.time()
            proc = subprocess.run(
                cmd, cwd=ENGINE_DIR, capture_output=True, text=True, timeout=ENGINE_TIMEOUT
            )
            engine_seconds = round(time.time() - t_engine, 2)
            if proc.returncode != 0 or not os.path.exists(out):
                # The engine prints its traceback to stderr and its progress
                # to stdout; the reason is at the end of one or the other.
                raise RuntimeError(
                    "the lip-sync engine failed: "
                    + tail_of(proc.stderr or proc.stdout, 900)
                )

            # The engine writes 16 kHz mono speech into the result. Put the
            # narration back at its original quality instead: the mouth was
            # timed to it, so the sync is identical and the sound is not
            # downgraded on the way through.
            _set(job_id, stage="finishing", progress=94)
            final = os.path.join(work, f"{job_id}-final.mp4")
            _ffmpeg([
                "-i", out, "-i", src_audio,
                "-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-shortest", "-movflags", "+faststart", final,
            ])

            _set(
                job_id,
                status="done", stage="done", progress=100,
                path=final, work=work,
                duration=round(_probe_seconds(final), 2),
                bytes=os.path.getsize(final),
                gen_seconds=round(time.time() - t0, 2),
                engine=ENGINE_NAME,
                engine_seconds=engine_seconds,
                audio_seconds=round(audio_seconds, 2),
                gpu=_gpu_name(),
            )

    except Exception as e:  # noqa: BLE001
        shutil.rmtree(work, ignore_errors=True)
        print("[presenter]", job_id, "failed:", e, traceback.format_exc()[-1500:], flush=True)
        _set(job_id, status="error", error=str(e)[:900], progress=100)

    # Tell the gateway either way; it collects the file with a GET.
    callback = req.get("callback_url")
    if callback:
        with _LOCK:
            job = dict(RENDERS.get(job_id) or {})
        payload = {
            "job_id": job_id,
            "kind": "presenter",
            "status": job.get("status", "error"),
            "duration": job.get("duration"),
            "gen_seconds": job.get("gen_seconds"),
            "bytes": job.get("bytes"),
            "error": job.get("error"),
            "diagnostics": {
                "engine": job.get("engine"),
                "engine_seconds": job.get("engine_seconds"),
                "audio_seconds": job.get("audio_seconds"),
                "gpu": job.get("gpu"),
            },
        }
        # The gateway validates this body and treats a null as a wrong type,
        # not as "absent" — so fields that have no value are left out.
        payload["diagnostics"] = {k: v for k, v in payload["diagnostics"].items() if v is not None}
        payload = {k: v for k, v in payload.items() if v is not None}
        try:
            r = urllib.request.Request(
                callback, data=json.dumps(payload).encode(), method="POST",
                headers={"Content-Type": "application/json",
                         "X-Callback-Token": req.get("callback_token", "")},
            )
            with urllib.request.urlopen(r, timeout=60) as resp:  # noqa: S310
                resp.read()
        except Exception as e:  # noqa: BLE001
            print("[presenter] callback failed:", e, flush=True)


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

def create_presenter_router(check_secret) -> APIRouter:
    router = APIRouter()

    @router.post("/render", status_code=202)
    async def start(request: Request, x_backend_secret: Optional[str] = Header(None)) -> dict:
        check_secret(x_backend_secret)
        req = await request.json()
        for field in ("video_url", "audio_url"):
            value = str(req.get(field) or "")
            if not value.startswith("https://"):
                raise HTTPException(status_code=400, detail=f"{field} must be an https URL")
        job_id = str(req.get("job_id") or uuid.uuid4().hex)
        req["job_id"] = job_id
        with _LOCK:
            RENDERS[job_id] = {
                "status": "queued",
                "stage": "queued",
                "progress": 0,
                "token": str(req.get("callback_token") or ""),
            }
        threading.Thread(target=_run_presenter, args=(req,), daemon=True).start()
        return {"accepted": True, "job_id": job_id}

    @router.get("/render/{job_id}")
    def status(job_id: str, x_backend_secret: Optional[str] = Header(None)) -> dict:
        check_secret(x_backend_secret)
        with _LOCK:
            job = RENDERS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="unknown render")
        # Never leak local paths to the caller.
        return {k: v for k, v in job.items() if k not in ("path", "work", "token")}

    @router.get("/render/{job_id}/video")
    def video(
        job_id: str,
        token: Optional[str] = None,
        x_backend_secret: Optional[str] = Header(None),
    ):
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


def create_presenter_app(provider: str = "custom"):
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="VoiceForge presenter", version=PRESENTER_VERSION)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    def check(secret: Optional[str]) -> None:
        expected = os.environ.get("BACKEND_SECRET")
        if expected and secret != expected:
            raise HTTPException(status_code=401, detail="bad backend secret")

    @app.get("/health")
    def health() -> dict:
        with _LOCK:
            busy = any(j.get("status") == "running" for j in RENDERS.values())
        engine_ready = os.path.isdir(ENGINE_DIR) and os.path.exists(
            os.path.join(ENGINE_DIR, UNET_CKPT)
        )
        return {
            "ok": True,
            "provider": provider,
            # Only claimed when the engine and its weights are really there —
            # a capability is a promise the gateway routes work on.
            "capabilities": ["presenter-relip"] if engine_ready else [],
            "engine": ENGINE_NAME,
            "version": PRESENTER_VERSION,
            "busy": busy,
            "gpu": _gpu_name(),
        }

    app.include_router(create_presenter_router(check))
    return app
