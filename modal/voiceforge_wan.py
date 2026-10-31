"""
VoiceForge AI video (Wan 2.2 TI2V-5B) on Modal.

Its OWN Modal app, not a function inside voiceforge_modal.py: Wan's image
(~25 GB of weights, a different torch) is the riskiest build in the project,
and as a separate deploy a failure here can never stop voice from deploying.
The code it serves is backend/wan/, shared with the Colab/Kaggle notebook.

Deployed by .github/workflows/deploy-modal.yml after the voice app. By hand:
    modal deploy modal/voiceforge_wan.py
    modal run modal/voiceforge_wan.py::download      # once; ~25 GB into the volume

Uses the same `voiceforge-backend` secret as voice (BACKEND_SECRET, and
HF_TOKEN if present). URLs:
    https://<workspace>--voiceforge-wan.modal.run          the service (GPU)
    https://<workspace>--voiceforge-wan-health.modal.run   /health without waking the GPU
"""

import modal

APP_NAME = "voiceforge-wan"

# One value to change the GPU. L40S (48 GB) runs the full bf16 model.
# Other options: "A100-40GB", "A100-80GB", "H100". A 24 GB card (A10G, L4)
# also works with VOICEFORGE_WAN_PROFILE=low_vram in the secret.
GPU = "L40S"

MODELS_DIR = "/models"

# Same list as WAN_PACKAGES in backend/wan/settings.py (this file cannot
# import it at build time). backend/tests/test_wan.py keeps them identical.
WAN_PACKAGES = [
    "torch==2.7.1",
    "diffusers==0.41.0",
    "transformers==5.20.2",
    "accelerate==1.15.0",
    "huggingface_hub==1.33.0",
    "bitsandbytes==0.50.2",
    "sentencepiece==0.2.2",
    "ftfy==6.3.1",
    "imageio==2.38.1",
    "imageio-ffmpeg==0.6.0",
]

app = modal.App(APP_NAME)

# The service. HF_HUB_OFFLINE=1: it can only read the weights already in the
# volume, so a run can never start a 25 GB download on a billed GPU.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install(*WAN_PACKAGES, "fastapi[standard]==0.159.1")
    .env({
        "HF_HUB_OFFLINE": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "VOICEFORGE_WAN_MODEL_DIR": MODELS_DIR,
    })
    .add_local_dir("backend", remote_path="/root/backend")
)

# Small CPU image for the download and the health probe.
light_image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install("huggingface_hub==1.33.0", "fastapi[standard]==0.159.1")
    .env({"VOICEFORGE_WAN_MODEL_DIR": MODELS_DIR})
    .add_local_dir("backend", remote_path="/root/backend")
)

volume = modal.Volume.from_name("wan-models", create_if_missing=True)
secret = modal.Secret.from_name("voiceforge-backend")


@app.function(image=light_image, volumes={MODELS_DIR: volume}, secrets=[secret], timeout=60 * 60)
def download(force: bool = False):
    """One-time weights download into the `wan-models` volume. CPU only.

    Safe to re-run: it returns at once when the weights are already there.
    """
    import os
    import sys
    import time

    sys.path.insert(0, "/root")
    from backend.wan import install

    dest = install.model_dir()
    if install.weights_ready(dest) and not force:
        print(f"Weights already in the volume at {dest}.")
        return
    t0 = time.time()
    print(f"Downloading to {dest} (~25 GB) ...")
    os.makedirs(dest, exist_ok=True)
    install.download_weights(dest, token=os.environ.get("HF_TOKEN"))
    volume.commit()
    print(f"Done in {time.time() - t0:.0f}s.")


@app.function(
    image=image,
    gpu=GPU,
    memory=32 * 1024,  # weights pass through RAM on the way to the GPU
    volumes={MODELS_DIR: volume},
    secrets=[secret],
    # One container: one GPU, one clip at a time (later jobs queue).
    max_containers=1,
    # Idle for 2 minutes then shut down: an idle L40S is ~$2/hour.
    scaledown_window=120,
    timeout=60 * 30,
)
@modal.asgi_app(label="voiceforge-wan")
def wan():
    """The video service. Loads the model once per container."""
    import sys

    sys.path.insert(0, "/root")
    from backend.wan.service import create_wan_app

    return create_wan_app(provider="modal")


@app.function(image=light_image, volumes={MODELS_DIR: volume}, secrets=[secret], max_containers=1)
@modal.asgi_app(label="voiceforge-wan-health")
def health():
    """/health on a CPU, so status checks never wake (and bill) the L40S.

    Same answer as the GPU service's /health, minus the GPU name.
    """
    import sys

    sys.path.insert(0, "/root")
    from fastapi import FastAPI

    from backend.wan import service

    service.configure("modal")
    probe = FastAPI()

    @probe.get("/health")
    def _health() -> dict:
        volume.reload()  # see a download that finished after this container started
        report = service.health_report()
        report["gpu"] = f"{GPU} (cold)"
        return report

    return probe
