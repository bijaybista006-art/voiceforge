"""
Wan 2.2 TI2V-5B — settings, limits and request validation.

Pure Python: no torch, no FastAPI. Everything that decides WHAT a clip will
be lives here, so it is tested in CI and shared by every host (Modal, Colab,
Kaggle). The engine only executes a request this module has already resolved.
"""

from __future__ import annotations

import os
import random
from typing import Any, Dict

WAN_VERSION = "1.0.0"

MODEL_ID = "Wan-AI/Wan2.2-TI2V-5B-Diffusers"
# "main" = latest. Put a commit hash here to freeze the exact weights.
MODEL_REVISION = "main"

# What /health promises once the engine and its weights are really there.
CAPABILITY = "text-to-video"

FPS = 24  # TI2V-5B is trained for 24 fps

# Landscape (width, height). Vertical swaps them. Both sides must be
# multiples of 32 (VAE 16x * patch 2x).
QUALITIES: Dict[str, tuple] = {
    "720p": (1280, 704),  # the model's native size
    "480p": (832, 480),  # ~2.5x fewer pixels: what a free T4 can do in reasonable time
}
ASPECTS = ("landscape", "vertical")  # vertical = YouTube Shorts

MIN_FRAMES = 5
MAX_FRAMES = 121  # trained length, ~5 s at 24 fps
DEFAULT_FRAMES = 121
DEFAULT_STEPS = 50
DEFAULT_GUIDANCE = 5.0
MAX_PROMPT_CHARS = 2000

# Standard Wan negative prompt (English, from the Diffusers docs).
DEFAULT_NEGATIVE_PROMPT = (
    "Bright tones, overexposed, static, blurred details, subtitles, style, works, "
    "paintings, images, static, overall gray, worst quality, low quality, JPEG "
    "compression residue, ugly, incomplete, extra fingers, poorly drawn hands, "
    "poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, "
    "still picture, messy background, three legs, many people in the background, "
    "walking backwards"
)

# How the engine loads the model on each kind of host.
#   full      Modal L40S (48 GB): bf16, whole pipeline on the GPU.
#   low_vram  Colab / Kaggle T4 (16 GB, no bf16, 13-29 GB RAM, shares the GPU
#             with the voice model): 4-bit NF4 transformer + text encoder,
#             fp16 compute, tiled VAE decode. ~7 GB of VRAM instead of ~30.
PROFILES: Dict[str, Dict[str, Any]] = {
    "full": {
        "dtype": "bfloat16",
        "quantize": False,
        "cpu_offload": False,
        "vae_tiling": False,
        "default_quality": "720p",
    },
    "low_vram": {
        "dtype": "float16",
        "quantize": True,
        "cpu_offload": False,
        "vae_tiling": True,
        "default_quality": "480p",
    },
}

# One pinned stack for every host. torch 2.7.1's PyPI wheel is built for
# CUDA 12.6, which Modal, Colab and Kaggle drivers all run. The Modal image
# repeats this list (it cannot import this file at build time); a test keeps
# the two identical.
WAN_PACKAGES = [
    "torch==2.7.1",
    "diffusers==0.41.0",
    "transformers==5.20.2",
    "accelerate==1.15.0",
    "huggingface_hub==1.33.0",
    "bitsandbytes==0.50.2",  # low_vram profile only
    "sentencepiece==0.2.2",  # UMT5 tokenizer
    "ftfy==6.3.1",  # prompt cleaning used by WanPipeline
    "imageio==2.38.1",
    "imageio-ffmpeg==0.6.0",  # bundles ffmpeg for MP4 export
]

# Marker written after a complete weights download. Its absence means "not
# ready", never "half there".
WEIGHTS_MARKER = ".download_complete"

OOM_PREFIX = "GPU_OUT_OF_MEMORY"


class SettingsError(ValueError):
    """A request the caller must fix. Maps to HTTP 400."""


def profile_for(provider: str) -> str:
    """Modal gets the full model; notebooks get the low-VRAM profile.

    VOICEFORGE_WAN_PROFILE overrides it (e.g. "full" on a Colab Pro A100).
    """
    forced = os.environ.get("VOICEFORGE_WAN_PROFILE", "").strip()
    if forced in PROFILES:
        return forced
    return "full" if provider == "modal" else "low_vram"


def limits(profile: str) -> Dict[str, Any]:
    """What /health advertises, so the gateway and UI never offer the impossible."""
    return {
        "aspects": list(ASPECTS),
        "qualities": list(QUALITIES),
        "default_quality": PROFILES[profile]["default_quality"],
        "min_frames": MIN_FRAMES,
        "max_frames": MAX_FRAMES,
        "fps": FPS,
        "max_prompt_chars": MAX_PROMPT_CHARS,
    }


def _number(req: Dict[str, Any], key: str, default: Any, kind: type) -> Any:
    value = req.get(key)
    if value is None or value == "":
        return default
    try:
        return kind(value)
    except (TypeError, ValueError):
        raise SettingsError(f"{key} must be a number") from None


def build_settings(req: Dict[str, Any], profile: str) -> Dict[str, Any]:
    """Validate a request and resolve every default. Raises SettingsError."""
    prompt = str(req.get("prompt") or "").strip()
    if not prompt:
        raise SettingsError("prompt is empty: describe the video you want")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise SettingsError(f"prompt is {len(prompt)} characters; the limit is {MAX_PROMPT_CHARS}")

    negative = str(req.get("negative_prompt") or "").strip() or DEFAULT_NEGATIVE_PROMPT

    aspect = str(req.get("aspect") or "landscape").strip().lower()
    if aspect not in ASPECTS:
        raise SettingsError(f"aspect must be one of: {', '.join(ASPECTS)}")

    quality = str(req.get("quality") or PROFILES[profile]["default_quality"]).strip().lower()
    if quality not in QUALITIES:
        raise SettingsError(f"quality must be one of: {', '.join(QUALITIES)}")
    width, height = QUALITIES[quality]
    if aspect == "vertical":
        width, height = height, width

    frames = _number(req, "num_frames", DEFAULT_FRAMES, int)
    # The VAE compresses time 4x, so the frame count must be 4k + 1.
    if not (MIN_FRAMES <= frames <= MAX_FRAMES) or (frames - 1) % 4 != 0:
        raise SettingsError(
            f"num_frames must be 4k+1 between {MIN_FRAMES} and {MAX_FRAMES} "
            f"(49 = 2 s, 81 = 3.4 s, 121 = 5 s); got {frames}"
        )

    steps = _number(req, "steps", DEFAULT_STEPS, int)
    if not 1 <= steps <= 100:
        raise SettingsError(f"steps must be between 1 and 100; got {steps}")

    guidance = _number(req, "guidance", DEFAULT_GUIDANCE, float)
    if not 0.0 <= guidance <= 20.0:
        raise SettingsError(f"guidance must be between 0 and 20; got {guidance}")

    seed = _number(req, "seed", -1, int)
    if seed < 0:
        seed = random.randint(0, 2**32 - 1)  # recorded, so a good clip can be remade
    if seed > 2**32 - 1:
        raise SettingsError("seed must be between 0 and 4294967295")

    return {
        "mode": "text-to-video",  # future: "image-to-video" (same weights)
        "prompt": prompt,
        "negative_prompt": negative,
        "aspect": aspect,
        "quality": quality,
        "width": width,
        "height": height,
        "num_frames": frames,
        "fps": FPS,
        "duration": round(frames / FPS, 2),
        "steps": steps,
        "guidance": guidance,
        "seed": seed,
        "model": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "profile": profile,
    }
