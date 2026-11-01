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
import gc
import io
import os
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.request
from typing import Any, Dict, List, Optional

# Importable both ways: as a package on Modal and in CI, and as loose files
# in /content/backend on Colab and Kaggle.
try:
    from backend.voiceforge_lang import (
        NE_MAX_CHUNK_CHARS,
        ne_cut_runaway,
        ne_duration_cap,
        ne_ending_frames,
        ne_pace,
        ne_split_for_retry,
        ne_trim_trailing_blip,
        ne_trim_leading,
        ne_model_ending,
        ne_take_problem,
        ne_mark_pauses,
        ne_pace_factor,
        ne_speech_rate,
        ne_plain_text,
        EngineUnavailable,
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
        ne_split_mix,
        ne_heard_error,
        ne_heard_score,
        NE_HEARD_MAX_ERR,
        studio_polish,
        strip_tags,
        tone_settings,
        transliterate_latin,
        trim_speech,
        wants_expressive,
    )
except ImportError:  # pragma: no cover - notebook layout
    from voiceforge_lang import (
        NE_MAX_CHUNK_CHARS,
        ne_cut_runaway,
        ne_duration_cap,
        ne_ending_frames,
        ne_pace,
        ne_split_for_retry,
        ne_trim_trailing_blip,
        ne_trim_leading,
        ne_model_ending,
        ne_take_problem,
        ne_mark_pauses,
        ne_pace_factor,
        ne_speech_rate,
        ne_plain_text,
        EngineUnavailable,
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
        ne_split_mix,
        ne_heard_error,
        ne_heard_score,
        NE_HEARD_MAX_ERR,
        studio_polish,
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
# Silence between sentences voiced as separate takes. With each take's own
# lead-in and fade this comes to ~0.75 s, close to how the speaker pauses
# after "।" in their own recordings (0.35 sounded rushed).
SENTENCE_GAP_SEC = 0.55
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
# The presenter and AI video engines take turns through this one: on Kaggle
# T4 x2 both run on the second GPU, and loading both at once ran it out of
# memory. Lock order everywhere: an engine's own lock, this, then _GPU_LOCK.
_ENGINE_LOCK = threading.Lock()

# When this backend last did (or was asked to do) real work. A notebook uses
# it to stop itself after a stretch of doing nothing, so a forgotten tab does
# not keep spending the free GPU allowance (see notebook_runner.py). Health
# checks do not count; any other request, and anything still running, does.
_LAST_WORK = [time.time()]


def note_work() -> None:
    _LAST_WORK[0] = time.time()
_LOAD_LOCK = threading.Lock()  # one model load at a time; see engine_available
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
# Which loaded model produced the last take ("chatterbox-ne" or the fallback).
_TAIL_SEEN = {"model": ""}
# How long the Nepali model may keep going once it has reached the end of its
# text. Measured on seven takes at 40 ms a frame: by the frame the check
# reports "finished", the speech is already over — every frame after it was
# quiet — and in two of the seven a stray blip of sound began five to seven
# frames later. Four frames keeps a margin for a slow last syllable and ends
# the take before that blip can start.
NE_TAIL_FRAMES = int(os.environ.get("VOICEFORGE_NE_TAIL_FRAMES", "6") or 0)
# The longest the model may stay on the last letter before the take is ended
# anyway. A long final vowel was measured at six or more frames of real,
# loud speech; this is well clear of that.
NE_LINGER_FRAMES = int(os.environ.get("VOICEFORGE_NE_LINGER_FRAMES", "15") or 15)


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
            # Where in the text the model is, frame by frame. Kept so the end
            # of a take can be judged against what was actually being said
            # at each moment, not against loudness alone.
            trace = _LAST_ALIGN.setdefault("trace", [])
            try:
                trace.append(int(self.text_position))
                _LAST_ALIGN["text_tokens"] = int(self.alignment.shape[1])
            except Exception:  # noqa: BLE001
                pass
            _LAST_ALIGN.update(
                {
                    "frames": frames,
                    "completed_at": int(done_at) if done_at is not None else None,
                }
            )
            # When to end the take. The check's own "finished" fires when the
            # model reaches the last letter, and a fixed few frames after that
            # was wrong in both directions: measured against the audio, the
            # last letter can carry a whole syllable (a final word was being
            # cut off while still loud), and the sound is over once the model
            # moves on to the closing punctuation. So the take ends shortly
            # after the model reaches that punctuation — the second-to-last
            # text token — and a ceiling on lingering at the last letter
            # catches a take that never moves on.
            limit = _TAIL_RULE["frames"]
            if limit > 0 and frames >= _TAIL_RULE["min_frames"]:
                try:
                    pos = int(self.text_position)
                    tokens = int(self.alignment.shape[1])
                except Exception:  # noqa: BLE001
                    pos, tokens = -1, 0
                if tokens and pos >= tokens - 2 and getattr(self, "_vf_punct_at", None) is None:
                    self._vf_punct_at = frames
                punct_at = getattr(self, "_vf_punct_at", None)
                _LAST_ALIGN["punct_at"] = punct_at
                # Two ways to be finished, whichever comes first. Left to
                # itself the model holds the last vowel of a sentence for
                # a quarter of a second or more before it moves on to the
                # punctuation, and a held last word sounds drawn out. So the
                # time it may spend on the last letter is limited as well,
                # and that limit is the one that is adjustable.
                # How long the final syllable may sound after the model reaches
                # the closing punctuation; see NE_PUNCT_FRAMES.
                at_punct = punct_at is not None and frames - punct_at >= (
                    _NE_REQUEST.get("punct_frames") or NE_PUNCT_FRAMES
                )
                lingering = done_at is not None and frames - int(done_at) >= limit
                if at_punct or lingering:
                    if not _LAST_STOP["why"]:
                        _LAST_STOP["why"] = (
                            f"reached the closing punctuation at frame {punct_at}, ended at {frames}"
                            if at_punct
                            else f"lingered on the last letter from frame {int(done_at)}, ended at {frames}"
                        )
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


# The vocoder knows 6561 speech tokens. The language model's output layer has
# 8194 slots, so it is able to emit ids the vocoder has no entry for.
SPEECH_VOCAB_SIZE = 6561


def _guard_vocoder(model) -> None:
    """Drop speech tokens the vocoder cannot decode before they reach it.

    The library's English pipeline does this (tts.py: speech_tokens[speech_tokens
    < 6561]); its multilingual pipeline does not, and the vocoder's own filter
    is commented out. One stray id is then an out-of-range index on the GPU.
    That raises "CUDA error: device-side assert triggered", and a device-side
    assert does not just fail the take — it leaves the whole CUDA context
    unusable, so every job after it fails with the same message until the
    process is restarted.

    A dropped token costs 40 ms of one take. Wrapped per instance, so the base
    and the Nepali model are each protected.
    """
    try:
        gen = model.s3gen
        if getattr(gen, "_vf_guarded", False):
            return
        original = gen.inference

        def inference(*args, **kwargs):
            tokens = kwargs.get("speech_tokens")
            if tokens is not None and torch.is_tensor(tokens):
                keep = tokens < SPEECH_VOCAB_SIZE
                dropped = int((~keep).sum().item())
                if dropped:
                    print(f"[gen] dropped {dropped} speech token(s) the vocoder cannot decode", flush=True)
                    _LAST_STOP["dropped"] = _LAST_STOP.get("dropped", 0) + dropped
                    kwargs["speech_tokens"] = tokens[keep]
            return original(*args, **kwargs)

        gen.inference = inference
        gen._vf_guarded = True
    except Exception as e:  # noqa: BLE001
        print(f"[engine] vocoder guard not installed ({e})", flush=True)


def load_models(load_qwen: bool = False) -> List[str]:
    """Load Chatterbox Multilingual (23 languages, incl. English and Hindi)."""
    device = "cuda" if torch.cuda.is_available() else "cpu"
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    _patch_stream_analyzer()
    _patch_punc_norm()
    MODELS["chatterbox"] = ChatterboxMultilingualTTS.from_pretrained(device=device)
    _guard_vocoder(MODELS["chatterbox"])
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
            # Highest quality. libsndfile's default came out ~64 kbit/s VBR,
            # measured (Oct 2026) taking a further 3–7 dB off 4–10 kHz — the
            # band that makes a voice sound clear rather than nasal. At 24 kHz
            # this is MPEG-2 at its 160 kbit/s ceiling.
            try:
                sf.write(buf, audio, sr, format="MP3", bitrate_mode="CONSTANT", compression_level=0.0)
            except TypeError:  # soundfile < 0.12 has no quality settings
                buf = io.BytesIO()
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

# Where the fine-tuned Nepali T3 comes from: a HuggingFace repo or a local
# path. The notebooks and the Modal function set it. With it unset, or if the
# download fails, Nepali jobs fail with the reason; no other model stands in.
#
# Known-working, ungated: Firoj112/chatterbox-nepali-runs, which publishes the
# finished t3_mtl_nepali_final.safetensors as well as the interim epochs. The
# gated mirrors hold the same final file; HF_TOKEN is only needed for those.
NE_MODEL = os.environ.get("VOICEFORGE_NE_MODEL", "").strip()
# The merged checkpoint (70% Nepali fine-tune, 30% base multilingual), the
# author's recommended file. Measured Oct 2026 on the owner's recorded
# sentences: closest to their words and pace, fewest stray start sounds, and
# "नमस्ते" said right where the epoch-50 file said "नोमस"/"उन्र्म्श्ते".
NE_FILE = os.environ.get("VOICEFORGE_NE_FILE", "t3_mtl_nepali_merged.safetensors").strip()
# Notebooks opened before Oct 2026 set VOICEFORGE_NE_FILE to the epoch-50 file
# themselves, as their default, and a restart re-runs those same saved cells —
# so Colab and Kaggle kept the old model after the default moved. Nobody chose
# that file on purpose; treat it as "the default". To really pin it, also set
# VOICEFORGE_NE_FILE_PINNED=1.
_LEGACY_NE_FILE = "t3_mtl_nepali_final.safetensors"
if NE_FILE == _LEGACY_NE_FILE and not os.environ.get("VOICEFORGE_NE_FILE_PINNED"):
    NE_FILE = "t3_mtl_nepali_merged.safetensors"
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
# When each failure was recorded. A failed load is not retried on every chunk,
# but it is retried: with no other model allowed to stand in, a download that
# failed once must not keep the language unavailable until the next restart.
_ENGINE_FAILED_AT: Dict[str, float] = {}
ENGINE_RETRY_SECONDS = 120


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


def _load_ne_model(repo: str = "", file: str = ""):
    """Base multilingual Chatterbox with a Nepali T3 swapped in.

    The published Nepali work is a fine-tune of the T3 stage only — the voice
    encoder and the S3 vocoder are unchanged, which is exactly why cloning
    still works. So this is not a from_pretrained of a whole checkpoint: those
    repos ship one weights file and nothing else, and from_pretrained would
    fail looking for the rest.
    """
    repo = repo or NE_MODEL
    # "file@0.6" blends the checkpoint with the original model; see below.
    file, mix = ne_split_mix(file or NE_FILE)
    if not repo:
        raise RuntimeError("no Nepali model configured (set VOICEFORGE_NE_MODEL)")

    from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: PLC0415
    from huggingface_hub import hf_hub_download  # noqa: PLC0415

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ChatterboxMultilingualTTS.from_pretrained(device=device)

    def fetch(from_repo: str) -> str:
        return hf_hub_download(
            repo_id=from_repo,
            filename=file,
            # Needed for the owner's private repo; harmless when absent.
            token=os.environ.get("HF_TOKEN") or None,
        )

    if os.path.exists(repo):
        path = repo
    else:
        try:
            path = fetch(repo)
        except Exception as e:  # noqa: BLE001
            # A file not yet copied into the owner's repo comes from the
            # original it was copied from, so a new default never waits on
            # the copy job; once the copy exists, it is used instead.
            original = _NE_ALLOWED_REPOS[0]
            if repo == original:
                raise
            print(f"[engine] {file} not in {repo} ({type(e).__name__}); using {original}", flush=True)
            path = fetch(original)

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
    if mix is not None and mix < 1:
        # The Nepali T3 was fine-tuned from this one, which still sits in
        # model.t3 (from_pretrained), so the two can be mixed weight by weight.
        # The original speaks English with a clean, natural delivery; the
        # fine-tune learned Nepali from noisy, flat speech. Blending some of the
        # original back keeps the Nepali and recovers some of the delivery.
        # Rows the fine-tune added to the text vocabulary have no original to
        # mix with and are kept as they are.
        base = model.t3.state_dict()
        mixed = 0
        for k, v in state.items():
            b = base.get(k)
            if b is None or not torch.is_floating_point(v):
                continue
            b = b.detach().to("cpu", v.dtype)
            if b.shape == v.shape:
                state[k] = mix * v + (1 - mix) * b
            elif b.dim() == v.dim() and b.shape[1:] == v.shape[1:] and v.shape[0] > b.shape[0]:
                v = v.clone()
                v[: b.shape[0]] = mix * v[: b.shape[0]] + (1 - mix) * b
                state[k] = v
            else:
                continue
            mixed += 1
        del base
        print(f"[engine] nepali T3: blended {mixed}/{len(state)} tensors at {mix:.2f} Nepali", flush=True)
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
            f"{file} matched no T3 parameters — wrong file or wrong architecture"
        )

    want = state.get("text_emb.weight")
    _NE_TAG["id"] = _register_ne_tag(model, int(want.shape[0]) if want is not None else None)
    _guard_vocoder(model)

    # No model.to(device) here: ChatterboxMultilingualTTS is a wrapper, not an
    # nn.Module, so it has no .to(). from_pretrained already placed it, and the
    # layers grown above are created on the same device and dtype.
    return model


def engine_available(engine: str) -> bool:
    """Is this engine usable right now? Never raises, never retries a known
    failure, and never blocks the languages that do not need it."""
    if engine in _ENGINE_FAILED:
        if time.time() - _ENGINE_FAILED_AT.get(engine, 0) < ENGINE_RETRY_SECONDS:
            return False
        _ENGINE_FAILED.pop(engine, None)
    if engine == "chatterbox-ne":
        if "chatterbox-ne" in MODELS:
            return True
        if not NE_MODEL:
            _ENGINE_FAILED[engine] = "VOICEFORGE_NE_MODEL is not set"
            _ENGINE_FAILED_AT[engine] = time.time()
            print("[engine] chatterbox-ne unavailable: no model configured", flush=True)
            return False
        # One load at a time. Jobs ask for the engine before they queue for
        # the GPU, so six jobs arriving at a cold container each loaded their
        # own copy: a T4 ran out of memory, and the leftovers broke every job
        # after (cuFFT errors) until the container shut down (Oct 2026).
        with _LOAD_LOCK:
            if "chatterbox-ne" in MODELS:
                return True
            if engine in _ENGINE_FAILED:
                return False  # failed while this job waited
            try:
                MODELS["chatterbox-ne"] = _load_ne_model()
                print(f"[engine] chatterbox-ne ready ({NE_MODEL})", flush=True)
                return True
            except Exception as e:  # noqa: BLE001
                _ENGINE_FAILED[engine] = str(e)[:200]
                _ENGINE_FAILED_AT[engine] = time.time()
                print(f"[engine] chatterbox-ne failed to load: {e}", flush=True)
                # Give back whatever the failed load allocated, or the next
                # try fails on memory this one still holds.
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                return False
    _ENGINE_FAILED[engine] = "unknown engine"
    return False


def resolve_engine(
    engine: Optional[str],
    fallback: Optional[Dict[str, Any]],
    params: Dict[str, Any],
) -> Dict[str, Any]:
    """plan_engine, with this process's real model availability.

    Raises EngineUnavailable, with the actual reason, when a language's own
    model cannot run. The job then fails and says why; it does not come back
    spoken by a different language's model.
    """
    try:
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
    except EngineUnavailable:
        wanted = (engine or "").strip()
        why = _ENGINE_FAILED.get(wanted) or "it has not been loaded"
        raise EngineUnavailable(
            f"The Nepali model could not be used on this backend ({why}). "
            "Nothing was generated: Nepali is never read by another language's model."
        ) from None


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
        if _NE_REQUEST["plain"]:
            # The text as the checkpoint was trained on it — see ne_plain_text.
            text = ne_plain_text(text)
        else:
            # One sentence ending, not two: see ne_model_ending.
            text = ne_model_ending(text)

    if model in ("chatterbox", "chatterbox-ne"):
        import inspect

        kwargs = {
            "language_id": language,
            "audio_prompt_path": ref["path"],
            "exaggeration": float(exaggeration),
            "cfg_weight": float(cfg),
            "temperature": float(temperature),
        }
        target = _ne_model_for(_NE_REQUEST["source"]) if model == "chatterbox-ne" else MODELS[model]
        accepted = inspect.signature(target.generate).parameters
        kwargs = {k: v for k, v in kwargs.items() if k in accepted}
        _LAST_STOP["why"] = ""
        _LAST_STOP["dropped"] = 0
        _LAST_ALIGN.clear()
        _TAIL_SEEN["model"] = model
        ending = _NE_ENDING.get("frames") or NE_TAIL_FRAMES
        if model == "chatterbox-ne" and ending > 0:
            # 25 frames a second. The guard is 60% of what the words should
            # need, so a wrong "finished" early in a sentence cannot end it.
            _TAIL_RULE["frames"] = ending
            _TAIL_RULE["min_frames"] = int(expected_speech_seconds(text) * 25 * 0.6)
        else:
            _TAIL_RULE["frames"] = 0
            _TAIL_RULE["min_frames"] = 0
        _PUNC_BYPASS["on"] = model == "chatterbox-ne" and _NE_REQUEST["plain"]
        try:
            wav = target.generate(text, **kwargs)
        finally:
            _TAIL_RULE["frames"] = 0
            _PUNC_BYPASS["on"] = False
        audio = wav.squeeze(0).cpu().numpy()
        sr = target.sr
        # One line per take. Without it a bad render can only be described,
        # never diagnosed: this says which model and tag ran, how much audio
        # came back for how much text, and whether a check cut it short.
        _LAST_GEN.clear()
        _LAST_GEN.update(
            {
                "model": model,
                "tag": language,
                "chars": len(text),
                **({"ne_source": _NE_REQUEST["source"]} if model == "chatterbox-ne" and _NE_REQUEST["source"] else {}),
                **({"text_style": "plain"} if model == "chatterbox-ne" and _NE_REQUEST["plain"] else {}),
                "audio": round(len(audio) / max(1, sr), 2),
                "stop": _LAST_STOP["why"] or "natural",
                "dropped_tokens": _LAST_STOP.get("dropped") or None,
                "frames": _LAST_ALIGN.get("frames"),
                "text_done_at": _LAST_ALIGN.get("completed_at"),
                "punct_at": _LAST_ALIGN.get("punct_at"),
                "text_tokens": _LAST_ALIGN.get("text_tokens"),
                # The last second and a half: which text token each frame was on.
                "align_tail": (_LAST_ALIGN.get("trace") or [])[-40:] or None,
                # And the first 1.6 s: whether the model was already reading
                # the text while the first sound played, which tells an echo
                # of the reference's last word from a real short first word.
                "align_head": (_LAST_ALIGN.get("trace") or [])[:40] or None,
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


# Every voice's reference is cleaned when a backend caches it: the speech is
# separated from fan hum, room noise and anything else behind it by Demucs
# (htdemucs, "vocals"), then given the studio finish. The clone copies its
# reference's sound, background included, so this is what makes any voice
# recorded at home come out clean, with nothing to do per voice. A backend
# without demucs installed uses the clip as it is.
# VOICEFORGE_VOICE_CLEAN=0 turns it off.
VOICE_CLEAN = os.environ.get("VOICEFORGE_VOICE_CLEAN", "1").strip() != "0"
_DEMUCS: Dict[str, Any] = {}


def _clean_reference(data: np.ndarray, sr: int, voice_id: str) -> tuple:
    """The reference clip with background noise removed and the studio finish."""
    if not VOICE_CLEAN or _DEMUCS.get("failed") or len(data) < sr:
        return data, sr
    try:
        from demucs.apply import apply_model  # noqa: PLC0415
        from demucs.pretrained import get_model  # noqa: PLC0415
        import librosa  # noqa: PLC0415

        device = "cuda" if torch.cuda.is_available() else "cpu"
        if "model" not in _DEMUCS:
            _DEMUCS["model"] = get_model("htdemucs").to(device).eval()
        model = _DEMUCS["model"]
        x = data if sr == model.samplerate else librosa.resample(data, orig_sr=sr, target_sr=model.samplerate)
        # Demucs works on stereo, normalised the way its own command line does.
        mix = torch.from_numpy(np.ascontiguousarray(x)).float()
        mean, std = mix.mean(), mix.std() + 1e-8
        wav = ((mix - mean) / std).expand(2, -1)[None].to(device)
        with torch.inference_mode():
            sources = apply_model(model, wav, device=device, split=True, overlap=0.25, progress=False)[0]
        voice = (sources[model.sources.index("vocals")].mean(0) * std.to(device) + mean.to(device)).cpu().numpy()
        out, note = studio_polish(voice.astype(np.float32), model.samplerate)
        out = _peak_normalize(out)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        print(f"[voice] {voice_id}: background removed, studio finish {note or 'skipped'}", flush=True)
        return out, model.samplerate
    except Exception as e:  # noqa: BLE001
        print(f"[voice] cleaning unavailable, using the clip as recorded: {e}", flush=True)
        _DEMUCS.clear()
        _DEMUCS["failed"] = str(e)[:200]
        return data, sr


def cache_voice(voice_id: str, audio_url: str, transcript: str = "", language: str = "en") -> float:
    """Download a reference clip (from Blob) and cache it on local disk."""
    path = os.path.join(VOICES_DIR, f"{voice_id}.wav")
    with urllib.request.urlopen(audio_url, timeout=120) as resp:  # noqa: S310 - our own Blob URL
        raw = resp.read()
    data, sr = sf.read(io.BytesIO(raw))
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    data, sr = _clean_reference(np.asarray(data, dtype=np.float32), sr, voice_id)
    sf.write(path, data, sr)
    VOICES[voice_id] = {"path": path, "transcript": (transcript or "").strip(), "language": language}
    _NE_VOICE_RATE.pop(voice_id, None)
    return len(data) / sr


_NE_VOICE_RATE: Dict[str, float] = {}


def _ne_voice_rate(voice_id: str) -> float:
    """How fast the voice's own recording speaks, in letters a second; 0 if unknown.

    Measured once per voice from its reference clip and transcript, so every
    take is brought to the speaker's own pace (ne_pace_factor) and a voice
    recorded later gets its own pace with no setting to tune.
    """
    if voice_id in _NE_VOICE_RATE:
        return _NE_VOICE_RATE[voice_id]
    rate = 0.0
    v = VOICES.get(voice_id) or {}
    try:
        if v.get("path") and v.get("transcript"):
            data, sr = sf.read(v["path"], dtype="float32")
            if getattr(data, "ndim", 1) > 1:
                data = data.mean(axis=1)
            rate = ne_speech_rate(data, sr, v["transcript"])
    except Exception as e:  # noqa: BLE001
        print(f"[pace] could not measure {voice_id}: {e}", flush=True)
    _NE_VOICE_RATE[voice_id] = rate
    print(f"[pace] {voice_id}: {rate:.1f} letters/s", flush=True)
    return rate


def _ne_finish(audio: np.ndarray, sr: int, text: str, voice_id: str, params: Dict[str, Any]):
    """A finished Nepali take with its pauses set and brought to the voice's pace.

    Pauses first (ne_mark_pauses), then speed: the rate is measured without
    pauses, so the order does not change it. `pace` (the Nepali speed
    setting) still applies on top, as a preference.
    """
    audio, pauses = ne_mark_pauses(audio, sr, text)
    factor = ne_pace_factor(ne_speech_rate(audio, sr, text), _ne_voice_rate(voice_id))
    audio = change_rate(audio, sr, ne_pace(params) * factor)
    return audio, {"pace": ne_pace(params), "pace_match": round(factor, 3), **({"pauses": pauses} if pauses else {})}


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


def _gen_ne(
    text: str,
    voice_id: str,
    *,
    model: str,
    engine: str,
    language: str,
    st: Dict[str, float],
    seed: int,
) -> tuple:
    """One plain Nepali take, ended where the model finished its text.

    The end of the take comes from the alignment check (see NE_TAIL_FRAMES),
    which knows the frame at which the text was finished. Nothing here guesses
    from syllable counts: that estimate runs short for this voice, and
    trimming by it cut the last two seconds off an ordinary sentence.

    The one thing still checked is that the model reached the end of the text
    at all. A take that never did is re-rolled with a new seed, up to three
    takes; if none gets there the first is kept, since a complete guess is not
    available and the first is at least the requested seed.
    Returns (audio, sr, takes).
    """
    first = None
    best = None  # (seconds per character, audio) of takes that ended but sounded wrong
    clear = None  # (heard score, audio) of whole takes Whisper heard words wrong in
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
        if first is None:
            first = audio
        # Only the Nepali model reports this. Anything else has no signal to
        # judge by, so its first take stands.
        if _TAIL_SEEN["model"] != "chatterbox-ne":
            return _fade_out(audio, sr), sr, take + 1
        # Good means both: the model reached the end of the text, and the
        # take is no longer than the words could need. Either alone has been
        # seen to be wrong.
        ended = _LAST_ALIGN.get("completed_at") is not None
        if ended and len(audio) / max(1, sr) <= ne_duration_cap(text):
            # A longer fade than elsewhere: this take was ended on a held
            # vowel, and 80 ms lets it fall away the way a voice does.
            # Start on the first word as well: see ne_trim_leading.
            audio = ne_trim_leading(ne_trim_trailing_blip(audio, sr), sr)
            # Reaching the end is not enough: a take can lose its place,
            # stall mid-sentence and carry on with wrong words. See
            # ne_take_problem; such a take is voiced again with a new seed.
            problem = ne_take_problem(audio, sr, text)
            if not problem:
                audio = _fade_out(audio, sr, 0.08)
                # Whole and the right length, but did it say the words? A
                # swallowed or changed word is voiced again; if every take
                # has one, the clearest is kept. See ne_heard_error.
                heard = _ne_heard(audio, sr)
                if heard is None:
                    return audio, sr, take + 1
                err, first_ok = ne_heard_error(text, heard)
                _NE_GUARD.setdefault("heard", []).append(f"{err:.2f}{'' if first_ok else ' first word'}: {heard[:60]}")
                if err <= NE_HEARD_MAX_ERR and first_ok:
                    return audio, sr, take + 1
                score = ne_heard_score(err, first_ok)
                if clear is None or score < clear[0]:
                    clear = (score, audio)
                continue
            _NE_GUARD.setdefault("rerolled", []).append(problem)
            score = len(audio) / max(1, sr) / max(1, len(text))
            if best is None or score < best[0]:
                best = (score, audio)
    if clear is not None:
        return clear[1], sr, 3
    if best is not None:
        # Every take ended but none sounded whole: keep the tightest one.
        return _fade_out(best[1], sr, 0.08), sr, 3
    _NE_GUARD["failed_takes"] = True
    return _fade_out(ne_trim_leading(first, sr), sr), sr, 3


# What the guard had to do for the last piece of text, for the diagnostics.
_NE_GUARD: Dict[str, Any] = {}

# Whisper, to hear whether a Nepali take said its words (see _gen_ne). Loaded
# on first use beside the TTS models, about 1.6 GB on the GPU. Set
# VOICEFORGE_NE_ASR_MODEL="" to turn the check off on a backend; a request
# turns it off with ne_check: false.
NE_ASR_MODEL = os.environ.get("VOICEFORGE_NE_ASR_MODEL", "openai/whisper-large-v3-turbo").strip()
_NE_ASR: Dict[str, Any] = {}


def _ne_heard(audio: np.ndarray, sr: int) -> Optional[str]:
    """What Whisper hears in a Nepali take, or None when it can't listen.

    A backend where Whisper won't load voices as before, without the check,
    rather than failing the job.
    """
    if not NE_ASR_MODEL or _NE_ASR.get("failed") or not _NE_REQUEST.get("check", True):
        return None
    try:
        if "model" not in _NE_ASR:
            from transformers import WhisperForConditionalGeneration, WhisperProcessor  # noqa: PLC0415

            device = "cuda" if torch.cuda.is_available() else "cpu"
            asr = WhisperForConditionalGeneration.from_pretrained(NE_ASR_MODEL).to(device)
            asr = (asr.half() if device == "cuda" else asr).eval()
            _NE_ASR.update(model=asr, processor=WhisperProcessor.from_pretrained(NE_ASR_MODEL), device=device)
            print(f"[engine] Nepali listening check loaded: {NE_ASR_MODEL}", flush=True)
        import librosa  # noqa: PLC0415

        x = np.asarray(audio, dtype=np.float32)
        if sr != 16000:
            x = librosa.resample(x, orig_sr=sr, target_sr=16000)
        asr, processor = _NE_ASR["model"], _NE_ASR["processor"]
        features = processor(x, sampling_rate=16000, return_tensors="pt").input_features
        features = features.to(_NE_ASR["device"], dtype=asr.dtype)
        with torch.inference_mode():
            ids = asr.generate(features, language="ne", task="transcribe", max_new_tokens=200)
        return processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
    except Exception as e:  # noqa: BLE001
        print(f"[engine] Nepali listening check unavailable: {e}", flush=True)
        _NE_ASR.clear()
        _NE_ASR["failed"] = str(e)[:200]
        gc.collect()
        return None


def _studio(audio: np.ndarray, sr: int, params: Dict[str, Any], notes: List[str]) -> np.ndarray:
    """A finished Nepali clip with the studio finish, unless the request says studio: false."""
    if str(params.get("studio", "")).strip().lower() in ("0", "false", "off", "no"):
        return audio
    out, note = studio_polish(audio, sr)
    if note:
        notes.append(note)
    return out
# How many frames a Nepali take may spend on its last letter, when the request
# says. Set per job from its params, under the GPU lock; 0 means the default.
_NE_ENDING: Dict[str, int] = {"frames": 0}

# Two opt-in test switches, set per job under the GPU lock. Neither changes
# anything unless a request asks for it:
#   ne_text: "plain"  — text as the checkpoint was trained on it (no
#                       punctuation, and the library adds none); see ne_plain_text.
#   ne_source: "file" or "repo:file" — voice this request with another
#                       checkpoint, from the configured repo or the original one.
# They exist to compare checkpoints and input styles on the real pipeline,
# and later to compare versions of the owner's own model.
_NE_REQUEST: Dict[str, Any] = {"plain": False, "source": "", "punct_frames": 0}
# Frames (40 ms) a take runs on after the model reaches the closing
# punctuation. 2 was set for the old checkpoint's stray after-sounds, but it
# stopped 7 of 12 takes while the last word was still sounding — "स्वागत छ"
# came out cut or garbled. Measured on the merged checkpoint (4 sentences ×
# 3 seeds): 8 here with a 12-frame hold on the last letter cut none, and
# "छ" was heard; 12/12 also cut none but drew one ending out. A request may
# set punct_frames (2–12) to compare.
NE_PUNCT_FRAMES = int(os.environ.get("VOICEFORGE_NE_PUNCT_FRAMES", "8") or 8)
_PUNC_BYPASS: Dict[str, bool] = {"on": False}
_NE_ALLOWED_REPOS = ("Firoj112/chatterbox-nepali-runs",)
_NE_VARIANT: Dict[str, Any] = {}


def _ne_flow(params: Dict[str, Any]) -> bool:
    """Does the request ask for sentences voiced together? See NE_FLOW_CHARS."""
    return str(params.get("ne_flow", "")).strip().lower() in ("1", "true", "on", "yes")


def _set_ne_request(params: Dict[str, Any]) -> None:
    _NE_REQUEST["plain"] = str(params.get("ne_text") or "").lower() == "plain"
    _NE_REQUEST["source"] = str(params.get("ne_source") or "").strip()[:200]
    _NE_REQUEST["check"] = str(params.get("ne_check", "")).strip().lower() not in ("0", "false", "off", "no")
    _NE_REQUEST["flow"] = _ne_flow(params)
    try:
        _NE_REQUEST["punct_frames"] = min(12, max(2, int(params.get("punct_frames") or 0))) if params.get("punct_frames") else 0
    except (TypeError, ValueError):
        _NE_REQUEST["punct_frames"] = 0


def _ne_model_for(source: str):
    """The Nepali model to voice with: the loaded one, or another checkpoint.

    Only files from the configured repo (VOICEFORGE_NE_MODEL) or the original
    it was copied from are accepted. One extra checkpoint is kept loaded at a
    time; asking for another replaces it.
    """
    if not source:
        return MODELS["chatterbox-ne"]
    repo, _, file = source.rpartition(":")
    repo = repo or NE_MODEL
    if repo != NE_MODEL and repo not in _NE_ALLOWED_REPOS:
        raise ValueError(f"ne_source repo not allowed: {repo}")
    key = f"{repo}:{file}"
    # The model switched on in Settings arrives here with every job, so one
    # that cannot load (a typo, a file not yet pushed) must not stop Nepali
    # altogether: the default model speaks, and the job notes why.
    if _NE_VARIANT.get("failed") == key:
        _NE_GUARD["model_fallback"] = f"{key} could not load; used the default"
        return MODELS["chatterbox-ne"]
    if _NE_VARIANT.get("key") != key:
        _NE_VARIANT.clear()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        try:
            _NE_VARIANT["model"] = _load_ne_model(repo, file)
        except Exception as e:  # noqa: BLE001
            print(f"[engine] nepali variant {key} failed: {e}; using the default", flush=True)
            _NE_VARIANT.clear()
            _NE_VARIANT["failed"] = key
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            _NE_GUARD["model_fallback"] = f"{key} could not load; used the default"
            return MODELS["chatterbox-ne"]
        _NE_VARIANT["key"] = key
        print(f"[engine] nepali variant loaded: {key}", flush=True)
    return _NE_VARIANT["model"]


def _patch_punc_norm() -> None:
    """Let a plain-text request reach the model without an added full stop."""
    try:
        import chatterbox.mtl_tts as mtl  # noqa: PLC0415

        if getattr(mtl, "_vf_punc", False):
            return
        original = mtl.punc_norm

        def punc_norm(text):  # noqa: ANN001, ANN202
            return " ".join(str(text).split()) if _PUNC_BYPASS["on"] else original(text)

        mtl.punc_norm = punc_norm
        mtl._vf_punc = True
    except Exception as e:  # noqa: BLE001
        print(f"[engine] punctuation bypass unavailable: {e}", flush=True)


def _gen_ne_text(text: str, voice_id: str, **kw: Any) -> tuple:
    """One clip for one piece of Nepali text, whatever that takes.

    A take can fail to end: the model loses its place, never reaches the end
    of the text, and runs to the library's 40-second limit — a 13-second line
    followed by 27 seconds of babble. Re-rolling alone does not fix it, since
    a text that defeats the model once tends to defeat it three times.

    So, in order:
      1. text over the checkpoint's 200-character limit is split first;
      2. each piece gets up to three takes (_gen_ne);
      3. a piece that still will not end is split into its sentences, and
         those are voiced one at a time and joined;
      4. only a single sentence that still runs on is cut, at the first real
         pause after its words.
    One clip comes back either way, so an "items" job keeps one file per line.
    Returns (audio, sr, takes, note) where note says what was needed.
    """
    seed = int(kw.pop("seed", 0))
    notes: List[str] = []
    takes = 0
    sr = 24000

    def voice(piece: str, n: int, allow_split: bool) -> np.ndarray:
        nonlocal takes, sr
        _NE_GUARD.clear()
        audio, sr, k = _gen_ne(piece, voice_id, seed=seed + n * 104729, **kw)
        takes += k
        if _NE_GUARD.get("rerolled"):
            notes.append(f"re-voiced {len(_NE_GUARD['rerolled'])} take(s): " + "; ".join(_NE_GUARD["rerolled"]))
        if _NE_GUARD.get("heard"):
            notes.append("heard " + " / ".join(_NE_GUARD["heard"]))
        if _NE_GUARD.get("model_fallback") and _NE_GUARD["model_fallback"] not in notes:
            notes.append(_NE_GUARD["model_fallback"])
        if not _NE_GUARD.get("failed_takes"):
            return audio
        smaller = ne_split_for_retry(piece) if allow_split else []
        if smaller:
            notes.append(f"split a {len(piece)}-character piece into {len(smaller)}")
            parts = [voice(p, n * 10 + i + 1, False) for i, p in enumerate(smaller)]
            return _join(parts, sr)
        notes.append(f"cut a runaway take ({len(audio) / max(1, sr):.1f}s for {len(piece)} characters)")
        return ne_cut_runaway(audio, sr, piece)

    # One take per sentence (short ones ride with a neighbour). A narration
    # job already works this way; a batch item used to go in whole, which
    # left the sentence endings inside it to the model. The model does not
    # end a sentence cleanly by itself — it is the end of a *take* that is
    # controlled — so sound trailing after a sentence survived in the middle
    # of a clip. It also keeps every piece inside the 200-character limit.
    pieces = ne_prepare(text, NE_MAX_CHUNK_CHARS, flow=_NE_REQUEST.get("flow", False)) or [text]
    if len(pieces) > 1 and len(text) > NE_MAX_CHUNK_CHARS:
        notes.append(f"split {len(text)} characters into {len(pieces)} before voicing")
    audio = _join([voice(p, i, True) for i, p in enumerate(pieces)], sr)
    return audio, sr, takes, "; ".join(notes)


def _join(parts: List[np.ndarray], sr: int) -> np.ndarray:
    """Pieces of one line, with the pause a sentence break gets elsewhere."""
    if len(parts) == 1:
        return parts[0]
    out: List[np.ndarray] = []
    for i, part in enumerate(parts):
        out.append(np.asarray(part, dtype=np.float32))
        if i < len(parts) - 1:
            out.append(np.zeros(int(SENTENCE_GAP_SEC * sr), dtype=np.float32))
    return np.concatenate(out)


def _fade_out(audio: np.ndarray, sr: int, seconds: float = 0.03) -> np.ndarray:
    """A take ended by a rule stops on a frame boundary; fade so it cannot click."""
    n = min(len(audio), int(sr * seconds))
    if n < 2:
        return audio
    out = np.array(audio, dtype=np.float32, copy=True)
    out[-n:] *= np.linspace(1.0, 0.0, n, dtype=np.float32)
    return out


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
            elif _ne_flow(params):
                # The sentences of each paragraph voiced two or so to a take;
                # see NE_FLOW_CHARS. Paragraph ends keep their longer gap.
                merged: List[str] = []
                merged_breaks: List[bool] = []
                paragraph: List[str] = []
                for i, ch in enumerate(chunks):
                    paragraph.append(ch)
                    if i == len(chunks) - 1 or (i < len(breaks) and breaks[i]):
                        pieces = ne_prepare(" ".join(paragraph), flow=True)
                        merged += pieces
                        merged_breaks += [False] * (len(pieces) - 1) + [True] if pieces else []
                        paragraph = []
                if merged:
                    chunks, breaks = merged, merged_breaks
            else:
                chunks = [c for ch in chunks for c in ne_prepare(ch)] or chunks

        diag: List[Dict[str, Any]] = []
        with _GPU_LOCK:
            _BUSY = True
            for i, text in enumerate(chunks if not rendered else []):
                if is_ne:
                    # One clip per chunk, guarded against a take that will
                    # not end; see _gen_ne_text.
                    _NE_ENDING["frames"] = ne_ending_frames(params)
                    _set_ne_request(params)
                    audio, sr, takes, guard_note = _gen_ne_text(
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
                    # Pace and pauses are set after the take is finished and
                    # judged, so the length checks above always see the model's
                    # own speed.
                    audio, finish = _ne_finish(audio, sr, text, job["voice_id"], params)
                    rendered.append(audio)
                    diag.append(
                        {
                            **_LAST_GEN,
                            **finish,
                            "ending_frames": _NE_ENDING.get("frames") or NE_TAIL_FRAMES,
                            "raw_audio": _LAST_GEN.get("audio"),
                            "audio": round(len(audio) / max(1, sr), 2),
                            "takes": takes,
                            # The whole chunk, not only its last piece.
                            "chars": len(text),
                            **({"guard": guard_note} if guard_note else {}),
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
        # Nepali gets the studio finish on each finished file; see studio_polish.
        studio_notes: List[str] = []

        def finished(audio: np.ndarray) -> np.ndarray:
            return _peak_normalize(_studio(audio, sr, params, studio_notes) if is_ne else audio)

        outputs = (
            [finished(a) for a in rendered]
            if mode == "items"
            else [finished(_stitch(rendered, sr, breaks))]
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
                    # Which Nepali checkpoint voiced this job, so a clip can
                    # always be traced to its model.
                    "ne_model": f"{NE_MODEL}:{NE_FILE}",
                    # The trained version Settings switched on, which is what
                    # really spoke (ne_model is only the backend's default).
                    **({"ne_source": _NE_VARIANT.get("key") or _NE_VARIANT.get("failed")} if is_ne and _NE_REQUEST.get("source") else {}),
                    **({"ne_check": _NE_ASR.get("failed") or NE_ASR_MODEL} if is_ne else {}),
                    # Whether voice references are being cleaned (see _clean_reference).
                    "voice_clean": _DEMUCS.get("failed") or ("htdemucs" if "model" in _DEMUCS else "not run"),
                },
                "chunks": diag[:200],
                **({"studio": studio_notes[:200]} if studio_notes else {}),
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
        told = _note_failure(e)
        with _JOB_LOCK:
            JOBS[job_id].update({"status": "error", "error": told})
        if callback_url:
            try:
                _post_json(callback_url, {"job_id": job_id, "status": "error", "error": told}, token)
            except Exception:
                pass
        print("[job]", job_id, "failed:", err, flush=True)


# ---------------------------------------------------------------------------
# app
# ---------------------------------------------------------------------------

# Set once a CUDA device-side assert has been seen. That error does not just
# fail one take: it leaves the process's CUDA context unusable, so every job
# after it fails the same way until the notebook is restarted. Carrying on
# accepting work would turn one bad take into a backend that fails everything
# while still looking online.
_GPU_BROKEN: Dict[str, str] = {}


def _where(limit: int = 6) -> str:
    """The innermost frames of the current exception, as "file:line function".

    A CUDA error's message is the same wherever it happened. Which call it
    surfaced in is the only clue to the cause, and it used to exist only in
    the notebook's own output.
    """
    frames = traceback.extract_tb(sys.exc_info()[2])[-limit:]
    return " > ".join(f"{os.path.basename(f.filename)}:{f.lineno} {f.name}" for f in frames)


def _note_failure(e: BaseException) -> str:
    """Describe a failed take, and notice when it has broken the GPU session."""
    text = str(e)
    where = _where()
    # Only this one. An out-of-memory error also says "CUDA", and the session
    # survives it.
    if "device-side assert" in text:
        _GPU_BROKEN["why"] = f"{text.splitlines()[0][:160]} (at {where})"
        return (
            "This backend's GPU session failed and it is now refusing work until its "
            f"notebook is restarted. {_GPU_BROKEN['why']}"
        )[:900]
    return f"{text[:500]} (at {where})"[:900]


def _refuse_if_gpu_broken() -> None:
    if _GPU_BROKEN:
        # 503, so the gateway hands the job to the next backend in line.
        raise HTTPException(
            status_code=503,
            detail="GPU session broken, restart this notebook: " + _GPU_BROKEN["why"][:300],
        )


RAW_BASE = os.environ.get(
    "VOICEFORGE_RAW_BASE", "https://raw.githubusercontent.com/bijaybista006-art/voiceforge/main/backend"
)


def _free_installer_caches() -> None:
    """Notebooks: delete the download caches left by Cell 1's pip installs.

    pip keeps every package it downloaded (torch and its CUDA libraries alone
    are several GB) next to the installed copy. Nothing reads them again, and
    on a notebook the presenter and AI video engines need that room. Runs once
    at start-up, before those engines install (they install without caches).
    """
    home = os.path.expanduser("~")
    freed = 0
    for path in (os.path.join(home, ".cache", "pip"), os.path.join(home, ".cache", "uv")):
        if not os.path.isdir(path):
            continue
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    freed += os.lstat(os.path.join(root, name)).st_size
                except OSError:
                    pass
        shutil.rmtree(path, ignore_errors=True)
    try:
        u = shutil.disk_usage("/")
        disk = f"disk: {u.used / 1e9:.0f} of {u.total / 1e9:.0f} GB used, {u.free / 1e9:.0f} GB free"
    except OSError:
        disk = "disk: unknown"
    print(f"[voiceforge] freed {freed / 1e9:.1f} GB of installer caches · {disk}", flush=True)


def _load_presenter_module():
    """Import the presenter service, fetching its file first if it is absent.

    A notebook downloads a fixed list of files when it starts, written into
    the notebook itself. This file was added after those notebooks were
    created, so rather than ask for the notebook to be re-imported, the
    server fetches the one file it is missing — from the same place the
    notebook fetched the others.
    """
    import importlib

    try:
        return importlib.import_module("backend.voiceforge_presenter")
    except ImportError:
        pass
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, "voiceforge_presenter.py")
    with urllib.request.urlopen(f"{RAW_BASE}/voiceforge_presenter.py", timeout=60) as r:  # noqa: S310
        data = r.read()
    if len(data) < 4000:
        raise RuntimeError("the presenter service file did not download")
    with open(dest, "wb") as f:
        f.write(data)
    importlib.invalidate_caches()
    try:
        return importlib.import_module("backend.voiceforge_presenter")
    except ImportError:
        # Loaded as a top-level module rather than as part of a package.
        return importlib.import_module("voiceforge_presenter")


WAN_FILES = ("__init__.py", "settings.py", "engine.py", "install.py", "service.py")

# The mounted AI video service, when this notebook runs one (see create_app).
_WAN_SERVICE = None
_PRESENTER_SERVICE = None


def system_report(path: str = "/") -> Dict[str, Any]:
    """Free disk and GPU memory, for Admin -> Backends. Never raises."""
    out: Dict[str, Any] = {}
    try:
        u = shutil.disk_usage(path)
        out["disk_free_gb"] = round(u.free / 1e9, 1)
        out["disk_total_gb"] = round(u.total / 1e9, 1)
    except OSError:
        pass
    try:
        import subprocess

        smi = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        gpus = []
        for line in smi.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 3:
                gpus.append({"name": parts[0][:60], "used_mb": int(float(parts[1])), "total_mb": int(float(parts[2]))})
        if gpus:
            out["gpus"] = gpus[:4]
    except Exception:  # noqa: BLE001
        pass
    return out


def busy_now() -> bool:
    """Anything running right now: narration, a long render, a presenter clip,
    an AI video clip, or a job waiting for the GPU."""
    if _GPU_LOCK.locked() or _ENGINE_LOCK.locked():
        return True
    with _JOB_LOCK:
        if any(j.get("status") in ("queued", "running") for j in JOBS.values()):
            return True
    for service in (_PRESENTER_SERVICE, _WAN_SERVICE):
        renders = getattr(service, "RENDERS", None) or {}
        try:
            if any(j.get("status") in ("queued", "running") for j in list(renders.values())):
                return True
        except Exception:  # noqa: BLE001
            pass
    return False


def idle_seconds(now: Optional[float] = None) -> int:
    """Seconds since the last real work; 0 while anything is running."""
    if busy_now():
        note_work()
        return 0
    return max(0, int((now or time.time()) - _LAST_WORK[0]))


def backend_status() -> Dict[str, Any]:
    """What a notebook tells the app on every heartbeat, beyond "I am alive".

    The app used to learn whether AI video was ready only by asking /wan/health
    when someone pressed Generate — at most every 90 s, with 12 s to answer
    through the tunnel. A notebook that had just finished installing was
    skipped and the clip went to Modal (paid). Now the answer arrives with
    each heartbeat, so the app always knows: off, installing (which step),
    failed (why), or ready.
    """
    status: Dict[str, Any] = {"system": {**system_report(), "idle_seconds": idle_seconds()}}
    if os.environ.get("VOICEFORGE_WAN", "0") != "1":
        status["wan"] = {"state": "off", "capabilities": []}
    elif _WAN_SERVICE is not None:
        try:
            report = _WAN_SERVICE.health_report()
            status["wan"] = {
                "state": "ready" if report.get("capabilities") else (report.get("install") or {}).get("state", "idle"),
                "capabilities": report.get("capabilities") or [],
                "install": report.get("install"),
                "limits": report.get("limits"),
            }
        except Exception as e:  # noqa: BLE001
            status["wan"] = {"state": "failed", "capabilities": [], "install": {"state": "failed", "error": str(e)[:300]}}
    return status


def apply_app_features(features: Optional[dict]) -> str:
    """Act on what the app says this backend may do.

    The notebook calls this with the `features` from its registration answer,
    and again on every heartbeat, so a switch flipped in Admin → Backends
    reaches it within one beat. Today only AI video needs acting on: its
    ~25 GB install starts the first time `clips` is on (and never twice).
    Voice and presenter switches only change routing, which the app does.

    An answer without `features` (an older app) counts as everything on.
    Returns a one-line status for the notebook to print.
    """
    if _WAN_SERVICE is None:
        return "AI video: not enabled in this notebook (ENABLE_AI_VIDEO = False)"
    clips = (features or {}).get("clips", True)
    if not clips:
        return "AI video: switched off for this backend in Admin -> Backends (no download)"
    install = _WAN_SERVICE.install
    install.start_install_in_background()
    state = install.INSTALL.get("state")
    return f"AI video: on -> {'ready' if state == 'ready' else 'installing in the background (~15-20 min)'}"


def _load_wan_service():
    """Import backend/wan/service.py, fetching the package first if absent.

    Same reason as _load_presenter_module: a notebook saved before this
    package existed does not download it, so the server fetches the files
    from the place the notebook fetches everything else.
    """
    import importlib

    try:
        return importlib.import_module("backend.wan.service")
    except ImportError:
        pass
    folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wan")
    os.makedirs(folder, exist_ok=True)
    for name in WAN_FILES:
        with urllib.request.urlopen(f"{RAW_BASE}/wan/{name}", timeout=60) as r:  # noqa: S310
            data = r.read()
        if name != "__init__.py" and len(data) < 1000:
            raise RuntimeError(f"backend/wan/{name} did not download")
        with open(os.path.join(folder, name), "wb") as f:
            f.write(data)
    importlib.invalidate_caches()
    return importlib.import_module("backend.wan.service")


def create_app(provider: str = "custom", with_render: bool = True) -> FastAPI:
    app = FastAPI(title="VoiceForge backend", version=VERSION)
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    @app.middleware("http")
    async def _count_work(request, call_next):
        # Health checks (the app's, and keep-awake pings) are not work.
        if not request.url.path.rstrip("/").endswith("/health"):
            note_work()
        return await call_next(request)

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

    if provider in ("colab", "kaggle"):
        try:
            _free_installer_caches()
        except Exception as e:  # noqa: BLE001 - never stop the voice server for this
            print("[voiceforge] could not clear installer caches:", e, flush=True)

    # Presenter video, notebooks only. Modal runs it as its own function. It
    # is mounted under /presenter because this app already owns /render and
    # /health, and its engine is installed in the background into a private
    # virtualenv — nothing here waits for that, and if any of it fails the
    # voice server carries on exactly as it would have without it.
    if provider in ("colab", "kaggle") and os.environ.get("VOICEFORGE_PRESENTER", "1") != "0":
        try:
            presenter = _load_presenter_module()
            global _PRESENTER_SERVICE
            _PRESENTER_SERVICE = presenter
            app.include_router(
                presenter.create_presenter_router(
                    _check,
                    provider=provider,
                    # On a single GPU a clip and a narration must not overlap.
                    shared_lock=_GPU_LOCK,
                    before_engine=lambda: torch.cuda.empty_cache() if torch.cuda.is_available() else None,
                    engine_lock=_ENGINE_LOCK,
                ),
                prefix="/presenter",
            )
            presenter.start_install_in_background()
            print("[voiceforge] presenter service mounted; engine installing in the background", flush=True)

            @app.post("/presenter/reload")
            def presenter_reload(x_backend_secret: Optional[str] = Header(None)) -> dict:
                """Fetch the presenter service's current code and load it.

                A notebook only reads code when it starts, and starting again
                means reinstalling the engine — a quarter of an hour to pick
                up a one-line fix. This replaces just this service's code, in
                place; the installed engine and its weights are found again
                on disk, not downloaded again. It is the same file, from the
                same place, that a restart would fetch.
                """
                _check(x_backend_secret)
                import importlib

                with presenter._LOCK:
                    if any(j.get("status") in ("queued", "running") for j in presenter.RENDERS.values()):
                        raise HTTPException(status_code=409, detail="a clip is being made; try again after it")
                dest = presenter.__file__
                with urllib.request.urlopen(  # noqa: S310
                    f"{RAW_BASE}/voiceforge_presenter.py?t={int(time.time())}", timeout=60
                ) as r:
                    data = r.read()
                if len(data) < 4000:
                    raise HTTPException(status_code=502, detail="the service file did not download")
                with open(dest, "wb") as f:
                    f.write(data)
                importlib.reload(presenter)
                presenter.configure(
                    shared_lock=_GPU_LOCK,
                    before_engine=lambda: torch.cuda.empty_cache() if torch.cuda.is_available() else None,
                    engine_lock=_ENGINE_LOCK,
                )
                presenter.start_install_in_background()
                return {"ok": True, "version": presenter.PRESENTER_VERSION, "bytes": len(data)}
        except Exception as e:  # noqa: BLE001
            print("[voiceforge] presenter service unavailable:", e, flush=True)

    # AI video clips (Wan 2.2), notebooks only and OFF unless the notebook
    # sets VOICEFORGE_WAN=1: it downloads ~25 GB, which a voice-only session
    # should not pay for. Modal runs it as its own app (modal/voiceforge_wan.py).
    # Mounted under /wan; its engine installs in the background into a private
    # virtualenv, and any failure leaves the voice server untouched.
    if provider in ("colab", "kaggle") and os.environ.get("VOICEFORGE_WAN", "0") == "1":
        try:
            wan = _load_wan_service()
            app.include_router(
                wan.create_wan_router(
                    _check,
                    provider=provider,
                    # On a single GPU a clip and a narration must not overlap.
                    shared_lock=_GPU_LOCK,
                    before_engine=lambda: torch.cuda.empty_cache() if torch.cuda.is_available() else None,
                    engine_lock=_ENGINE_LOCK,
                ),
                prefix="/wan",
            )
            global _WAN_SERVICE
            _WAN_SERVICE = wan
            if os.environ.get("VOICEFORGE_WAN_GATED") == "1":
                # The notebook asks the app first: the install starts when
                # its registration answer says AI video is on for this
                # backend (apply_app_features), so switching it off in
                # Admin → Backends also skips the ~25 GB download.
                print("[voiceforge] video service mounted at /wan; install waits for the app's go-ahead", flush=True)
            else:
                # A notebook from before the Admin switch existed.
                wan.install.start_install_in_background()
                print("[voiceforge] video service mounted at /wan; engine installing in the background", flush=True)
        except Exception as e:  # noqa: BLE001
            print("[voiceforge] video service unavailable:", e, flush=True)

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
            **({"gpu_broken": _GPU_BROKEN["why"]} if _GPU_BROKEN else {}),
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
        _refuse_if_gpu_broken()
        p = await request.json()
        try:
            # Same engine resolution as the job worker. Without it the studio
            # sent language "ne" to a model that has no such language and got
            # a hard 500, while the identical text through a job spoke Nepali.
            plan = resolve_engine(p.get("engine"), p.get("fallback"), p)
            if str(p.get("language", "")).lower() == "ne" or plan["engine"] == "chatterbox-ne":
                # The studio's one-chunk path gets the same treatment a job
                # does: the take ends where the model finished its text.
                t0 = time.time()
                with _GPU_LOCK:
                    _BUSY = True
                    _NE_ENDING["frames"] = ne_ending_frames(p)
                    _set_ne_request(p)
                    audio, sr, _takes, _note = _gen_ne_text(
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
                audio, _finish = _ne_finish(audio, sr, p["text"], p["voice_id"], p)
                audio = _studio(audio, sr, p, [])
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
            told = _note_failure(e)
            # 503 once the session is broken, so the studio's next chunk goes
            # to another backend instead of failing here again.
            return JSONResponse({"error": told}, status_code=503 if _GPU_BROKEN else 500)

        return {
            "audio_b64": _wav_b64(audio, sr),
            "sample_rate": sr,
            "duration": round(len(audio) / sr, 2),
            "gen_seconds": gen_seconds,
        }

    @app.post("/jobs", status_code=202)
    async def create_job(request: Request, x_backend_secret: Optional[str] = Header(None)) -> dict:
        _check(x_backend_secret)
        _refuse_if_gpu_broken()
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
