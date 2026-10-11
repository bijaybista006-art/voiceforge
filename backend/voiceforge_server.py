"""
VoiceForge — shared GPU backend (contract v2).

ONE server used by every provider:
  * Colab / Kaggle  — the notebook downloads this file from GitHub raw
  * Modal           — modal/voiceforge_modal.py imports it

Keeping a single implementation is the point: duplicated server logic between
notebooks and Modal is how the two drift apart and start failing differently.

Contract
--------
GET    /health              -> {ok, provider, gpu, models[], voices_cached[], busy, version}
PUT    /voices/{voice_id}   -> {audio_url, transcript, language} downloads + caches a reference
POST   /generate            -> one chunk of speech; 409 voice_not_cached if unknown
POST   /jobs                -> 202, renders a whole script in a background worker
GET    /jobs/{id}           -> status + per-item metadata (never the audio)
GET    /jobs/{id}/audio/{n} -> one finished file, collected by the gateway
DELETE /jobs/{id}           -> drop a collected job and its files

Every call except /health requires the X-Backend-Secret header.

Why jobs return audio over GET rather than in the callback: Vercel rejects a
request body larger than 4.5 MB, and a 15-minute narration is far bigger. So
the callback carries metadata only and the gateway then pulls each file.
"""

from __future__ import annotations

import base64
import io
import os
import re
import threading
import time
import traceback
import urllib.request
from typing import Any, Dict, List, Optional

# Importable both ways: as a package on Modal and in CI, and as loose files
# in /content/backend on Colab and Kaggle.
try:
    from backend.voiceforge_lang import (
        DEFAULT_ENGINE,
        PAUSE_TAG_SEC,
        change_rate,
        english_for_tts,
        expected_speech_seconds,
        gap_after,
        max_speech_seconds,
        ne_expand_digits,
        ne_prepare,
        parse_prosody,
        plan_engine,
        silence,
        splice,
        split_runs,
        strip_state_prefixes,
        strip_tags,
        tone_settings,
        transliterate_latin,
        trim_speech,
        wants_expressive,
    )
except ImportError:  # pragma: no cover - notebook layout
    from voiceforge_lang import (
        DEFAULT_ENGINE,
        PAUSE_TAG_SEC,
        change_rate,
        english_for_tts,
        expected_speech_seconds,
        gap_after,
        max_speech_seconds,
        ne_expand_digits,
        ne_prepare,
        parse_prosody,
        plan_engine,
        silence,
        splice,
        split_runs,
        strip_state_prefixes,
        strip_tags,
        tone_settings,
        transliterate_latin,
        trim_speech,
        wants_expressive,
    )

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

VERSION = "2.0.0"

# Tuned defaults — these are load-bearing, see .claude_context.md. Chunking and
# normalization happen in the web app (lib/chunker.ts + lib/normalize.ts) so the
# API and the studio produce identical audio; the backend never re-chunks.
DEFAULT_EXAGGERATION = 0.4
DEFAULT_CFG = 0.5
DEFAULT_TEMPERATURE = 0.7
SENTENCE_GAP_SEC = 0.35
PARAGRAPH_GAP_SEC = 0.7
PEAK_DBFS = -1.0

VOICES_DIR = os.environ.get("VOICEFORGE_VOICES_DIR", "/tmp/voiceforge/voices")
os.makedirs(VOICES_DIR, exist_ok=True)

# Finished renders wait here until the gateway collects them. They never travel
# inside the callback: a 15-minute MP3 is ~15 MB and Vercel rejects a request
# body over 4.5 MB, so the callback carries only metadata and the gateway then
# pulls the file with a GET, which has no such limit.
JOBS_DIR = os.environ.get("VOICEFORGE_JOBS_DIR", "/tmp/voiceforge/jobs")
os.makedirs(JOBS_DIR, exist_ok=True)

MODELS: Dict[str, Any] = {}
VOICES: Dict[str, Dict[str, str]] = {}
_GPU_LOCK = threading.Lock()  # one generation at a time: a single GPU
_BUSY = False


# ---------------------------------------------------------------------------
# model loading
# ---------------------------------------------------------------------------

# How many times in a row the model may emit the same speech token before it
# is treated as stuck. 0 leaves the library's own rule in place.
REPEAT_LIMIT = int(os.environ.get("VOICEFORGE_REPEAT_LIMIT", "25") or 0)
# Why the last generation was cut short, if it was. Read by the [gen] log line.
_LAST_STOP = {"why": ""}
# What the alignment check saw on the last take: how many 40 ms frames were
# generated, and at which frame it judged the text to be finished.
_LAST_ALIGN: Dict[str, Any] = {}
# Set per take. When positive, a take is ended this many frames after the
# text is finished, provided at least `min_frames` have been generated.
_TAIL_RULE = {"frames": 0, "min_frames": 0}
# How long the Nepali model may keep going once it has reached the end of its
# text. The last syllable and the danda still have to be spoken after that
# point — about five frames — so ten leaves room and no more.
NE_TAIL_FRAMES = int(os.environ.get("VOICEFORGE_NE_TAIL_FRAMES", "10") or 0)


def _patch_stream_analyzer() -> None:
    """Stop the library ending a take the moment two speech tokens match.

    chatterbox's multilingual path runs an integrity check on every step, and
    one of its rules forces end-of-speech as soon as the last two tokens are
    identical. Its own comment calls that "3x same token in a row"; the code
    checks two. A speech token is 40 ms, and silence, a held vowel or the
    breath before a sentence are all the same token repeated — so the rule
    fires on ordinary speech.

    It is why a chunk could come back as a few words and then nothing, and why
    the Nepali checkpoint, which opens every sentence on two matching tokens,
    returned exactly 0.08 s: two tokens, then a forced stop.

    The rule is replaced, not removed: REPEAT_LIMIT identical tokens (one
    second at the default) still ends the take, which is what the check was
    for. Its other two rules — a tail that runs on after the text is finished,
    and text being read twice — are left exactly as they were.
    """
    if REPEAT_LIMIT <= 0:
        return
    try:
        import logging

        from chatterbox.models.t3.inference import alignment_stream_analyzer as asa

        cls = asa.AlignmentStreamAnalyzer
        if getattr(cls, "_vf_patched", False):
            return
        original = cls.step

        def step(self, logits, next_token=None):
            run = getattr(self, "_vf_run", 0)
            if next_token is not None:
                tok = int(next_token.view(-1)[0].item()) if torch.is_tensor(next_token) else int(next_token)
                run = run + 1 if tok == getattr(self, "_vf_last", None) else 1
                self._vf_last, self._vf_run = tok, run
            # next_token=None keeps the library's own two-token rule dormant;
            # everything else in its step still runs.
            out = original(self, logits, next_token=None)
            if run >= REPEAT_LIMIT:
                _LAST_STOP["why"] = f"same token x{run}"
                out = -(2 ** 15) * torch.ones_like(out)
                out[..., self.eos_idx] = 2 ** 15

            # The check already knows when the text is finished; its own
            # rules then wait for a second or so of evidence before ending
            # the take, and that second is audible as extra sound after the
            # last word. With a tail rule set, the take ends a fixed few
            # frames after the text does. `min_frames` is a guard against
            # the check being wrong about "finished": nothing is cut short
            # before most of the expected speech exists.
            frames = int(getattr(self, "curr_frame_pos", 0))
            done_at = getattr(self, "completed_at", None)
            _LAST_ALIGN.update(
                {
                    "frames": frames,
                    "completed_at": int(done_at) if done_at is not None else None,
                }
            )
            limit = _TAIL_RULE["frames"]
            if (
                limit > 0
                and done_at is not None
                and frames >= _TAIL_RULE["min_frames"]
                and frames - int(done_at) >= limit
            ):
                if not _LAST_STOP["why"]:
                    _LAST_STOP["why"] = f"text finished at frame {int(done_at)}, ended at {frames}"
                out = -(2 ** 15) * torch.ones_like(out)
                out[..., self.eos_idx] = 2 ** 15
            return out

        class _Capture(logging.Handler):
            def emit(self, record):  # noqa: D401
                msg = record.getMessage()
                if "forcing EOS" in msg:
                    _LAST_STOP["why"] = msg.replace("forcing EOS token, ", "")[:120]

        asa.logger.addHandler(_Capture())
        cls.step = step
        cls._vf_patched = True
        print(f"[engine] repetition rule: two-token stop replaced (limit {REPEAT_LIMIT})", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[engine] repetition rule: left as shipped ({e})", flush=True)


# The facts about the most recent take, for the job result.
_LAST_GEN: Dict[str, Any] = {}


def _stream_patch_applied() -> bool:
    try:
        from chatterbox.models.t3.inference import alignment_stream_analyzer as asa

        return bool(getattr(asa.AlignmentStreamAnalyzer, "_vf_patched", False))
    except Exception:  # noqa: BLE001
        return False


def load_models(load_qwen: bool = False) -> List[str]:
    """Load Chatterbox Multilingual (23 languages, incl. English and Hindi)."""
    device = "cuda" if torch.cuda.is_available() else "cpu"
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    _patch_stream_analyzer()

    MODELS["chatterbox"] = ChatterboxMultilingualTTS.from_pretrained(device=device)
    print("chatterbox (multilingual) ready", flush=True)

    # Qwen3 pins a conflicting transformers version, so it stays opt-in.
    if load_qwen:
        try:
            from qwen_tts import Qwen3TTSModel

            MODELS["qwen3"] = Qwen3TTSModel.from_pretrained(
                "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
                device_map=device,
                dtype=torch.float16,
                attn_implementation="sdpa",
            )
            print("qwen3 ready", flush=True)
        except Exception as e:  # pragma: no cover - environment dependent
            print("qwen3 unavailable:", e, flush=True)
    return list(MODELS.keys())


def gpu_name() -> str:
    return torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"


# ---------------------------------------------------------------------------
# audio helpers
# ---------------------------------------------------------------------------

def _peak_normalize(audio: np.ndarray, dbfs: float = PEAK_DBFS) -> np.ndarray:
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak <= 0:
        return audio
    return (audio * ((10 ** (dbfs / 20)) / peak)).astype(np.float32)


def _encode(audio: np.ndarray, sr: int, fmt: str = "wav") -> tuple[bytes, str]:
    """Encode to bytes. Returns (data, actual_format) — MP3 needs a libsndfile
    built with LAME, which not every GPU host has, so we fall back to WAV and
    report which one the caller actually got."""
    buf = io.BytesIO()
    if fmt == "mp3":
        try:
            sf.write(buf, audio, sr, format="MP3")
            return buf.getvalue(), "mp3"
        except Exception:
            buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue(), "wav"


def _wav_b64(audio: np.ndarray, sr: int, fmt: str = "wav") -> str:
    return base64.b64encode(_encode(audio, sr, fmt)[0]).decode()


def _stitch(parts: List[np.ndarray], sr: int, paragraph_breaks: List[bool]) -> np.ndarray:
    """Concatenate chunks with the tuned gaps — same values as the studio."""
    out: List[np.ndarray] = []
    for i, part in enumerate(parts):
        out.append(part)
        if i < len(parts) - 1:
            gap = PARAGRAPH_GAP_SEC if (i < len(paragraph_breaks) and paragraph_breaks[i]) else SENTENCE_GAP_SEC
            out.append(np.zeros(int(gap * sr), dtype=np.float32))
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


# ---------------------------------------------------------------------------
# language engines
# ---------------------------------------------------------------------------
#
# Every language has always run on the multilingual Chatterbox checkpoint.
# A language whose sounds that checkpoint was never trained on — Nepali is the
# first — can ask for an engine of its own. If that engine is not configured,
# or will not load, the job runs on the fallback the gateway supplied and says
# so, because a render in the wrong language that claims success is worse than
# one that admits a substitution.

# Unset by default. Point it at a HuggingFace repo holding a fine-tuned
# Nepali T3 and the "ne" profile starts using it; leave it unset and Nepali
# runs on the Hindi fallback. Deliberately not hardcoded: the published Nepali
# checkpoints are mostly gated, and baking in a repo that 401s would cost
# every Nepali job a failed download before falling back anyway.
#
# Known-working, ungated: Firoj112/chatterbox-nepali-runs, which publishes the
# finished t3_mtl_nepali_final.safetensors as well as the interim epochs. The
# gated mirrors hold the same final file; HF_TOKEN is only needed for those.
NE_MODEL = os.environ.get("VOICEFORGE_NE_MODEL", "").strip()
NE_FILE = os.environ.get("VOICEFORGE_NE_FILE", "t3_mtl_nepali_final.safetensors").strip()
# The language tag the Nepali engine is called with.
#
# The checkpoint was trained with its own tag, "[ne]", which the authors
# registered as text token 2454 — the one extra row that makes its vocabulary
# 2455. Their instructions are explicit that language_id="ne" must be set.
# This used to send "hi" instead, on the theory that the tag only selected
# conditioning. It does far more than that: the tag is the first token of
# every sentence the model was trained on, and fifty epochs moved "[ne]" a
# long way from the Hindi row it was copied from. Fed "[hi]", the fine-tuned
# model sees text unlike anything in its training and stops within a token
# or two, which is where the near-empty Nepali files came from.
#
# "ne" is therefore the default, and _register_ne_tag makes the stock library
# accept it. Set VOICEFORGE_NE_LANG_ID=hi to get the old behaviour back.
NE_LANGUAGE_ID = os.environ.get("VOICEFORGE_NE_LANG_ID", "ne").strip() or "ne"
# What is actually passed at generation time: NE_LANGUAGE_ID once the tag is
# registered on the loaded model, "hi" if that could not be done.
_NE_TAG = {"id": "hi"}

# Engines that failed to load once. Retrying a missing download on every chunk
# of a 100-scene job would add minutes and change nothing.
_ENGINE_FAILED: Dict[str, str] = {}


def _grow_text_vocab(t3, state: Dict[str, Any]) -> None:
    """Widen T3's text embedding and output head to the checkpoint's vocabulary.

    A Nepali fine-tune adds graphemes the base multilingual tokenizer does not
    have, so its text_emb and text_head are a row or two taller. PyTorch
    refuses the whole state_dict over that single mismatch, which is why the
    engine fell back to Hindi and the output never changed.

    The extra ids are appended, so every existing token keeps its row and the
    base tokenizer stays correct. The one new row is the "[ne]" language tag,
    which _register_ne_tag adds to this model's tokenizer.
    """
    import torch.nn as nn  # noqa: PLC0415

    want_rows = state.get("text_emb.weight")
    if want_rows is None:
        return
    want = int(want_rows.shape[0])
    have = int(t3.text_emb.weight.shape[0])
    if want == have:
        return
    if want < have:
        # Never shrink: that would drop tokens the base model can still emit.
        raise RuntimeError(
            f"checkpoint vocabulary ({want}) is smaller than the model's ({have})"
        )

    dim = int(t3.text_emb.weight.shape[1])
    device = t3.text_emb.weight.device
    dtype = t3.text_emb.weight.dtype

    emb = nn.Embedding(want, dim, device=device, dtype=dtype)
    with torch.no_grad():
        emb.weight[:have] = t3.text_emb.weight
    t3.text_emb = emb

    head = getattr(t3, "text_head", None)
    if head is not None and hasattr(head, "weight"):
        new_head = nn.Linear(
            dim, want, bias=getattr(head, "bias", None) is not None,
            device=device, dtype=dtype,
        )
        with torch.no_grad():
            new_head.weight[:have] = head.weight
            if new_head.bias is not None and head.bias is not None:
                new_head.bias[:have] = head.bias
        t3.text_head = new_head

    print(f"[engine] nepali T3: grew text vocabulary {have} -> {want}", flush=True)


def _register_ne_tag(model, want_rows: Optional[int]) -> str:
    """Teach this model instance the "[ne]" tag; return the tag to call it with.

    Two things stand between the stock library and language_id="ne": its
    tokenizer has no "[ne]" token, and generate() refuses any language outside
    its own list. Both are fixed here, for the Nepali instance only — the base
    model has its own tokenizer object and never sees the tag.

    The token must land on the exact row the checkpoint trained, the last one.
    If it lands anywhere else the tag would index the wrong embedding, so that
    case falls back to "hi" loudly rather than guessing.
    """
    if NE_LANGUAGE_ID != "ne":
        print(f"[engine] nepali tag: using '{NE_LANGUAGE_ID}' (set by VOICEFORGE_NE_LANG_ID)", flush=True)
        return NE_LANGUAGE_ID
    try:
        tok = model.tokenizer.tokenizer
        if tok.token_to_id("[ne]") is None:
            tok.add_special_tokens(["[ne]"])
        got = tok.token_to_id("[ne]")
        rows = int(model.t3.text_emb.weight.shape[0])
        expected = (want_rows or rows) - 1
        if got != expected or got >= rows:
            raise RuntimeError(f"[ne] landed on id {got}, checkpoint expects {expected}")

        import chatterbox.mtl_tts as _mtl  # noqa: PLC0415

        _mtl.SUPPORTED_LANGUAGES.setdefault("ne", "Nepali")
        ids = model.tokenizer.encode("नमस्ते", language_id="ne")
        if not ids or ids[0] != got:
            raise RuntimeError(f"tokenizer did not emit [ne] first (got {ids[:3]})")
        print(f"[engine] nepali tag: [ne] registered as text token {got}", flush=True)
        return "ne"
    except Exception as e:  # noqa: BLE001
        print(f"[engine] nepali tag: could not register [ne] ({e}); falling back to [hi]", flush=True)
        return "hi"


def _load_ne_model():
    """Base multilingual Chatterbox with a Nepali T3 swapped in.

    The published Nepali work is a fine-tune of the T3 stage only — the voice
    encoder and the S3 vocoder are unchanged, which is exactly why cloning
    still works. So this is not a from_pretrained of a whole checkpoint: those
    repos ship one weights file and nothing else, and from_pretrained would
    fail looking for the rest.
    """
    if not NE_MODEL:
        raise RuntimeError("no Nepali model configured (set VOICEFORGE_NE_MODEL)")

    from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: PLC0415
    from huggingface_hub import hf_hub_download  # noqa: PLC0415

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ChatterboxMultilingualTTS.from_pretrained(device=device)

    path = (
        NE_MODEL
        if os.path.exists(NE_MODEL)
        else hf_hub_download(
            repo_id=NE_MODEL,
            filename=NE_FILE,
            # Only needed for a gated mirror; harmless when absent.
            token=os.environ.get("HF_TOKEN") or None,
        )
    )

    if path.endswith(".safetensors"):
        from safetensors.torch import load_file  # noqa: PLC0415

        state = load_file(path, device="cpu")
    else:
        state = torch.load(path, map_location="cpu")
        # Trainers wrap the weights in a checkpoint dict more often than not.
        for key in ("model", "state_dict", "t3", "module"):
            if isinstance(state, dict) and key in state and isinstance(state[key], dict):
                state = state[key]
                break

    state = strip_state_prefixes(state)
    _grow_text_vocab(model.t3, state)
    missing, unexpected = model.t3.load_state_dict(state, strict=False)
    matched = len(state) - len(unexpected)
    # Loud on purpose. strict=False means a checkpoint whose keys do not match
    # loads cleanly and changes nothing — the job would then run as ordinary
    # multilingual Chatterbox while claiming to be the Nepali engine.
    print(
        f"[engine] nepali T3: matched {matched}/{len(state)} tensors "
        f"(missing {len(missing)}, unexpected {len(unexpected)})",
        flush=True,
    )
    if matched == 0:
        raise RuntimeError(
            f"{NE_FILE} matched no T3 parameters — wrong file or wrong architecture"
        )

    want = state.get("text_emb.weight")
    _NE_TAG["id"] = _register_ne_tag(model, int(want.shape[0]) if want is not None else None)

    # No model.to(device) here: ChatterboxMultilingualTTS is a wrapper, not an
    # nn.Module, so it has no .to(). from_pretrained already placed it, and the
    # layers grown above are created on the same device and dtype.
    return model


def engine_available(engine: str) -> bool:
    """Is this engine usable right now? Never raises, never retries a known
    failure, and never blocks the languages that do not need it."""
    if engine in _ENGINE_FAILED:
        return False
    if engine == "chatterbox-ne":
        if "chatterbox-ne" in MODELS:
            return True
        if not NE_MODEL:
            _ENGINE_FAILED[engine] = "VOICEFORGE_NE_MODEL is not set"
            print("[engine] chatterbox-ne unavailable: no model configured", flush=True)
            return False
        try:
            MODELS["chatterbox-ne"] = _load_ne_model()
            print(f"[engine] chatterbox-ne ready ({NE_MODEL})", flush=True)
            return True
        except Exception as e:  # noqa: BLE001
            _ENGINE_FAILED[engine] = str(e)[:200]
            print(f"[engine] chatterbox-ne failed to load: {e}", flush=True)
            return False
    _ENGINE_FAILED[engine] = "unknown engine"
    return False


def resolve_engine(
    engine: Optional[str],
    fallback: Optional[Dict[str, Any]],
    params: Dict[str, Any],
) -> Dict[str, Any]:
    """plan_engine, with this process's real model availability."""
    return plan_engine(
        engine,
        fallback,
        params,
        engine_available,
        {
            "exaggeration": DEFAULT_EXAGGERATION,
            "cfg": DEFAULT_CFG,
            "temperature": DEFAULT_TEMPERATURE,
        },
    )


# ---------------------------------------------------------------------------
# generation
# ---------------------------------------------------------------------------

def _generate_chunk(
    text: str,
    voice_id: str,
    model: str = "chatterbox",
    seed: int = 0,
    language: str = "en",
    engine: str = DEFAULT_ENGINE,
    exaggeration: float = DEFAULT_EXAGGERATION,
    cfg: float = DEFAULT_CFG,
    temperature: float = DEFAULT_TEMPERATURE,
) -> tuple[np.ndarray, int, float]:
    if voice_id not in VOICES:
        raise KeyError("voice_not_cached")
    if model not in MODELS:
        raise ValueError(f"{model} not loaded")

    torch.manual_seed(seed)
    ref = VOICES[voice_id]
    t0 = time.time()

    # A language engine selects a different loaded checkpoint; the generation
    # call itself is identical, which is why nothing else here changes.
    if engine == "chatterbox-ne" and "chatterbox-ne" in MODELS:
        model = "chatterbox-ne"
        # The tag the checkpoint was trained with — see NE_LANGUAGE_ID.
        language = _NE_TAG["id"]

    if model in ("chatterbox", "chatterbox-ne"):
        import inspect

        kwargs = {
            "language_id": language,
            "audio_prompt_path": ref["path"],
            "exaggeration": float(exaggeration),
            "cfg_weight": float(cfg),
            "temperature": float(temperature),
        }
        accepted = inspect.signature(MODELS[model].generate).parameters
        kwargs = {k: v for k, v in kwargs.items() if k in accepted}
        _LAST_STOP["why"] = ""
        _LAST_ALIGN.clear()
        if model == "chatterbox-ne" and NE_TAIL_FRAMES > 0:
            # 25 frames a second. The guard is 60% of what the words should
            # need, so a wrong "finished" early in a sentence cannot end it.
            _TAIL_RULE["frames"] = NE_TAIL_FRAMES
            _TAIL_RULE["min_frames"] = int(expected_speech_seconds(text) * 25 * 0.6)
        else:
            _TAIL_RULE["frames"] = 0
            _TAIL_RULE["min_frames"] = 0
        try:
            wav = MODELS[model].generate(text, **kwargs)
        finally:
            _TAIL_RULE["frames"] = 0
        audio = wav.squeeze(0).cpu().numpy()
        sr = MODELS[model].sr
        # One line per take. Without it a bad render can only be described,
        # never diagnosed: this says which model and tag ran, how much audio
        # came back for how much text, and whether a check cut it short.
        _LAST_GEN.clear()
        _LAST_GEN.update(
            {
                "model": model,
                "tag": language,
                "chars": len(text),
                "audio": round(len(audio) / max(1, sr), 2),
                "stop": _LAST_STOP["why"] or "natural",
                "frames": _LAST_ALIGN.get("frames"),
                "text_done_at": _LAST_ALIGN.get("completed_at"),
                "exaggeration": float(exaggeration),
                "cfg": float(cfg),
                "temperature": float(temperature),
            }
        )
        print(
            f"[gen] model={model} tag={language} chars={len(text)} "
            f"audio={len(audio) / max(1, sr):.2f}s "
            f"stop={_LAST_STOP['why'] or 'natural'}",
            flush=True,
        )
    else:
        wavs, out_sr = MODELS["qwen3"].generate_voice_clone(
            text=text, language="English", ref_audio=ref["path"], ref_text=ref.get("transcript") or None
        )
        audio = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
        if torch.is_tensor(audio):
            audio = audio.cpu().numpy()
        audio = np.asarray(audio, dtype=np.float32).squeeze()
        sr = int(out_sr)

    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return np.asarray(audio, dtype=np.float32), int(sr), round(time.time() - t0, 2)


def cache_voice(voice_id: str, audio_url: str, transcript: str = "", language: str = "en") -> float:
    """Download a reference clip (from Blob) and cache it on local disk."""
    path = os.path.join(VOICES_DIR, f"{voice_id}.wav")
    with urllib.request.urlopen(audio_url, timeout=120) as resp:  # noqa: S310 - our own Blob URL
        raw = resp.read()
    data, sr = sf.read(io.BytesIO(raw))
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    sf.write(path, data, sr)
    VOICES[voice_id] = {"path": path, "transcript": (transcript or "").strip(), "language": language}
    return len(data) / sr


# ---------------------------------------------------------------------------
# expressive Nepali: tone tags, Nepali + English code-switching, clean endings
# ---------------------------------------------------------------------------
#
# Opt-in per request (code_switch / prosody_tags / speed). The decisions live
# in voiceforge_lang.py where CI can test them; this part only drives models.

def _flag(v: Any) -> bool:
    return v is True or str(v).lower() in ("1", "true", "yes")


def _cache_refs(refs: Dict[str, Any]) -> Dict[str, str]:
    """Cache the linked reference voices; return {slot: voice_id} for the ones
    that are usable. A ref that fails to download is skipped, never fatal —
    the main voice still speaks that part."""
    usable: Dict[str, str] = {}
    for slot, ref in (refs or {}).items():
        if not isinstance(ref, dict) or not ref.get("voice_id"):
            continue
        vid = str(ref["voice_id"])
        try:
            if vid not in VOICES and ref.get("audio_url"):
                cache_voice(vid, ref["audio_url"], ref.get("transcript", ""), ref.get("language", "en"))
            if vid in VOICES:
                usable[str(slot)] = vid
        except Exception as e:  # noqa: BLE001
            print(f"[expressive] ref {slot}={vid} unavailable: {e}", flush=True)
    return usable


def _gen_clean(
    text: str,
    voice_id: str,
    *,
    model: str,
    engine: str,
    language: str,
    st: Dict[str, float],
    seed: int,
) -> tuple:
    """Generate, then cut anything the model said after the text ended.

    A take whose raw length is far beyond what the words could need is a
    hallucinated tail; it is re-rolled with a new seed (up to 3 takes) and the
    shortest take wins if none is clean.
    Returns (audio, sr, takes).
    """
    cap = max_speech_seconds(text)
    expected = expected_speech_seconds(text)
    best = None
    sr = 24000
    for take in range(3):
        audio, sr, _ = _generate_chunk(
            text,
            voice_id,
            model=model,
            seed=seed + take * 7919,
            language=language,
            engine=engine,
            exaggeration=st["exaggeration"],
            cfg=st["cfg"],
            temperature=st["temperature"],
        )
        raw = len(audio) / max(1, sr)
        if best is None or raw < best[1]:
            best = (audio, raw)
        # Trailing silence is normal; only far-too-long takes are re-rolled.
        if raw <= cap * 1.5 + 0.6:
            return trim_speech(audio, sr, max_seconds=cap, expected=expected), sr, take + 1
    return trim_speech(best[0], sr, max_seconds=cap, expected=expected), sr, 3


def _render_expressive(
    job: Dict[str, Any], chunks: List[str], plan: Dict[str, Any], params: Dict[str, Any]
) -> tuple:
    """One audio array per input chunk, plus metadata for the result."""
    voice_id = job["voice_id"]
    refs = _cache_refs(job.get("voice_refs") or {})
    code_switch = _flag(params.get("code_switch"))
    prosody = _flag(params.get("prosody_tags"))
    try:
        speed = float(params.get("speed") or 1.0)
    except (TypeError, ValueError):
        speed = 1.0
    speed = min(1.4, max(0.8, speed))
    lexicon = params.get("lexicon") if isinstance(params.get("lexicon"), dict) else None
    model = str(params.get("model", "chatterbox") or "chatterbox")
    seed0 = int(params.get("seed", 0) or 0)
    base = {
        "exaggeration": plan["exaggeration"],
        "cfg": plan["cfg"],
        "temperature": plan["temperature"],
    }
    # English runs speak with the linked English reference when there is one:
    # same person, recorded speaking English, so the English model has the
    # right accent to copy instead of a Nepali-speaking clip.
    en_voice = refs.get("en") or voice_id

    out: List[np.ndarray] = []
    segments: List[Dict[str, Any]] = []
    sr = 24000
    tone: Optional[str] = None
    n = 0
    takes = 0
    tones_used: set = set()

    for ci, chunk in enumerate(chunks):
        text = chunk if prosody else strip_tags(chunk)
        sentences, tone = parse_prosody(text, tone if prosody else None)
        pieces: List[np.ndarray] = []
        t = 0.0
        for s in sentences:
            st = tone_settings(s["tone"] if prosody else None, base)
            if s["tone"]:
                tones_used.add(s["tone"])
            if prosody and s["pause_before"] and pieces:
                pieces.append(silence(PAUSE_TAG_SEC, sr))
                t += PAUSE_TAG_SEC
            has_latin = bool(re.search(r"[A-Za-z]", s["text"]))
            runs = split_runs(s["text"]) if (code_switch and has_latin) else [{"lang": "ne", "text": s["text"]}]
            ne_voice = refs.get(s["tone"] or "") or voice_id
            run_audio: List[np.ndarray] = []
            run_meta: List[Dict[str, Any]] = []
            for ri, r in enumerate(runs):
                n += 1
                if r["lang"] == "en":
                    spoken = english_for_tts(r["text"], final=ri == len(runs) - 1)
                    audio, sr, k = _gen_clean(
                        spoken, en_voice, model="chatterbox", engine=DEFAULT_ENGINE,
                        language="en", st=st, seed=seed0 + n,
                    )
                    engine_name = "chatterbox-en"
                else:
                    spoken = ne_expand_digits(transliterate_latin(r["text"], lexicon))
                    audio, sr, k = _gen_clean(
                        spoken, ne_voice, model=model, engine=plan["engine"],
                        language=plan["language"], st=st, seed=seed0 + n,
                    )
                    engine_name = plan["engine_used"]
                takes += k
                run_audio.append(audio)
                run_meta.append({"lang": r["lang"], "text": spoken, "engine": engine_name, "takes": k})

            sentence = splice(run_audio, sr, gap=0.02) if len(run_audio) > 1 else run_audio[0]
            sentence = change_rate(sentence, sr, st["rate"] * speed)
            dur = len(sentence) / sr
            segments.append(
                {
                    "chunk": ci,
                    "start": round(t, 2),
                    "end": round(t + dur, 2),
                    "tone": s["tone"],
                    "runs": run_meta,
                }
            )
            pieces.append(sentence)
            t += dur
            gap = gap_after(s["text"])
            pieces.append(silence(gap, sr))
            t += gap
        if pieces:
            pieces.pop()  # the chunk gap belongs to the stitcher, not here
        out.append(np.concatenate(pieces) if pieces else silence(0.2, sr))

    meta = {
        "params_used": {
            "code_switch": code_switch,
            "prosody_tags": prosody,
            "speed": speed,
            "en_voice": refs.get("en"),
            "tone_voices": {k: v for k, v in refs.items() if k != "en"},
            "tones": sorted(tones_used),
            "takes": takes,
            "runs": n,
        },
        "segments": segments,
    }
    return out, sr, meta


def _place_segments(
    segments: List[Dict[str, Any]], lengths: List[float], breaks: List[bool], mode: str
) -> List[Dict[str, Any]]:
    """Make segment times absolute in the stitched file (items keep their own)."""
    if mode == "items":
        return segments
    offsets: List[float] = []
    t = 0.0
    for i, length in enumerate(lengths):
        offsets.append(t)
        t += length
        if i < len(lengths) - 1:
            t += PARAGRAPH_GAP_SEC if (i < len(breaks) and breaks[i]) else SENTENCE_GAP_SEC
    placed = []
    for seg in segments:
        off = offsets[seg["chunk"]] if seg["chunk"] < len(offsets) else 0.0
        placed.append({**seg, "start": round(seg["start"] + off, 2), "end": round(seg["end"] + off, 2)})
    return placed


# ---------------------------------------------------------------------------
# job worker — long renders can't live inside one HTTP request
# ---------------------------------------------------------------------------

JOBS: Dict[str, Dict[str, Any]] = {}
_JOB_LOCK = threading.Lock()


def _post_json(url: str, payload: dict, token: str, timeout: int = 60) -> None:
    body = json_dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "X-Callback-Token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - our own app URL
        resp.read()


def json_dumps(obj: Any) -> str:
    import json

    return json.dumps(obj)


def _run_job(job: Dict[str, Any]) -> None:
    """Render every chunk sequentially, write the results to disk, then tell
    the gateway they're ready. The gateway collects the files itself."""
    global _BUSY
    job_id = job["job_id"]
    chunks: List[str] = job["chunks"]
    breaks: List[bool] = job.get("paragraph_breaks") or [False] * len(chunks)
    params = job.get("params") or {}
    fmt = job.get("format", "mp3")
    mode = job.get("mode", "stitch")
    callback_url = job.get("callback_url")
    token = job.get("callback_token", "")

    t0 = time.time()
    rendered: List[np.ndarray] = []
    sr = 24000
    try:
        # Cache the reference clip here if we don't already have it. The
        # gateway sends it with the job precisely so this can happen in the
        # worker: downloading a clip onto a cold container can take longer
        # than the gateway's own request is allowed to live, so doing it there
        # failed the whole job instead of just being slow.
        voice_meta = job.get("voice") or {}
        if job["voice_id"] not in VOICES and voice_meta.get("audio_url"):
            cache_voice(
                job["voice_id"],
                voice_meta["audio_url"],
                voice_meta.get("transcript", ""),
                voice_meta.get("language", "en"),
            )

        # Which engine actually runs. Decided once per job, not per chunk, so
        # a 100-scene narration cannot change voice halfway through.
        plan = resolve_engine(job.get("engine"), job.get("fallback"), params)
        with _JOB_LOCK:
            JOBS[job_id]["engine_used"] = plan["engine_used"]
        if plan["engine_used"] != plan["engine"] or plan["engine"] != job.get("engine", plan["engine"]):
            print(f"[job] {job_id} engine={plan['engine']} lang={plan['language']} used={plan['engine_used']}", flush=True)

        is_ne = str(params.get("language", "")).lower() == "ne" or plan["engine"] == "chatterbox-ne"

        # Expressive Nepali (opt-in): tone tags, Nepali + English
        # code-switching, tail trimming and speed. Any failure falls back to
        # the plain path below, so opting in can never cost a render.
        expressive_meta: Optional[Dict[str, Any]] = None
        if is_ne and wants_expressive(params):
            try:
                with _GPU_LOCK:
                    _BUSY = True
                    rendered, sr, expressive_meta = _render_expressive(job, chunks, plan, params)
                    _BUSY = False
                with _JOB_LOCK:
                    JOBS[job_id]["progress"] = 100
            except Exception as e:  # noqa: BLE001
                _BUSY = False
                rendered = []
                expressive_meta = {"params_used": {"error": str(e)[:200]}}
                print(f"[job] {job_id} expressive path failed, plain render instead: {e}", flush=True)

        # Nepali prep. Applied whenever the *request* asked for Nepali, not
        # only when a Nepali model ran: the text is Nepali either way, and
        # digits read as English numerals would be wrong on the fallback too.
        if is_ne and not rendered:
            # Tone tags are directions, never words to speak.
            chunks = [strip_tags(c) or c for c in chunks]
            if mode == "items":
                # One audio file per input line is the contract here, so the
                # count must not change — expand digits, but never re-split.
                chunks = [ne_expand_digits(c) for c in chunks]
            else:
                chunks = [c for ch in chunks for c in ne_prepare(ch)] or chunks

        diag: List[Dict[str, Any]] = []
        with _GPU_LOCK:
            _BUSY = True
            for i, text in enumerate(chunks if not rendered else []):
                if is_ne:
                    # Nepali takes are checked against how long the words
                    # could honestly need; see _gen_clean. A lone short line
                    # is where the model runs on past the text.
                    audio, sr, takes = _gen_clean(
                        text,
                        job["voice_id"],
                        model=params.get("model", "chatterbox"),
                        engine=plan["engine"],
                        language=plan["language"],
                        st={
                            "exaggeration": plan["exaggeration"],
                            "cfg": plan["cfg"],
                            "temperature": plan["temperature"],
                        },
                        seed=int(params.get("seed", 0)) + i,
                    )
                    rendered.append(audio)
                    diag.append(
                        {
                            **_LAST_GEN,
                            "raw_audio": _LAST_GEN.get("audio"),
                            "audio": round(len(audio) / max(1, sr), 2),
                            "takes": takes,
                        }
                    )
                    with _JOB_LOCK:
                        JOBS[job_id]["progress"] = round((i + 1) / max(1, len(chunks)) * 100)
                    continue
                audio, sr, _ = _generate_chunk(
                    text,
                    job["voice_id"],
                    model=params.get("model", "chatterbox"),
                    seed=int(params.get("seed", 0)) + i,
                    language=plan["language"],
                    exaggeration=plan["exaggeration"],
                    cfg=plan["cfg"],
                    temperature=plan["temperature"],
                    engine=plan["engine"],
                )
                rendered.append(audio)
                diag.append(dict(_LAST_GEN))
                with _JOB_LOCK:
                    JOBS[job_id]["progress"] = round((i + 1) / max(1, len(chunks)) * 100)
            _BUSY = False

        # mode "items" keeps one file per input line (the Reel case); "stitch"
        # joins them with the tuned gaps into a single narration.
        outputs = (
            [_peak_normalize(a) for a in rendered]
            if mode == "items"
            else [_peak_normalize(_stitch(rendered, sr, breaks))]
        )

        items: List[Dict[str, Any]] = []
        actual_fmt = fmt
        for index, audio in enumerate(outputs):
            data, actual_fmt = _encode(audio, sr, fmt)
            path = os.path.join(JOBS_DIR, f"{job_id}-{index}.{actual_fmt}")
            with open(path, "wb") as fh:
                fh.write(data)
            items.append(
                {
                    "index": index,
                    "path": path,
                    "bytes": len(data),
                    "duration": round(len(audio) / sr, 2),
                }
            )

        result: Dict[str, Any] = {
            "status": "done",
            "mode": mode,
            "format": actual_fmt,
            "sample_rate": sr,
            "gen_seconds": round(time.time() - t0, 2),
            "duration": round(sum(i["duration"] for i in items), 2),
            # Which engine really ran, so a fallback is visible in the result
            # rather than only audible in the output.
            "engine_used": plan["engine_used"],
            "items": items,
        }
        if diag:
            # What each chunk actually did, carried in the result so a short
            # or silent render can be read off the job instead of the logs.
            result["diagnostics"] = {
                "build": {
                    "repeat_rule_patched": REPEAT_LIMIT > 0 and _stream_patch_applied(),
                    "repeat_limit": REPEAT_LIMIT,
                    "ne_tag": _NE_TAG["id"],
                },
                "chunks": diag[:200],
            }
        if expressive_meta:
            result["params_used"] = expressive_meta.get("params_used")
            if expressive_meta.get("segments"):
                result["segments"] = _place_segments(
                    expressive_meta["segments"],
                    [len(a) / sr for a in rendered],
                    breaks,
                    mode,
                )
        with _JOB_LOCK:
            JOBS[job_id].update(result)
        if callback_url:
            # Metadata only. The gateway collects the audio with
            # GET /jobs/{id}/audio/{index} once it sees this.
            _post_json(
                callback_url,
                {
                    **{k: v for k, v in result.items() if k != "items"},
                    "job_id": job_id,
                    "items": [
                        {k: v for k, v in i.items() if k != "path"} for i in items
                    ],
                },
                token,
            )
    except Exception as e:
        _BUSY = False
        err = f"{e}\n{traceback.format_exc()[-1200:]}"
        with _JOB_LOCK:
            JOBS[job_id].update({"status": "error", "error": str(e)[:600]})
        if callback_url:
            try:
                _post_json(callback_url, {"job_id": job_id, "status": "error", "error": str(e)[:600]}, token)
            except Exception:
                pass
        print("[job]", job_id, "failed:", err, flush=True)


# ---------------------------------------------------------------------------
# app
# ---------------------------------------------------------------------------

def create_app(provider: str = "custom", with_render: bool = True) -> FastAPI:
    app = FastAPI(title="VoiceForge backend", version=VERSION)
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    def _check(secret: Optional[str]) -> None:
        expected = os.environ.get("BACKEND_SECRET")
        # If no secret is configured the backend is open — acceptable for a
        # throwaway Colab tunnel, but the app always sends one.
        if expected and secret != expected:
            raise HTTPException(status_code=401, detail="bad backend secret")

    # Long-form rendering lives in its own module with no torch dependency, so
    # one notebook session can serve TTS and video without a second Run All.
    # If the file is missing (an older notebook), TTS still works on its own.
    render_mounted = False
    if with_render:
        try:
            from backend.voiceforge_render import create_render_router

            app.include_router(create_render_router(_check))
            render_mounted = True
        except Exception as e:  # noqa: BLE001
            print("[voiceforge] render routes unavailable:", e, flush=True)

    @app.get("/health")
    def health() -> dict:
        return {
            "ok": True,
            "provider": provider,
            "gpu": gpu_name(),
            "models": list(MODELS.keys()),
            "voices_cached": list(VOICES.keys()),
            "busy": _BUSY,
            "version": VERSION,
            "capabilities": ["tts"] + (["render"] if render_mounted else []),
        }

    @app.put("/voices/{voice_id}")
    async def put_voice(
        voice_id: str, request: Request, x_backend_secret: Optional[str] = Header(None)
    ) -> dict:
        _check(x_backend_secret)
        body = await request.json()
        try:
            duration = cache_voice(
                voice_id,
                body["audio_url"],
                body.get("transcript", ""),
                body.get("language", "en"),
            )
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"could not cache voice: {e}") from e
        return {"ok": True, "voice_id": voice_id, "duration": round(duration, 2)}

    @app.post("/generate")
    async def generate(request: Request, x_backend_secret: Optional[str] = Header(None)):
        global _BUSY
        _check(x_backend_secret)
        p = await request.json()
        try:
            # Same engine resolution as the job worker. Without it the studio
            # sent language "ne" to a model that has no such language and got
            # a hard 500, while the identical text through a job spoke Nepali.
            plan = resolve_engine(p.get("engine"), p.get("fallback"), p)
            if str(p.get("language", "")).lower() == "ne" or plan["engine"] == "chatterbox-ne":
                # The studio's one-chunk path gets the same protection a job
                # does: a take that runs on past the text is re-rolled, and
                # whatever is left after the words is cut.
                t0 = time.time()
                with _GPU_LOCK:
                    _BUSY = True
                    audio, sr, _takes = _gen_clean(
                        p["text"],
                        p["voice_id"],
                        model=p.get("model", "chatterbox"),
                        engine=plan["engine"],
                        language=plan["language"],
                        st={
                            "exaggeration": plan["exaggeration"],
                            "cfg": plan["cfg"],
                            "temperature": plan["temperature"],
                        },
                        seed=int(p.get("seed", 0)),
                    )
                    _BUSY = False
                return {
                    "audio_b64": _wav_b64(audio, sr),
                    "sample_rate": sr,
                    "duration": round(len(audio) / sr, 2),
                    "gen_seconds": round(time.time() - t0, 2),
                }
            with _GPU_LOCK:
                _BUSY = True
                audio, sr, gen_seconds = _generate_chunk(
                    p["text"],
                    p["voice_id"],
                    model=p.get("model", "chatterbox"),
                    seed=int(p.get("seed", 0)),
                    language=plan["language"],
                    exaggeration=plan["exaggeration"],
                    cfg=plan["cfg"],
                    temperature=plan["temperature"],
                    engine=plan["engine"],
                )
                _BUSY = False
        except KeyError:
            _BUSY = False
            # The gateway reacts to this by PUTting the voice and retrying once.
            return JSONResponse({"error": "voice_not_cached"}, status_code=409)
        except Exception as e:
            _BUSY = False
            return JSONResponse({"error": str(e)[:600]}, status_code=500)

        return {
            "audio_b64": _wav_b64(audio, sr),
            "sample_rate": sr,
            "duration": round(len(audio) / sr, 2),
            "gen_seconds": gen_seconds,
        }

    @app.post("/jobs", status_code=202)
    async def create_job(request: Request, x_backend_secret: Optional[str] = Header(None)) -> dict:
        _check(x_backend_secret)
        job = await request.json()
        job_id = job["job_id"]
        with _JOB_LOCK:
            JOBS[job_id] = {"status": "running", "progress": 0}
        threading.Thread(target=_run_job, args=(job,), daemon=True).start()
        return {"accepted": True, "job_id": job_id}

    @app.get("/jobs/{job_id}")
    def job_status(job_id: str, x_backend_secret: Optional[str] = Header(None)) -> dict:
        _check(x_backend_secret)
        with _JOB_LOCK:
            job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="unknown job")
        # Status polling must stay small: send item metadata, never the audio
        # and never local paths.
        out = {k: v for k, v in job.items() if k != "items"}
        if job.get("items"):
            out["items"] = [
                {k: v for k, v in i.items() if k != "path"} for i in job["items"]
            ]
        return out

    @app.get("/jobs/{job_id}/audio/{index}")
    def job_audio(
        job_id: str, index: int, x_backend_secret: Optional[str] = Header(None)
    ):
        """Hand one finished file to the gateway, which streams it into Blob.

        This is the half of the contract that dodges Vercel's 4.5 MB request
        body limit — a response of any size is fine."""
        _check(x_backend_secret)
        with _JOB_LOCK:
            job = JOBS.get(job_id)
        if not job or job.get("status") != "done":
            raise HTTPException(status_code=404, detail="job not finished")
        items = job.get("items") or []
        if index < 0 or index >= len(items):
            raise HTTPException(status_code=404, detail="no such item")
        path = items[index]["path"]
        if not os.path.exists(path):
            raise HTTPException(status_code=410, detail="file already collected")
        media = "audio/mpeg" if path.endswith(".mp3") else "audio/wav"
        return FileResponse(path, media_type=media, filename=os.path.basename(path))

    @app.delete("/jobs/{job_id}")
    def job_delete(job_id: str, x_backend_secret: Optional[str] = Header(None)) -> dict:
        """Called once the gateway has everything, so a long Colab session
        doesn't slowly fill its disk with collected renders."""
        _check(x_backend_secret)
        with _JOB_LOCK:
            job = JOBS.pop(job_id, None)
        for item in (job or {}).get("items") or []:
            try:
                os.remove(item["path"])
            except OSError:
                pass
        return {"ok": True}

    return app
