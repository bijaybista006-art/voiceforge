# backend/wan — AI video clips (Wan 2.2 TI2V-5B)

Makes short video clips from a text prompt with [Wan 2.2 TI2V-5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers) (Apache 2.0, OK for commercial use).

| File | What it does |
|---|---|
| `settings.py` | Limits, defaults, the two load profiles, pinned packages, request validation. Pure Python, tested in CI. |
| `engine.py` | The only file that imports torch. Loads the pipeline and renders a clip. Runs in-process on Modal, as a subprocess on notebooks. |
| `install.py` | Puts the libraries and weights on a host. On notebooks this is a private virtualenv built in the background. On Modal it fills the `wan-models` volume. |
| `service.py` | FastAPI routes: the `/render` job protocol (same as the presenter) and `/health`. |

## Where it runs

| Host | How | Profile | Default |
|---|---|---|---|
| Modal | `modal/voiceforge_wan.py`, its own app and image on an L40S | `full`: bf16, whole model on the GPU | 720p, 121 frames (~5 s) |
| Colab / Kaggle | Mounted under `/wan` in the voice server (`ENABLE_AI_VIDEO = True`, the default); installs only when the backend's **AI video** switch in Admin → Backends is on | `low_vram`: 4-bit NF4, fp16, tiled VAE (~7 GB VRAM) | 480p, 121 frames |

On a single-GPU notebook a clip takes the voice server's GPU lock, so narration waits until it finishes. On Kaggle T4 x2 the clip runs on the second GPU and narration is unaffected.

## API (every call except `/health` needs `X-Backend-Secret`)

```
POST   /render             {prompt, negative_prompt?, aspect: landscape|vertical,
                            quality: 720p|480p, num_frames, steps, guidance, seed?,
                            job_id?, callback_url?, callback_token?}  -> 202 {job_id, settings}
GET    /render/{id}        -> {status, stage, progress, settings, ...}
GET    /render/{id}/video  -> MP4
DELETE /render/{id}
GET    /health             -> {capabilities: ["text-to-video"] when ready, limits, profile, install?}
```

Errors: invalid input → `400`, engine not ready → `503`. GPU out of memory ends the job with `status: "error"`, `oom: true`.
