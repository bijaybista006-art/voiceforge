"""
VoiceForge presenter backend — lip-synced clips from a recording.

Takes a short video of a presenter and a piece of narration, and returns the
same video with the mouth redrawn to match the narration. Everything outside
the mouth region is the original footage.

Separate from the voice server on purpose. The engine (LatentSync) pins its
own torch, diffusers and numpy, which do not coexist with Chatterbox's, and a
presenter clip must never be able to break narration. This file imports
nothing from voiceforge_server and never imports torch: the engine always
runs as a subprocess, in its own Python.

It runs in two places:
  * Modal — its own function and image, with the engine baked in.
  * A Colab or Kaggle notebook — mounted into the voice server under
    /presenter, with the engine installed into a private virtualenv in the
    background after the notebook starts (see start_install_in_background).

The job protocol mirrors voiceforge_render so the gateway treats a presenter
clip like any other finished video:

POST   /render               -> 202; body: job_id, video_url, audio_url, ...
GET    /render/{id}          -> status, stage, progress
GET    /render/{id}/video    -> the finished MP4
DELETE /render/{id}          -> drop the file once it has been collected
GET    /health               -> capabilities: ["presenter-relip"] once ready

Every call except /health and a token-carrying video GET needs the
X-Backend-Secret header.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import uuid
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse

PRESENTER_VERSION = "1.1.0"

# Pinned so a change upstream cannot alter results between two sessions. The
# Modal image pins the same commit.
LATENTSYNC_REPO = "https://github.com/bytedance/LatentSync.git"
LATENTSYNC_COMMIT = "a229c3948406bc2cf6eaf4873e662e70c6a04746"

# Where the LatentSync checkout lives and which Python runs it. The engine
# resolves its configs and checkpoints relative to its own directory, so it is
# always run from there. Both are replaced once a notebook install finishes.
ENGINE_DIR = os.environ.get("VOICEFORGE_LATENTSYNC_DIR", "/opt/LatentSync")
ENGINE_PYTHON = os.environ.get("VOICEFORGE_LATENTSYNC_PYTHON", "python")

# The config has to match the checkpoint, so they travel as a pair.
#   1.6 — trained at 512 px, needs about 18 GB. Sharper. Does not fit a T4.
#   1.5 — 256 px, fits in 8 GB. What a free 16 GB notebook GPU can run.
# Listed best first: with both installed, the first is the default.
ENGINES: Dict[str, Dict[str, str]] = {
    "latentsync-1.6": {
        "config": "configs/unet/stage2_512.yaml",
        "ckpt": "checkpoints/latentsync_unet.pt",
    },
    "latentsync-1.5": {
        "config": "configs/unet/stage2.yaml",
        "ckpt": "checkpoints/v15/latentsync_unet.pt",
    },
}
PREFERRED_ENGINE = os.environ.get("VOICEFORGE_LATENTSYNC_NAME", "").strip()

WORK_ROOT = os.environ.get("VOICEFORGE_PRESENTER_DIR", tempfile.gettempdir())
MAX_DOWNLOAD = 200 * 1024 * 1024
DOWNLOAD_TIMEOUT = 120
# A presenter clip is an intro or an outro, not a narration. The cap keeps a
# mistaken request from holding a GPU for an hour.
MAX_AUDIO_SECONDS = float(os.environ.get("VOICEFORGE_PRESENTER_MAX_SECONDS", "90"))
ENGINE_TIMEOUT = 60 * 40

RENDERS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()
_GPU_LOCK = threading.Lock()  # one clip at a time

# Set when this service shares a process with the voice server (a notebook).
# On a single GPU the two must not run at once: the voice models already hold
# several GB and the engine needs eight more.
_SHARED_GPU_LOCK: Optional[Any] = None
_BEFORE_ENGINE: Optional[Callable[[], None]] = None


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


def installed_engines(engine_dir: Optional[str] = None) -> List[str]:
    """Engines whose checkpoint is actually on disk, best first."""
    root = engine_dir if engine_dir is not None else ENGINE_DIR
    return [
        name for name, cfg in ENGINES.items()
        if os.path.exists(os.path.join(root, cfg["ckpt"]))
    ]


def pick_engine(requested: Any, available: List[str], preferred: str = "") -> Optional[str]:
    """Which engine a job runs on.

    The request's choice if that engine is installed, otherwise this
    backend's configured preference, otherwise the best one installed. A
    request for an engine that is not here is not an error: a notebook has
    only the small one, and the caller wanted a clip, not a particular file.
    """
    wanted = str(requested or "").strip()
    if wanted in available:
        return wanted
    if preferred in available:
        return preferred
    return available[0] if available else None


def engine_command(
    engine: str,
    video: str,
    audio: str,
    out: str,
    steps: int,
    guidance: float,
    seed: int,
    temp_dir: str,
    python: Optional[str] = None,
) -> List[str]:
    """The exact call the engine's own inference.sh makes."""
    cfg = ENGINES[engine]
    return [
        python or ENGINE_PYTHON, "-m", "scripts.inference",
        "--unet_config_path", cfg["config"],
        "--inference_ckpt_path", cfg["ckpt"],
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


def parse_sync_report(text: str) -> Optional[Dict[str, float]]:
    """Read the two numbers out of the engine's sync evaluation.

    It prints "SyncNet confidence: 7.90" and "AV offset: -1". Confidence is
    how clearly the mouth and the sound agree (roughly: below 3 is visibly
    off, above 6 is good). Offset is in frames at 25 fps, so 1 is 40 ms.
    """
    import re

    conf = re.search(r"SyncNet confidence:\s*(-?\d+(?:\.\d+)?)", text or "")
    off = re.search(r"AV offset:\s*(-?\d+)", text or "")
    if not conf or not off:
        return None
    return {"confidence": round(float(conf.group(1)), 2), "offset_frames": int(off.group(1))}


def engine_gpu_index(gpu_count: int, override: Optional[str] = None) -> Optional[str]:
    """Which GPU the engine should see, as a CUDA_VISIBLE_DEVICES value.

    Kaggle offers two T4s and the voice server only ever uses the first. When
    there is a second, the engine takes it, so a clip neither waits for
    narration nor competes with it for memory. With one GPU this returns None
    and the engine shares it, one job at a time.
    """
    if override not in (None, ""):
        return str(override)
    return "1" if gpu_count > 1 else None


# ---------------------------------------------------------------------------
# media and system helpers
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


def _gpus() -> List[str]:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=15,
        )
        if out.returncode != 0:
            return []
        return [line.strip() for line in out.stdout.splitlines() if line.strip()]
    except Exception:  # noqa: BLE001
        return []


def _gpu_name() -> str:
    gpus = _gpus()
    if not gpus:
        return "unknown"
    return gpus[0] if len(gpus) == 1 else f"{len(gpus)}x {gpus[0]}"


def _engine_env() -> Dict[str, str]:
    env = _clean_env()
    index = engine_gpu_index(len(_gpus()), os.environ.get("VOICEFORGE_PRESENTER_GPU"))
    if index is not None:
        env["CUDA_VISIBLE_DEVICES"] = index
    return env


def _shares_gpu_with_voice() -> bool:
    return _SHARED_GPU_LOCK is not None and engine_gpu_index(
        len(_gpus()), os.environ.get("VOICEFORGE_PRESENTER_GPU")
    ) is None


def _measure_sync(path: str, work: str) -> Dict[str, Any]:
    """Score a clip's lip-sync with the engine's own SyncNet evaluation.

    "Is it in sync" is otherwise something only a person watching can say.
    This puts a number on it, so a bad result can be told apart from a
    correct result that merely looks odd. Never fatal: a clip that cannot be
    scored is still a clip.
    """
    try:
        proc = subprocess.run(
            [ENGINE_PYTHON, "-m", "eval.eval_sync_conf", "--video_path", path,
             "--temp_dir", os.path.join(work, "sync-tmp")],
            cwd=ENGINE_DIR, env=_engine_env(), capture_output=True, text=True, timeout=600,
        )
        report = parse_sync_report(proc.stdout)
        if report:
            return report
        return {"error": tail_of(proc.stderr or proc.stdout, 300)}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:300]}


# ---------------------------------------------------------------------------
# installing the engine inside a notebook session
# ---------------------------------------------------------------------------
#
# Modal bakes the engine into its image. A notebook has nothing but the voice
# server's own environment, which the engine cannot share, so it is installed
# here: a checkout, a private virtualenv, and the weights. It takes several
# minutes and several GB, so it runs in a background thread after the voice
# server is already answering. Until it finishes this service reports no
# capability and the gateway sends presenter work elsewhere.

INSTALL_ROOT = os.environ.get("VOICEFORGE_PRESENTER_ROOT", "/tmp/voiceforge-presenter")
INSTALL: Dict[str, Any] = {"state": "idle", "stage": "", "error": "", "seconds": 0}
_INSTALL_STARTED = threading.Event()

_WEIGHTS_SCRIPT = r'''
import os, sys, urllib.request, zipfile
from huggingface_hub import hf_hub_download, snapshot_download

ckpt = sys.argv[1]
# 1.5: the checkpoint that fits a 16 GB GPU.
hf_hub_download("ByteDance/LatentSync-1.5", "latentsync_unet.pt", local_dir=os.path.join(ckpt, "v15"))
for name in ("whisper/tiny.pt", "auxiliary/sfd_face.pth", "auxiliary/syncnet_v2.model"):
    hf_hub_download("ByteDance/LatentSync-1.5", name, local_dir=ckpt)
snapshot_download("stabilityai/sd-vae-ft-mse")
models = os.path.join(ckpt, "auxiliary", "models")
target = os.path.join(models, "buffalo_l")
if not os.path.isdir(target):
    os.makedirs(models, exist_ok=True)
    archive = os.path.join(models, "buffalo_l.zip")
    urllib.request.urlretrieve(
        "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip", archive)
    with zipfile.ZipFile(archive) as z:
        z.extractall(target)
    os.remove(archive)
print("weights ready")
'''


# The engine's own setup script creates a Python 3.10 environment, and that is
# what the Modal image uses. A notebook's Python is whatever the host ships —
# newer, and with host-specific startup hooks — and the engine's pinned
# libraries have no builds for it.
ENGINE_PYTHON_VERSION = "3.10"


def _clean_env() -> Dict[str, str]:
    """The notebook's environment minus what would leak its Python into ours.

    Kaggle sets PYTHONPATH to a directory holding a sitecustomize that imports
    packages the engine's environment does not have, which made every Python
    start-up in the new environment print an error.
    """
    env = dict(os.environ)
    for name in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "VIRTUAL_ENV", "PIP_REQUIRE_VIRTUALENV"):
        env.pop(name, None)
    return env


def _step(stage: str, cmd: List[str], cwd: Optional[str] = None, timeout: int = 60 * 45) -> None:
    INSTALL["stage"] = stage
    print(f"[presenter] install: {stage}", flush=True)
    proc = subprocess.run(
        cmd, cwd=cwd, env=_clean_env(), capture_output=True, text=True, timeout=timeout
    )
    if proc.returncode != 0:
        # pip reports the reason last and its warnings first; keep the end,
        # and drop the start-up noise that is not the failure.
        lines = [
            line for line in (proc.stderr or proc.stdout or "").splitlines()
            if "sitecustomize" not in line and "PYTHONVERBOSE" not in line
        ]
        raise RuntimeError(f"{stage} failed: {tail_of(chr(10).join(lines), 700)}")


def _install_engine() -> None:
    global ENGINE_DIR, ENGINE_PYTHON
    t0 = time.time()
    engine_dir = os.path.join(INSTALL_ROOT, "LatentSync")
    venv = os.path.join(INSTALL_ROOT, "venv")
    python = os.path.join(venv, "bin", "python")
    marker = os.path.join(INSTALL_ROOT, f".ready-{LATENTSYNC_COMMIT[:10]}")

    try:
        INSTALL["state"] = "installing"
        if not os.path.exists(marker):
            os.makedirs(INSTALL_ROOT, exist_ok=True)

            if not os.path.isdir(os.path.join(engine_dir, ".git")):
                shutil.rmtree(engine_dir, ignore_errors=True)
                _step("fetching the engine", ["git", "clone", "--quiet", LATENTSYNC_REPO, engine_dir])
            _step("pinning the engine version",
                  ["git", "checkout", "--quiet", LATENTSYNC_COMMIT], cwd=engine_dir)

            if not os.path.exists(python):
                # uv fetches a standalone Python of the version the engine was
                # built for, so the install no longer depends on which Python
                # the notebook host happens to run. --seed puts pip in the
                # environment; the libraries are then installed with pip,
                # exactly as on Modal, where this set is known to resolve.
                shutil.rmtree(venv, ignore_errors=True)
                _step("getting an installer",
                      [sys.executable, "-m", "pip", "install", "--quiet", "uv"])
                _step(f"creating a Python {ENGINE_PYTHON_VERSION} environment",
                      [sys.executable, "-m", "uv", "venv", "--seed",
                       "--python", ENGINE_PYTHON_VERSION, venv])

            # The engine's own requirements, minus its demo UI.
            reqs = os.path.join(INSTALL_ROOT, "requirements.txt")
            with open(os.path.join(engine_dir, "requirements.txt"), encoding="utf-8") as src:
                kept = [line for line in src.read().splitlines() if not line.startswith("gradio")]
            with open(reqs, "w", encoding="utf-8") as dst:
                dst.write("\n".join(kept) + "\n")
            _step("installing the engine's libraries (the slow part)",
                  [python, "-m", "pip", "install", "--quiet", "-r", reqs])

            script = os.path.join(INSTALL_ROOT, "weights.py")
            with open(script, "w", encoding="utf-8") as f:
                f.write(_WEIGHTS_SCRIPT)
            _step("downloading the weights",
                  [python, script, os.path.join(engine_dir, "checkpoints")])

            with open(marker, "w", encoding="utf-8") as f:
                f.write(str(time.time()))

        ENGINE_DIR, ENGINE_PYTHON = engine_dir, python
        INSTALL.update(state="ready", stage="ready", error="", seconds=round(time.time() - t0))
        print(f"[presenter] engine ready: {installed_engines()} ({INSTALL['seconds']}s)", flush=True)
    except Exception as e:  # noqa: BLE001
        INSTALL.update(state="failed", error=str(e)[:600], seconds=round(time.time() - t0))
        print("[presenter] install failed:", e, flush=True)


def start_install_in_background() -> None:
    """Begin installing the engine, once. Returns immediately."""
    if _INSTALL_STARTED.is_set():
        return
    _INSTALL_STARTED.set()
    threading.Thread(target=_install_engine, daemon=True).start()


# ---------------------------------------------------------------------------
# worker
# ---------------------------------------------------------------------------

def _set(job_id: str, **patch: Any) -> None:
    with _LOCK:
        if job_id in RENDERS:
            RENDERS[job_id].update(patch)


def _keep_awake(job_id: str, self_url: str) -> None:
    """Keep this container counted as busy while a clip is being made.

    The work happens in a background thread, and a scale-to-zero host judges
    idleness by incoming requests. Without this the only thing keeping the
    container alive is the caller's polling: a browser tab moved to the
    background polls once a minute at best, the host sees two idle minutes,
    and it shuts the container down halfway through a four-minute clip.

    A request to our own address every 40 seconds is enough to stay awake,
    and it stops the moment the job leaves the running state.
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
            # Never fatal: at worst the container is no better protected
            # than it was before this existed.
            pass


def _run_engine(cmd: List[str]) -> subprocess.CompletedProcess:
    """Run the engine, alone on its GPU.

    When it shares the only GPU with the voice server it takes the voice
    server's own lock for the duration, so no narration starts halfway
    through and pushes the card out of memory.
    """
    def go() -> subprocess.CompletedProcess:
        return subprocess.run(
            cmd, cwd=ENGINE_DIR, env=_engine_env(),
            capture_output=True, text=True, timeout=ENGINE_TIMEOUT,
        )

    if _shares_gpu_with_voice():
        with _SHARED_GPU_LOCK:  # type: ignore[union-attr]
            if _BEFORE_ENGINE:
                try:
                    _BEFORE_ENGINE()
                except Exception:  # noqa: BLE001
                    pass
            return go()
    return go()


def _run_presenter(req: Dict[str, Any]) -> None:
    job_id = req["job_id"]
    work = tempfile.mkdtemp(prefix="vfp-", dir=WORK_ROOT)
    t0 = time.time()
    if req.get("_self_url"):
        threading.Thread(
            target=_keep_awake, args=(job_id, req["_self_url"]), daemon=True
        ).start()

    try:
        with _GPU_LOCK:
            _set(job_id, status="running", stage="fetching", progress=2)

            engine = pick_engine(req.get("engine"), installed_engines(), PREFERRED_ENGINE)
            if not engine:
                raise RuntimeError("the lip-sync engine is not installed on this backend")

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
                # recording itself), and the face it redraws is at most 512 px,
                # so a 1280 px frame loses nothing that survives to the result.
                "-t", f"{audio_seconds + 0.5:.2f}",
                "-vf", "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
                "-pix_fmt", "yuv420p", video,
            ])
            audio = os.path.join(work, "in.wav")
            _ffmpeg(["-i", src_audio, "-ac", "1", "-ar", "16000", audio])

            _set(job_id, stage="lip-syncing", progress=15, engine=engine)
            out = os.path.join(work, f"{job_id}.mp4")
            cmd = engine_command(
                engine, video, audio, out,
                clamp_steps(req.get("steps")),
                clamp_guidance(req.get("guidance")),
                int(req.get("seed") or 1247),
                os.path.join(work, "tmp"),
            )
            t_engine = time.time()
            proc = _run_engine(cmd)
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

            sync: Dict[str, Any] = {}
            if req.get("measure_sync", True):
                _set(job_id, stage="measuring sync", progress=97)
                # Two readings: the engine's own output, and the file actually
                # delivered. If they differ, the final mux moved something.
                sync = {
                    "engine_output": _measure_sync(out, work),
                    "delivered": _measure_sync(final, work),
                }

            _set(
                job_id,
                sync=sync,
                steps=clamp_steps(req.get("steps")),
                guidance=clamp_guidance(req.get("guidance")),
                status="done", stage="done", progress=100,
                path=final, work=work,
                duration=round(_probe_seconds(final), 2),
                bytes=os.path.getsize(final),
                gen_seconds=round(time.time() - t0, 2),
                engine=engine,
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
                "steps": job.get("steps"),
                "guidance": job.get("guidance"),
                "sync": job.get("sync") or None,
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

def health_report(provider: str) -> Dict[str, Any]:
    with _LOCK:
        busy = any(j.get("status") == "running" for j in RENDERS.values())
    engines = installed_engines()
    report: Dict[str, Any] = {
        "ok": True,
        "provider": provider,
        # Only claimed when an engine and its weights are really there — a
        # capability is a promise the gateway routes work on.
        "capabilities": ["presenter-relip"] if engines else [],
        "engines": engines,
        "engine": pick_engine(None, engines, PREFERRED_ENGINE),
        "version": PRESENTER_VERSION,
        "busy": busy,
        "gpu": _gpu_name(),
    }
    if INSTALL["state"] != "idle":
        report["install"] = dict(INSTALL)
    return report


def create_presenter_router(
    check_secret,
    provider: str = "custom",
    shared_lock: Optional[Any] = None,
    before_engine: Optional[Callable[[], None]] = None,
) -> APIRouter:
    """Routes, including /health. Mount at the root (Modal) or under a prefix
    (a notebook, where the voice server already owns /render and /health).

    `shared_lock` is the voice server's GPU lock when the two share a process;
    see _run_engine.
    """
    global _SHARED_GPU_LOCK, _BEFORE_ENGINE
    _SHARED_GPU_LOCK = shared_lock
    _BEFORE_ENGINE = before_engine

    router = APIRouter()

    @router.get("/health")
    def health() -> dict:
        return health_report(provider)

    @router.post("/render", status_code=202)
    async def start(request: Request, x_backend_secret: Optional[str] = Header(None)) -> dict:
        check_secret(x_backend_secret)
        req = await request.json()
        for field in ("video_url", "audio_url"):
            value = str(req.get(field) or "")
            if not value.startswith("https://"):
                raise HTTPException(status_code=400, detail=f"{field} must be an https URL")
        if not installed_engines():
            # Refuse up front, so the gateway moves on to the next backend
            # instead of handing over a clip that can only fail.
            raise HTTPException(status_code=503, detail="the lip-sync engine is not ready here")
        job_id = str(req.get("job_id") or uuid.uuid4().hex)
        req["job_id"] = job_id
        # Our own public address, as the caller reached us — used to keep
        # the container awake for the length of the job. Includes the mount
        # prefix, so it works at the root and under /presenter alike.
        host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
        path = request.url.path
        mount = path[: -len("/render")] if path.endswith("/render") else ""
        req["_self_url"] = f"https://{host}{mount}" if host and "localhost" not in host else ""
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
    """Standalone app — used by the Modal function."""
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="VoiceForge presenter", version=PRESENTER_VERSION)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    def check(secret: Optional[str]) -> None:
        expected = os.environ.get("BACKEND_SECRET")
        if expected and secret != expected:
            raise HTTPException(status_code=401, detail="bad backend secret")

    app.include_router(create_presenter_router(check, provider=provider))
    return app
