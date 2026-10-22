"""
Train the owner's Nepali model: continue the T3 stage from the current
Nepali checkpoint on the owner's own recordings, and push the result to
their Hugging Face repo as a new version.

    modal run modal/train_nepali.py --version v3 --speaker Bijay \
        --voice <voice id> [--epochs 6] [--lr 1e-5] [--smoke]

Started from GitHub → Actions → "Train Nepali model". Needs, in the Modal
secret `voiceforge-backend`: HF_TOKEN (write access to the repo),
and BACKEND_SECRET (to read the clip list from the app's
/api/internal/training/manifest; the app address is --app-url).

How it trains, and why (checked against chatterbox-tts 0.1.7's source):
- Only T3 learns (text → speech tokens). The voice encoder and S3Gen, which
  make the sound of the voice, stay as they are, so cloning keeps working.
- The official T3.loss cannot be used: prepare_input_embeds runs under
  torch.inference_mode (no gradients reach the embeddings) and the loss is
  not shifted (each position predicts itself). The forward pass below is
  built from the same parts without either problem, with a next-token loss.
  The community fine-tuning scripts it was compared with also mask the first
  150 speech tokens of every target, which would leave clips under 6 s with
  nothing to learn; that is not copied.
- Conditioning is the owner's voice reference, built exactly as
  ChatterboxMultilingualTTS.prepare_conditionals builds it for generation,
  so the model learns in the situation it will be used in.
- Text goes through the same steps as live Nepali text (digits spelled,
  the final "।" made a full stop, the library's punc_norm), then the Nepali
  tokenizer with the "ne" tag — training and generation see the same tokens.
- Batch size 1 with gradient accumulation: no padding between text and
  speech, which T3's single concatenated sequence handles poorly.
- A held-out set of clips; the best epoch by its loss is the one kept.

Nothing goes live from here. A new version is a new file in the repo, and
the backends keep using the configured file until it is evaluated against
the current one and switched (VOICEFORGE_NE_FILE).
"""

import modal

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install(
        # The same pinned stack as the voice server: training and generation
        # must run the same model code.
        "chatterbox-tts",
        "fastapi[standard]",
        "soundfile",
        "numpy==1.26.4",
        "transformers==5.2.0",
        "safetensors==0.5.3",
        "huggingface_hub",
    )
    .add_local_dir("backend", remote_path="/root/backend")
)

app = modal.App("voiceforge-train-nepali")
secret = modal.Secret.from_name("voiceforge-backend")
runs = modal.Volume.from_name("voiceforge-training-runs", create_if_missing=True)
RUNS_DIR = "/runs"

# Smoke runs check the pipeline end to end on whatever clips exist; real runs
# refuse to train on too little audio, which would only teach it to repeat a
# few sentences.
MIN_MINUTES = 10.0


@app.function(image=image, gpu="A10G", secrets=[secret], volumes={RUNS_DIR: runs}, timeout=4 * 3600)
def train(
    version: str,
    speaker: str,
    voice: str,
    repo: str = "waytobijay/voiceforge-nepali",
    base_file: str = "t3_mtl_nepali_merged.safetensors",
    epochs: int = 6,
    lr: float = 1e-5,
    accum: int = 8,
    exaggeration: float = 0.4,
    holdout: float = 0.05,
    smoke: bool = False,
    push: bool = True,
    app_url: str = "https://audio.bistab.com.np",
) -> dict:
    import io
    import json
    import os
    import random
    import sys
    import time
    import urllib.parse
    import urllib.request

    import librosa
    import numpy as np
    import torch
    import torch.nn.functional as F

    sys.path.insert(0, "/root")
    os.environ.setdefault("VOICEFORGE_VOICES_DIR", "/tmp/voices")
    os.environ.setdefault("VOICEFORGE_NE_MODEL", repo)
    from backend import voiceforge_server as vs  # noqa: E402
    from backend.voiceforge_lang import ne_expand_digits, ne_model_ending  # noqa: E402
    from chatterbox.models.s3tokenizer import S3_SR  # noqa: E402
    from chatterbox.models.t3.modules.cond_enc import T3Cond  # noqa: E402
    from chatterbox.mtl_tts import punc_norm  # noqa: E402

    t0 = time.time()
    run_dir = os.path.join(RUNS_DIR, version)
    os.makedirs(run_dir, exist_ok=True)
    log_lines: list = []

    def log(msg: str) -> None:
        line = f"[{time.time() - t0:7.1f}s] {msg}"
        print(line, flush=True)
        log_lines.append(line)

    # ---- the clips ---------------------------------------------------------
    app_url = (os.environ.get("VOICEFORGE_APP_URL") or app_url).rstrip("/")
    q = urllib.parse.urlencode({"language": "ne", "speaker": speaker, "voice": voice})
    req = urllib.request.Request(
        f"{app_url}/api/internal/training/manifest?{q}",
        headers={"X-Backend-Secret": os.environ["BACKEND_SECRET"]},
    )
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 - our own app
        manifest = json.loads(r.read())
    clips = manifest["samples"]
    minutes = manifest["seconds"] / 60
    log(f"{len(clips)} clips, {minutes:.1f} minutes, speaker {speaker!r}, voice {voice!r}")
    if not clips:
        raise RuntimeError("no clips to train on")
    if minutes < MIN_MINUTES and not smoke:
        raise RuntimeError(
            f"only {minutes:.1f} minutes recorded; a real run needs at least {MIN_MINUTES:.0f} "
            "(record more on the Training data page, or pass --smoke to test the pipeline)"
        )

    def fetch(url: str) -> bytes:
        with urllib.request.urlopen(url, timeout=120) as r:  # noqa: S310 - our own storage
            return r.read()

    # ---- the model: current Nepali checkpoint, as the server loads it ----------
    # Only the Nepali model: the server's other models are not needed here
    # and would take ~3 GB of GPU memory.
    model = vs._load_ne_model(repo, base_file)
    ne_tag = vs._NE_TAG["id"]
    t3 = model.t3
    hp = t3.hp
    device = t3.device
    log(f"loaded {repo}:{base_file} (tag {ne_tag!r}) on {torch.cuda.get_device_name(0)}")

    # Conditioning from the owner's voice reference, built like prepare_conditionals.
    ref_path = "/tmp/reference.wav"
    with open(ref_path, "wb") as f:
        f.write(fetch(manifest["voice"]["audio_url"]))
    model.prepare_conditionals(ref_path, exaggeration=exaggeration)
    ref = model.conds.t3
    speaker_emb = ref.speaker_emb.detach()
    prompt_tokens = ref.cond_prompt_speech_tokens.detach()

    def cond() -> T3Cond:
        # Fresh each step: prepare_conditioning caches the prompt embedding on
        # the object, and a cached one would carry no gradient.
        return T3Cond(
            speaker_emb=speaker_emb,
            cond_prompt_speech_tokens=prompt_tokens,
            emotion_adv=exaggeration * torch.ones(1, 1, 1, device=device),
        ).to(device=device)

    # ---- examples: text tokens and speech tokens, prepared once ----------------
    def text_tokens_for(text: str) -> torch.Tensor:
        prepared = punc_norm(ne_model_ending(ne_expand_digits(text)))
        tok = model.tokenizer.text_to_tokens(prepared, language_id=ne_tag).to(device)
        tok = F.pad(tok, (1, 0), value=hp.start_text_token)
        return F.pad(tok, (0, 1), value=hp.stop_text_token)

    examples = []
    for c in clips:
        try:
            wav, _ = librosa.load(io.BytesIO(fetch(c["audio_url"])), sr=S3_SR, mono=True)
            with torch.no_grad():
                st, sl = model.s3gen.tokenizer.forward([wav.astype(np.float32)])
            speech = torch.atleast_2d(st)[0, : int(sl.reshape(-1)[0])].to(device)
            speech = F.pad(speech, (1, 0), value=hp.start_speech_token)
            speech = F.pad(speech, (0, 1), value=hp.stop_speech_token)
            # text_to_tokens returns (1, T) already; speech is (T,) until [None].
            examples.append({"id": c["id"], "text": text_tokens_for(c["text"]), "speech": speech[None]})
        except Exception as e:  # noqa: BLE001
            log(f"skipped {c['id']}: {e}")
    random.Random(0).shuffle(examples)
    n_val = max(1, int(len(examples) * holdout)) if len(examples) > 4 else 0
    val, trainset = examples[:n_val], examples[n_val:]
    log(f"{len(trainset)} training examples, {len(val)} held out")

    # ---- forward pass and loss --------------------------------------------------
    def loss_for(ex) -> torch.Tensor:
        text, speech = ex["text"], ex["speech"]
        cond_emb = t3.prepare_conditioning(cond())
        te = t3.text_emb(text) + t3.text_pos_emb(text)
        se = t3.speech_emb(speech) + t3.speech_pos_emb(speech)
        embeds = torch.cat([cond_emb, te, se], dim=1)
        out = t3.tfmr(inputs_embeds=embeds, output_hidden_states=True, return_dict=True, use_cache=False)
        h = out.hidden_states[-1]
        lc, lt = cond_emb.size(1), text.size(1)
        text_logits = t3.text_head(h[:, lc : lc + lt])
        speech_logits = t3.speech_head(h[:, lc + lt :])
        # Next-token prediction: position i predicts token i + 1.
        loss_text = F.cross_entropy(text_logits[:, :-1].float().transpose(1, 2), text[:, 1:])
        loss_speech = F.cross_entropy(speech_logits[:, :-1].float().transpose(1, 2), speech[:, 1:])
        return loss_speech + loss_text, loss_speech.detach()

    def evaluate() -> float:
        if not val:
            return float("nan")
        t3.eval()
        total = 0.0
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            for ex in val:
                total += float(loss_for(ex)[1])
        t3.train()
        return total / len(val)

    # Only T3 trains.
    for p in model.ve.parameters():
        p.requires_grad = False
    for p in model.s3gen.parameters():
        p.requires_grad = False
    for p in t3.parameters():
        p.requires_grad = True
    t3.train()
    opt = torch.optim.AdamW([p for p in t3.parameters() if p.requires_grad], lr=lr, weight_decay=0.01)
    steps_per_epoch = max(1, len(trainset) // accum)
    total_steps = (2 if smoke else epochs) * steps_per_epoch
    warmup = max(1, total_steps // 20)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / warmup) * max(0.05, 1 - s / max(1, total_steps))
    )

    best = {"val": evaluate(), "epoch": 0}
    log(f"before training: held-out speech loss {best['val']:.4f}")
    best_state = None
    history = [{"epoch": 0, "val": best["val"]}]
    for epoch in range(1, (2 if smoke else epochs) + 1):
        random.shuffle(trainset)
        running, n = 0.0, 0
        for i, ex in enumerate(trainset):
            with torch.autocast("cuda", dtype=torch.bfloat16):
                loss, speech_loss = loss_for(ex)
            (loss / accum).backward()
            running += float(speech_loss)
            n += 1
            if (i + 1) % accum == 0 or i + 1 == len(trainset):
                torch.nn.utils.clip_grad_norm_(t3.parameters(), 1.0)
                opt.step()
                sched.step()
                opt.zero_grad(set_to_none=True)
        v = evaluate()
        history.append({"epoch": epoch, "train": running / max(1, n), "val": v})
        log(f"epoch {epoch}: train speech loss {running / max(1, n):.4f}, held-out {v:.4f}")
        if not val or v < best["val"]:
            best = {"val": v, "epoch": epoch}
            best_state = {k: t.detach().to("cpu").clone() for k, t in t3.state_dict().items()}

    if best_state is None:
        log("no epoch beat the starting checkpoint on held-out clips; nothing saved")
        return {"version": version, "saved": False, "history": history, "log": log_lines}

    # ---- save and push ------------------------------------------------------------
    from safetensors.torch import save_file

    out_file = f"{version}.safetensors"
    out_path = os.path.join(run_dir, out_file)
    save_file(best_state, out_path)
    meta = {
        "version": version,
        "base": f"{repo}:{base_file}",
        "speaker": speaker,
        "voice": voice,
        "clips": len(examples),
        "minutes": round(minutes, 1),
        "epochs": epochs,
        "best_epoch": best["epoch"],
        "lr": lr,
        "accum": accum,
        "smoke": smoke,
        "history": history,
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(os.path.join(run_dir, f"{version}.json"), "w") as f:
        json.dump(meta, f, indent=1)
    runs.commit()
    log(f"saved {out_file} (best epoch {best['epoch']}, held-out {best['val']:.4f})")

    if push:
        from huggingface_hub import HfApi

        api = HfApi(token=os.environ["HF_TOKEN"])
        api.upload_file(
            path_or_fileobj=out_path,
            path_in_repo=out_file,
            repo_id=repo,
            commit_message=f"{version}: trained on {len(examples)} clips ({minutes:.1f} min) of {speaker}, best epoch {best['epoch']}",
        )
        api.upload_file(
            path_or_fileobj=json.dumps(meta, indent=1).encode(),
            path_in_repo=f"{version}.json",
            repo_id=repo,
            commit_message=f"{version}: training record",
        )
        log(f"pushed to https://huggingface.co/{repo}/blob/main/{out_file}")
    return {**meta, "saved": True, "log": log_lines}


@app.local_entrypoint()
def main(
    version: str,
    speaker: str,
    voice: str,
    repo: str = "waytobijay/voiceforge-nepali",
    base_file: str = "t3_mtl_nepali_merged.safetensors",
    epochs: int = 6,
    lr: float = 1e-5,
    smoke: bool = False,
):
    result = train.remote(
        version=version,
        speaker=speaker,
        voice=voice,
        repo=repo,
        base_file=base_file,
        epochs=epochs,
        lr=lr,
        smoke=smoke,
        push=not smoke,
    )
    print({k: v for k, v in result.items() if k != "log"})
