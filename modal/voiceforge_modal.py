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
        # Separates a voice clip from its background noise; see _clean_reference.
        "demucs==4.0.1",
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
    # The Nepali engine: the user's own model repo (private; read with HF_TOKEN
    # from the voiceforge-backend secret). Version 1 there is an unchanged copy
    # of Firoj112/chatterbox-nepali-runs' epoch-50 weights — see
    # modal/copy_nepali_model.py. Set VOICEFORGE_NE_MODEL in the secret to
    # point elsewhere without a code change.
    os.environ.setdefault("VOICEFORGE_NE_MODEL", "waytobijay/voiceforge-nepali")
    # The merged checkpoint; see NE_FILE in backend/voiceforge_server.py.
    os.environ.setdefault("VOICEFORGE_NE_FILE", "t3_mtl_nepali_merged.safetensors")

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


# ---------------------------------------------------------------------------
# Presenter video (lip-synced intro / outro clips)
# ---------------------------------------------------------------------------
#
# Its own image and its own function. LatentSync pins torch 2.5 and its own
# diffusers and numpy, none of which can share an environment with Chatterbox,
# and a presenter clip must never be able to break narration.

# Pinned so a change upstream cannot alter results between two deploys.
LATENTSYNC_COMMIT = "a229c3948406bc2cf6eaf4873e662e70c6a04746"
LATENTSYNC_DIR = "/opt/LatentSync"


def _bake_presenter_weights() -> None:
    """Fetch every weight the engine touches at IMAGE BUILD time.

    A cold container that has to download a 5 GB checkpoint before its first
    frame spends that time on a billed GPU. Three sources: the lip-sync U-Net
    and its audio encoder, the VAE that diffusers would otherwise pull on
    first use, and the face detector that insightface fetches lazily.
    """
    import os
    import urllib.request
    import zipfile

    from huggingface_hub import hf_hub_download, snapshot_download

    ckpt = os.path.join(LATENTSYNC_DIR, "checkpoints")
    # The last two are the face detector and SyncNet model the engine's own
    # sync evaluation uses, so a clip's lip-sync can be measured, not judged.
    for name in (
        "latentsync_unet.pt",
        "whisper/tiny.pt",
        "auxiliary/sfd_face.pth",
        "auxiliary/syncnet_v2.model",
    ):
        hf_hub_download("ByteDance/LatentSync-1.6", name, local_dir=ckpt)

    # The 256 px checkpoint a free notebook GPU runs. Baked here too so the
    # two can be compared on the same clip, and requested with
    # engine: "latentsync-1.5" when speed matters more than sharpness.
    hf_hub_download(
        "ByteDance/LatentSync-1.5", "latentsync_unet.pt", local_dir=os.path.join(ckpt, "v15")
    )

    snapshot_download("stabilityai/sd-vae-ft-mse")

    models = os.path.join(ckpt, "auxiliary", "models")
    os.makedirs(models, exist_ok=True)
    archive = os.path.join(models, "buffalo_l.zip")
    urllib.request.urlretrieve(
        "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip",
        archive,
    )
    with zipfile.ZipFile(archive) as z:
        z.extractall(os.path.join(models, "buffalo_l"))
    os.remove(archive)


presenter_image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "git", "libgl1", "libglib2.0-0", "build-essential")
    .run_commands(
        f"git clone https://github.com/bytedance/LatentSync.git {LATENTSYNC_DIR}",
        f"cd {LATENTSYNC_DIR} && git checkout {LATENTSYNC_COMMIT}",
        # The engine's own pins, minus the demo UI it does not need here.
        f"cd {LATENTSYNC_DIR} && grep -v '^gradio' requirements.txt > /tmp/req.txt"
        " && pip install -r /tmp/req.txt",
    )
    .pip_install("fastapi[standard]")
    .run_function(_bake_presenter_weights)
    .add_local_dir("backend", remote_path="/root/backend")
)


@app.function(
    image=presenter_image,
    secrets=[secret],
    # LatentSync 1.6 needs about 18 GB, which rules out the T4 the voice
    # function uses. An L4 has 24 GB.
    gpu="L4",
    memory=16384,
    max_containers=1,
    timeout=60 * 30,
    scaledown_window=120,
)
@modal.asgi_app()
def presenter():
    """Lip-synced presenter clips. GPU, separate from voice — see above."""
    import os
    import sys

    os.environ.setdefault("VOICEFORGE_LATENTSYNC_DIR", LATENTSYNC_DIR)
    sys.path.insert(0, "/root")
    from backend.voiceforge_presenter import create_presenter_app

    return create_presenter_app(provider="modal")
