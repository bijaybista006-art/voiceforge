"""
Wan 2.2 TI2V-5B — the engine. The ONLY Wan file that imports torch.

Self-contained on purpose (imports nothing from VoiceForge) because it runs
two ways:
  * Modal: imported in-process; the pipeline is loaded once per container
    and reused for every clip (load_pipeline caches it).
  * Colab / Kaggle: run as a script by the private virtualenv's Python,
        python engine.py request.json
    because Wan's diffusers/transformers cannot share an environment with
    Chatterbox's pins. It prints one JSON event per line on stdout:
        {"event": "stage", "stage": "loading the model"}
        {"event": "progress", "step": 3, "total": 50}
        {"event": "done", "load_seconds": .., "gen_seconds": .., "gpu": ..}
        {"event": "error", "error": "..."}
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable, Dict, Optional

OOM_PREFIX = "GPU_OUT_OF_MEMORY"  # same value as settings.OOM_PREFIX

_CACHE: Dict[str, Any] = {"key": None, "pipe": None, "load_seconds": 0.0}


def gpu_name() -> str:
    import torch

    return torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"


def peak_vram_gb() -> Optional[float]:
    """The most GPU memory this process has held, so a log shows real numbers."""
    try:
        import torch

        if torch.cuda.is_available():
            return round(torch.cuda.max_memory_allocated() / 1e9, 2)
    except Exception:  # noqa: BLE001
        pass
    return None


def load_pipeline(model_path: str, profile: Dict[str, Any]):
    """Load (or reuse) the pipeline for this profile. Returns (pipe, load_seconds)."""
    key = json.dumps([model_path, profile], sort_keys=True)
    if _CACHE["key"] == key:
        return _CACHE["pipe"], 0.0

    import torch
    from diffusers import AutoencoderKLWan, WanPipeline

    t0 = time.time()
    dtype = getattr(torch, profile["dtype"])
    extra: Dict[str, Any] = {}
    if profile.get("quantize"):
        from diffusers.quantizers import PipelineQuantizationConfig

        # 4-bit NF4 for the two big parts (5B transformer, UMT5-XXL text
        # encoder). Loaded shard by shard, so peak RAM stays low enough for a
        # free Colab session too.
        extra["quantization_config"] = PipelineQuantizationConfig(
            quant_backend="bitsandbytes_4bit",
            quant_kwargs={
                "load_in_4bit": True,
                "bnb_4bit_quant_type": "nf4",
                "bnb_4bit_compute_dtype": dtype,
            },
            components_to_quantize=["transformer", "text_encoder"],
        )

    # Diffusers keeps the Wan VAE in float32 for quality.
    vae = AutoencoderKLWan.from_pretrained(model_path, subfolder="vae", torch_dtype=torch.float32)
    pipe = WanPipeline.from_pretrained(model_path, vae=vae, torch_dtype=dtype, **extra)

    if profile.get("cpu_offload"):
        pipe.enable_model_cpu_offload()
    else:
        pipe.to("cuda")
    if profile.get("vae_tiling"):
        pipe.vae.enable_tiling()

    seconds = round(time.time() - t0, 1)
    _CACHE.update(key=key, pipe=pipe, load_seconds=seconds)
    return pipe, seconds


def generate(
    pipe,
    settings: Dict[str, Any],
    out_path: str,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> float:
    """Render one clip to out_path (MP4). Returns generation seconds."""
    import torch
    from diffusers.utils import export_to_video

    total = int(settings["steps"])

    def step_end(_pipe, i, _t, kwargs):
        if on_progress:
            on_progress(i + 1, total)
        return kwargs

    # A CPU generator gives the same starting noise on every GPU type, so a
    # seed reproduces a clip on an L40S, a T4 or anything else.
    generator = torch.Generator(device="cpu").manual_seed(int(settings["seed"]))
    t0 = time.time()
    try:
        with torch.inference_mode():
            frames = pipe(
                prompt=settings["prompt"],
                negative_prompt=settings["negative_prompt"],
                height=settings["height"],
                width=settings["width"],
                num_frames=settings["num_frames"],
                num_inference_steps=total,
                guidance_scale=settings["guidance"],
                generator=generator,
                callback_on_step_end=step_end,
            ).frames[0]
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()  # leave the GPU usable for the next job
        raise RuntimeError(
            f"{OOM_PREFIX}: the GPU ran out of memory at {settings['width']}x{settings['height']}, "
            f"{settings['num_frames']} frames. Try quality 480p or fewer frames."
        ) from None
    gen_seconds = round(time.time() - t0, 1)
    export_to_video(frames, out_path, fps=int(settings["fps"]))
    return gen_seconds


# ---------------------------------------------------------------------------
# subprocess entry point (notebooks)
# ---------------------------------------------------------------------------

def _emit(**event: Any) -> None:
    print(json.dumps(event), flush=True)


def main(request_path: str) -> int:
    with open(request_path, encoding="utf-8") as f:
        req = json.load(f)
    try:
        _emit(event="stage", stage="loading the model")
        pipe, load_seconds = load_pipeline(req["model_path"], req["profile"])
        _emit(event="stage", stage="generating")
        gen_seconds = generate(
            pipe, req["settings"], req["out_path"],
            on_progress=lambda step, total: _emit(event="progress", step=step, total=total),
        )
        _emit(event="done", load_seconds=load_seconds, gen_seconds=gen_seconds, gpu=gpu_name(),
              peak_vram_gb=peak_vram_gb())
        return 0
    except Exception as e:  # noqa: BLE001 - reported to the service, which reports it to the gateway
        _emit(event="error", error=str(e)[:900])
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
