"""
VoiceForge on Modal — the always-available backend.

Why Modal: a permanent HTTPS URL that scales to zero, so it costs nothing
while idle and needs no notebook left open. Deployed automatically from
GitHub by .github/workflows/deploy-modal.yml.

Deploy by hand:
    pip install modal
    modal token new
    modal secret create voiceforge-backend BACKEND_SECRET=<same value as Vercel>
    modal deploy modal/voiceforge_modal.py
"""

import modal

APP_NAME = "voiceforge"

# Same pinned stack the notebooks use — see colab/voiceforge_server.ipynb.
# numpy<2 and the exact transformers/safetensors pins are load-bearing:
# chatterbox breaks on newer ones.
def _bake_weights() -> None:
    """Download the Chatterbox weights at IMAGE BUILD time.

    Without this the first request on a cold container pulls several GB from
    HuggingFace before it can answer, which blows past the 60 s ceiling on a
    Vercel function — the caller sees a timeout and assumes the GPU is down.
    Baking them into the image layer turns a cold start into "load from local
    disk", which is the difference between minutes and seconds.
    """
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    # CPU here on purpose: the build machine has no GPU, and we only need the
    # files in the cache, not a usable model.
    ChatterboxMultilingualTTS.from_pretrained(device="cpu")


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install(
        "chatterbox-tts",
        "fastapi[standard]",
        "soundfile",
        "numpy==1.26.4",
        "transformers==5.2.0",
        "safetensors==0.5.3",
        # Fetches the Nepali T3 checkpoint at runtime; chatterbox pulls it in
        # already, but the Nepali path depends on it directly.
        "huggingface_hub",
    )
    .run_function(_bake_weights)
    .add_local_dir("backend", remote_path="/root/backend")
)

# A deliberately thin image for rendering: ffmpeg and fastapi, no torch and no
# model weights. It builds in seconds and cold-starts fast, which matters
# because a render is CPU work that must never wait on a GPU image.
render_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "fonts-dejavu-core")
    .pip_install("fastapi[standard]")
    .add_local_dir("backend", remote_path="/root/backend")
)

app = modal.App(APP_NAME)

# Cached reference clips survive container restarts, so a voice is downloaded
# from Blob once rather than on every cold start.
volume = modal.Volume.from_name("voiceforge-voices", create_if_missing=True)
VOICES_DIR = "/voices"

secret = modal.Secret.from_name("voiceforge-backend")


@app.function(
    image=image,
    gpu="T4",
    volumes={VOICES_DIR: volume},
    secrets=[secret],
    # One container: generation is sequential by design (single GPU).
    max_containers=1,
    # Idle for ~2 minutes then shut down — this is what makes it free.
    scaledown_window=120,
    timeout=60 * 30,
)
@modal.asgi_app()
def api():
    import os

    os.environ.setdefault("VOICEFORGE_VOICES_DIR", VOICES_DIR)
    # The Nepali engine: the finished epoch-50 weights, from an ungated repo.
    os.environ.setdefault("VOICEFORGE_NE_MODEL", "Firoj112/chatterbox-nepali-runs")
    os.environ.setdefault("VOICEFORGE_NE_FILE", "t3_mtl_nepali_final.safetensors")

    import sys

    sys.path.insert(0, "/root")
    from backend.voiceforge_server import create_app, load_models

    load_models()
    return create_app(provider="modal")


@app.function(
    image=render_image,
    secrets=[secret],
    # NO gpu= on purpose. Rendering is ffmpeg on CPU; billing a T4 to run it
    # would cost about ten times as much and wake a GPU for nothing.
    cpu=8.0,
    memory=8192,
    max_containers=1,
    # Longer than the GPU function: a 20-minute video is a long job, and
    # being killed at the 30-minute mark would waste everything done so far.
    timeout=60 * 120,
    scaledown_window=180,
)
@modal.asgi_app()
def render():
    """Long-form video assembly. CPU only — see the note above."""
    import sys

    sys.path.insert(0, "/root")
    from backend.voiceforge_render import create_render_app

    return create_render_app(provider="modal")


@app.function(image=image, secrets=[secret], max_containers=1)
@modal.asgi_app()
def health():
    """
    A CPU-only health endpoint.

    Deliberately separate from `api`: the admin page polls health every 15s,
    and hitting the GPU function would wake a T4 each time and burn the free
    credit doing nothing. This answers without touching the GPU.
    """
    from fastapi import FastAPI

    probe = FastAPI()

    @probe.get("/health")
    def _health():
        return {"ok": True, "provider": "modal", "gpu": "T4 (cold)", "models": ["chatterbox"]}

    return probe
