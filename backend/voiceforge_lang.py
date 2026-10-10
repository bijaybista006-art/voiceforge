"""
Language handling for VoiceForge: engine selection and Nepali text prep.

Deliberately imports no torch and loads no model, so CI can test it on a
plain runner — the same reason voiceforge_render.py is its own file. The
server passes in a callable that says whether an engine is loadable; this
module decides what that means for a job.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional

# What every language has always run on.
DEFAULT_ENGINE = "chatterbox-mtl"

# Engine names that mean "the stock multilingual checkpoint".
STOCK_ENGINES = {DEFAULT_ENGINE, "chatterbox", ""}


def plan_engine(
    engine: Optional[str],
    fallback: Optional[Dict[str, Any]],
    params: Dict[str, Any],
    available: Callable[[str], bool],
    defaults: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """Decide what actually runs, and what to call it in the result.

    `engine_used` is the point of the whole exercise: when a Nepali job
    quietly runs on Hindi because no Nepali checkpoint is configured, that has
    to be visible in the result rather than only audible in the output.
    """
    d = defaults or {}
    wanted = (engine or DEFAULT_ENGINE).strip() or DEFAULT_ENGINE

    chosen: Dict[str, Any] = {
        "engine": wanted,
        "language": str(params.get("language", "en") or "en"),
        "exaggeration": float(params.get("exaggeration", d.get("exaggeration", 0.4))),
        "cfg": float(params.get("cfg", d.get("cfg", 0.5))),
        "temperature": float(params.get("temperature", d.get("temperature", 0.7))),
        "engine_used": wanted,
    }

    if wanted in STOCK_ENGINES or available(wanted):
        return chosen

    if not fallback:
        # Nothing to fall back to. Run the stock engine on the language as
        # given rather than failing a job that would otherwise have worked.
        chosen["engine"] = DEFAULT_ENGINE
        chosen["engine_used"] = DEFAULT_ENGINE
        return chosen

    lang = str(
        fallback.get("modelLanguage") or fallback.get("language") or chosen["language"]
    )
    chosen["engine"] = str(fallback.get("engine") or DEFAULT_ENGINE)
    chosen["language"] = lang
    if fallback.get("cfg") is not None:
        chosen["cfg"] = float(fallback["cfg"])
    if fallback.get("exaggeration") is not None:
        chosen["exaggeration"] = float(fallback["exaggeration"])
    chosen["engine_used"] = f"fallback-{lang}"
    return chosen


def strip_state_prefixes(state: Dict[str, Any]) -> Dict[str, Any]:
    """Normalise checkpoint keys to what the target module expects.

    Checkpoints get saved from wrappers — DataParallel adds "module.", saving
    the whole TTS adds "t3." — and load_state_dict matches on exact names. A
    prefix mismatch is silent: with strict=False nothing loads and nothing
    complains, so the model runs on its original weights.
    """
    for prefix in ("module.", "t3.", "model."):
        if state and all(k.startswith(prefix) for k in state):
            state = {k[len(prefix):]: v for k, v in state.items()}
    return state


# ---------------------------------------------------------------------------
# Nepali text preparation
# ---------------------------------------------------------------------------

_NE_DIGITS = {
    "0": "सुन्ना", "1": "एक", "2": "दुई", "3": "तीन", "4": "चार",
    "5": "पाँच", "6": "छ", "7": "सात", "8": "आठ", "9": "नौ",
    "०": "सुन्ना", "१": "एक", "२": "दुई", "३": "तीन", "४": "चार",
    "५": "पाँच", "६": "छ", "७": "सात", "८": "आठ", "९": "नौ",
}


def ne_spell_number(token: str) -> str:
    """Read a number digit by digit, speaking the decimal point.

    Deliberately not a full Nepali number grammar: digits plus "दशमलव" is
    always understandable, whereas a half-right lakh/crore rule is not, and a
    TTS model cannot ask what you meant.
    """
    out: List[str] = []
    for ch in token:
        if ch in _NE_DIGITS:
            out.append(_NE_DIGITS[ch])
        elif ch == ".":
            out.append("दशमलव")
        elif ch == ",":
            continue
        else:
            out.append(ch)
    return " ".join(x for x in out if x)


def ne_expand_digits(text: str) -> str:
    """Replace every run of digits — ASCII or Devanagari — with spoken words."""
    return re.sub(
        r"[0-9०-९][0-9०-९.,]*",
        lambda m: ne_spell_number(m.group(0)),
        text or "",
    )


def ne_chunks(text: str, max_chars: int = 240) -> List[str]:
    """Split Nepali text where it is actually spoken.

    Devanagari sentences end at the danda, not the full stop, so splitting on
    "." leaves one enormous chunk and the model rushes it. Long sentences are
    then broken at commas, which are real breath points in Devanagari prose.
    """
    text = " ".join((text or "").split())
    if not text:
        return []

    out: List[str] = []
    for sentence in re.split(r"(?<=[।॥?!])\s*", text):
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) <= max_chars:
            out.append(sentence)
            continue
        buf = ""
        for part in re.split(r"(?<=,)\s*", sentence):
            part = part.strip()
            if not part:
                continue
            if buf and len(buf) + len(part) + 1 > max_chars:
                out.append(buf)
                buf = part
            else:
                buf = f"{buf} {part}" if buf else part
        if buf:
            out.append(buf)
    return [c for c in out if c]


def ne_prepare(text: str, max_chars: int = 240) -> List[str]:
    """Spoken numbers, then sentence and breath chunking."""
    return ne_chunks(ne_expand_digits(text or ""), max_chars)


# ---------------------------------------------------------------------------
# Expressive Nepali narration: tone tags, code-switching, clean endings
# ---------------------------------------------------------------------------
#
# Everything below is opt-in per request (prosody_tags / code_switch / speed).
# A request that sends none of those flags never reaches this code, so the
# plain Nepali path and every other language behave exactly as before.
#
# Pure Python + numpy on purpose, like the rest of this file: the server owns
# the models, this module owns the decisions, and CI can test the decisions.

import shutil
import subprocess

try:  # numpy is present on every backend; only the audio helpers need it.
    import numpy as _np
except ImportError:  # pragma: no cover - CI always has numpy
    _np = None

# Tone presets. Chatterbox has no pitch control, so tone is carried by how
# much it commits to the reference's delivery (exaggeration), how tightly it
# follows the text's pacing (cfg) and how adventurous sampling is
# (temperature), plus a small speaking-rate change applied afterwards.
TONES: Dict[str, Dict[str, float]] = {
    "calm": {"exaggeration": 0.45, "cfg": 0.45, "temperature": 0.65, "rate": 1.0},
    "excited": {"exaggeration": 0.75, "cfg": 0.30, "temperature": 0.80, "rate": 1.06},
    "serious": {"exaggeration": 0.50, "cfg": 0.50, "temperature": 0.70, "rate": 0.96},
}

TAG_RE = re.compile(r"\[\s*(calm|excited|serious|pause)\s*\]", re.IGNORECASE)

PAUSE_TAG_SEC = 0.35
GAP_AFTER_STATEMENT_SEC = 0.25
GAP_AFTER_QUESTION_SEC = 0.40
# Chatterbox invents speech after very short inputs, so sentences are merged
# until they carry enough context to end cleanly.
MIN_SENTENCE_WORDS = 5
# A [pause] only splits a sentence when both halves can stand on their own.
MIN_PAUSE_SIDE_WORDS = 3

_DEVA = re.compile(r"[ऀ-ॿ]")
_LATIN = re.compile(r"[A-Za-z]")


def strip_tags(text: str) -> str:
    """Remove every tone/pause tag — what a listener must never hear."""
    return " ".join(TAG_RE.sub(" ", text or "").split())


def _words(text: str) -> int:
    return len([w for w in (text or "").split() if re.search(r"\w", w)])


def parse_prosody(
    text: str, tone: Optional[str] = None
) -> tuple:
    """Turn tagged text into speakable sentences.

    Returns (sentences, final_tone). Each sentence is
    {"text", "tone", "pause_before"}. A tone tag applies until the next tone
    tag, across sentences and across chunks — the caller passes the previous
    chunk's final tone back in, so a chunk boundary never resets delivery.
    """
    current = tone
    pending_pause = False
    sentences: List[Dict[str, Any]] = []

    for i, piece in enumerate(TAG_RE.split(text or "")):
        if i % 2 == 1:  # a tag name
            name = piece.lower()
            if name == "pause":
                pending_pause = True
            else:
                current = name
            continue
        for k, s in enumerate(ne_chunks(piece)):
            sentences.append(
                {"text": s, "tone": current, "pause_before": pending_pause and k == 0}
            )
        if piece.strip():
            pending_pause = False

    # Merge pass 1: a pause that would leave a fragment is dropped (the comma
    # already there is a breath), and the halves rejoin.
    out: List[Dict[str, Any]] = []
    for s in sentences:
        prev = out[-1] if out else None
        joins_prev = prev is not None and not re.search(r"[।॥?!]$", prev["text"])
        if s["pause_before"] and prev is not None and (
            _words(prev["text"]) < MIN_PAUSE_SIDE_WORDS or _words(s["text"]) < MIN_PAUSE_SIDE_WORDS
        ):
            if joins_prev:
                prev["text"] = f"{prev['text']} {s['text']}"
                continue
            s = {**s, "pause_before": False}
        out.append(dict(s))

    # Merge pass 2: sentences too short to end cleanly join a neighbour of the
    # same tone (never across a pause, which is deliberate silence).
    merged: List[Dict[str, Any]] = []
    for s in out:
        prev = merged[-1] if merged else None
        if (
            prev is not None
            and not s["pause_before"]
            and prev["tone"] == s["tone"]
            and (_words(prev["text"]) < MIN_SENTENCE_WORDS or _words(s["text"]) < MIN_SENTENCE_WORDS)
        ):
            prev["text"] = f"{prev['text']} {s['text']}"
            continue
        merged.append(s)
    return merged, current


def tone_settings(tone: Optional[str], base: Dict[str, float]) -> Dict[str, float]:
    """Synthesis settings for one sentence: the tone preset, else the base."""
    preset = TONES.get((tone or "").lower())
    if not preset:
        return {
            "exaggeration": float(base["exaggeration"]),
            "cfg": float(base["cfg"]),
            "temperature": float(base["temperature"]),
            "rate": 1.0,
        }
    return dict(preset)


def gap_after(sentence: str) -> float:
    """Silence after a sentence: questions and exclamations breathe longer."""
    return GAP_AFTER_QUESTION_SEC if re.search(r"[?!]\s*$", sentence or "") else GAP_AFTER_STATEMENT_SEC


# --- code-switching ---------------------------------------------------------

_ACRONYM = re.compile(r"^[A-Z0-9]{2,6}s?$")


def is_latin_word(word: str) -> bool:
    w = (word or "").strip(",.!?;:।॥\"'()")
    return bool(_LATIN.search(w)) and not _DEVA.search(w)


# One-syllable Nepali postpositions that glue onto the English word before
# them ("laptop को", "account मा"). Voiced alone they are too short for the
# model to end cleanly, so they ride along with the English run, romanised the
# way they are actually said.
ATTACH_ROMAN: Dict[str, str] = {
    "को": "ko", "का": "ka", "की": "ki", "मा": "ma", "ले": "le", "लाई": "lai",
    "र": "ra", "बाट": "baata", "सँग": "sanga", "पनि": "pani", "नै": "nai",
    "मै": "mai", "भित्र": "bhitra", "तिर": "tira",
}


def split_runs(sentence: str) -> List[Dict[str, str]]:
    """Split a sentence into same-script runs: [{"lang": "ne"|"en", "text"}].

    Punctuation and digits stay with the run they sit in. Each run is later
    voiced by its own model, in the same voice, then spliced. A lone Nepali
    postposition between English words joins the English run (romanised), so
    "laptop को IP" is one natural English-model phrase instead of three
    fragments.
    """
    runs: List[Dict[str, str]] = []
    for word in (sentence or "").split():
        if is_latin_word(word):
            lang = "en"
        elif _DEVA.search(word.strip(",.!?;:।॥")):
            lang = "ne"
        else:  # bare punctuation / digits: join whatever came before
            lang = runs[-1]["lang"] if runs else "ne"
        if runs and runs[-1]["lang"] == lang:
            runs[-1]["text"] += f" {word}"
        else:
            runs.append({"lang": lang, "text": word})

    # Fold single postpositions into the English run before them.
    out: List[Dict[str, str]] = []
    for r in runs:
        core = r["text"].strip()
        prev = out[-1] if out else None
        if r["lang"] == "ne" and prev is not None and prev["lang"] == "en":
            # The run's first word, when it is a postposition, belongs to the
            # English word before it ("Hacker ले" -> "Hacker le").
            first, _, rest = core.partition(" ")
            first_bare = first.rstrip(",।॥?!.")
            if first_bare in ATTACH_ROMAN:
                prev["text"] += " " + ATTACH_ROMAN[first_bare] + first[len(first_bare):].replace("।", ".")
                if not rest.strip():
                    continue
                r = {"lang": "ne", "text": rest.strip()}
        if prev is not None and prev["lang"] == r["lang"]:
            prev["text"] += f" {r['text']}"
            continue
        out.append(dict(r))
    return out


def english_for_tts(text: str, final: bool = True) -> str:
    """Make an English run speakable: acronyms spelled, a clean ending.

    "IP" -> "I P", "VPN" -> "V P N". Trailing Devanagari punctuation becomes
    its English equivalent so the English model ends the phrase properly. A
    run in the middle of a sentence ends on a comma, so its pitch stays up
    instead of falling as if the sentence were over.
    """
    out = []
    for w in (text or "").split():
        core = re.sub(r"[^\w\-]", "", w)
        tail = w[len(w.rstrip(",.!?।॥")):]
        if core and _ACRONYM.match(core) and not core.isdigit() and core.lower() not in ATTACH_ROMAN.values():
            plural = core.endswith("s") and core[:-1].isupper()
            letters = core[:-1] if plural else core
            spoken = " ".join(letters) + ("s" if plural else "")
        else:
            spoken = w.rstrip(",.!?।॥")
        out.append(spoken + tail.replace("।", ".").replace("॥", "."))
    s = " ".join(out).strip()
    if not final:
        return re.sub(r"[.!?,]*$", "", s) + ","
    if not re.search(r"[.!?,]$", s):
        s += "."
    return s


# Fallback when code_switch is off but a Nepali sentence still carries Latin
# words: spell them in Devanagari the way Nepali speakers say them. The
# trailing halant stops the model adding a vowel ("account", not "accounta").
DEFAULT_NE_LEXICON: Dict[str, str] = {
    "account": "एकाउन्ट्", "accounts": "एकाउन्ट्स्", "password": "पासवर्ड्",
    "laptop": "ल्याप्टप्", "phone": "फोन्", "mobile": "मोबाइल्",
    "computer": "कम्प्युटर्", "internet": "इन्टरनेट्", "online": "अनलाइन्",
    "settings": "सेटिङ्स्", "setting": "सेटिङ्", "option": "अप्सन्",
    "options": "अप्सन्स्", "update": "अपडेट्", "app": "एप्", "apps": "एप्स्",
    "link": "लिङ्क्", "message": "मेसेज्", "messages": "मेसेजेस्",
    "privacy": "प्राइभेसी", "security": "सेक्युरिटी", "login": "लगइन्",
    "logout": "लगआउट्", "download": "डाउनलोड्", "install": "इन्स्टल्",
    "backup": "ब्याकअप्", "verification": "भेरिफिकेसन्", "two-step": "टु-स्टेप्",
    "on": "अन्", "off": "अफ्", "wi-fi": "वाइफाइ", "wifi": "वाइफाइ",
    "router": "राउटर्", "email": "इमेल्", "code": "कोड्", "hacker": "ह्याकर्",
    "hack": "ह्याक्", "scam": "स्क्याम्", "check": "चेक्", "change": "चेन्ज्",
    "whatsapp": "ह्वाट्सएप्", "facebook": "फेसबुक्", "tiktok": "टिकटक्",
    "google": "गुगल्", "youtube": "युट्युब्", "viber": "भाइबर्",
    "messenger": "मेसेन्जर्", "instagram": "इन्स्टाग्राम्", "gmail": "जीमेल्",
    "android": "एन्ड्रोइड्", "iphone": "आइफोन्", "windows": "विन्डोज्",
    "chatgpt": "च्याटजीपीटी", "esewa": "इसेवा", "khalti": "खल्ती",
}

_LETTERS_NE = {
    "A": "ए", "B": "बी", "C": "सी", "D": "डी", "E": "ई", "F": "एफ्", "G": "जी",
    "H": "एच्", "I": "आई", "J": "जे", "K": "के", "L": "एल्", "M": "एम्",
    "N": "एन्", "O": "ओ", "P": "पी", "Q": "क्यु", "R": "आर्", "S": "एस्",
    "T": "टी", "U": "यु", "V": "भी", "W": "डब्लु", "X": "एक्स्", "Y": "वाई",
    "Z": "जेड्",
}


def transliterate_latin(text: str, lexicon: Optional[Dict[str, str]] = None) -> str:
    """Replace Latin words with Devanagari spellings for the Nepali model."""
    lex = {**DEFAULT_NE_LEXICON, **{k.lower(): v for k, v in (lexicon or {}).items()}}

    def one(m: "re.Match[str]") -> str:
        w = m.group(0)
        if w.lower() in lex:
            return lex[w.lower()]
        if _ACRONYM.match(w) and not w.isdigit():
            return " ".join(_LETTERS_NE.get(c, c) for c in w)
        return w

    return re.sub(r"[A-Za-z][A-Za-z0-9\-]*", one, text or "")


# --- syllable estimate: the ceiling on how long a run may honestly be ------

def estimate_syllables(text: str) -> int:
    t = text or ""
    # Devanagari: each consonant or independent vowel not silenced by a
    # following halant is roughly one syllable.
    deva = len(re.findall(r"[ऄ-हक़-ॡ](?!्)", t))
    latin = 0
    for w in re.findall(r"[A-Za-z]+", t):
        if _ACRONYM.match(w):
            latin += len(w)  # spelled letter by letter
        else:
            latin += max(1, len(re.findall(r"[aeiouy]+", w.lower())))
    return max(1, deva + latin)


SECONDS_PER_SYLLABLE = 0.19  # measured on chatterbox-ne narration


def expected_speech_seconds(text: str, rate: float = 1.0) -> float:
    """How long honest speech of `text` should take."""
    return estimate_syllables(text) * SECONDS_PER_SYLLABLE / max(0.5, rate)


def max_speech_seconds(text: str, rate: float = 1.0) -> float:
    """Generous upper bound for honest speech of `text`.

    Anything far past this bound is the model talking after the text ended —
    the "saya"/"ha" tail.
    """
    return max(0.7, expected_speech_seconds(text, rate) * 1.6 + 0.4)


# --- audio helpers (numpy only) ---------------------------------------------

def _frame_rms(audio, sr: int, frame_s: float = 0.02):
    n = max(1, int(sr * frame_s))
    usable = (len(audio) // n) * n
    if usable == 0:
        return _np.zeros(0, dtype=_np.float32), n
    frames = audio[:usable].reshape(-1, n)
    return _np.sqrt((frames.astype(_np.float64) ** 2).mean(axis=1)), n


def trim_speech(
    audio,
    sr: int,
    max_seconds: Optional[float] = None,
    pad: float = 0.12,
    expected: Optional[float] = None,
):
    """Cut leading silence, trailing silence and hallucinated tails.

    Speech is found as islands of frames above -30 dB of the loudest frame.
    Two kinds of island are treated as the model talking after the text ended:
      * any island that starts after `max_seconds` of speech;
      * a short island (<= 1 s) at the very end that follows a real gap
        (>= 250 ms) once at least 80% of the `expected` speech is already out.
    The cut gets a short fade so it never clicks.
    """
    if _np is None or audio is None or len(audio) == 0:
        return audio
    audio = _np.asarray(audio, dtype=_np.float32)
    rms, n = _frame_rms(audio, sr)
    if not len(rms) or float(rms.max()) <= 0:
        return audio
    voiced = rms > float(rms.max()) * 10 ** (-30 / 20)
    idx = _np.flatnonzero(voiced)
    if not len(idx):
        return audio

    fs = n / sr  # seconds per frame
    islands = []
    s0 = prev = int(idx[0])
    for f in idx[1:]:
        f = int(f)
        if (f - prev) * fs > 0.12:  # >120 ms of quiet ends an island
            islands.append([s0, prev])
            s0 = f
        prev = f
    islands.append([s0, prev])
    start = islands[0][0]

    if max_seconds:
        limit = start + int(max_seconds / fs)
        islands = [isl for isl in islands if isl[0] <= limit] or [[start, limit]]
        islands[-1][1] = min(islands[-1][1], limit)

    if expected:
        while len(islands) > 1:
            last, before = islands[-1], islands[-2]
            gap = (last[0] - before[1]) * fs
            spoken = (last[0] - start) * fs
            length = (last[1] - last[0]) * fs
            if gap >= 0.25 and spoken >= 0.8 * expected and length <= 1.0:
                islands.pop()
            else:
                break

    end = islands[-1][1]
    a = max(0, start * n - int(0.03 * sr))
    b = min(len(audio), (end + 1) * n + int(pad * sr))
    out = audio[a:b].copy()
    fade = min(len(out), int(0.03 * sr))
    if fade > 1:
        out[-fade:] *= _np.linspace(1.0, 0.0, fade, dtype=_np.float32)
    return out


def _voiced_rms(audio, sr: int) -> float:
    rms, _ = _frame_rms(audio, sr)
    if not len(rms) or float(rms.max()) <= 0:
        return 0.0
    v = rms[rms > float(rms.max()) * 0.1]
    return float(_np.median(v)) if len(v) else 0.0


def splice(parts: List[Any], sr: int, gap: float = 0.04, xfade: float = 0.02):
    """Join runs from different models into one sentence.

    Loudness is matched to the median of the parts so an English word does not
    jump out of a Nepali sentence, and each join gets a tiny gap plus fades.
    """
    parts = [_np.asarray(p, dtype=_np.float32) for p in parts if p is not None and len(p)]
    if not parts:
        return _np.zeros(0, dtype=_np.float32)
    levels = [_voiced_rms(p, sr) for p in parts]
    target = float(_np.median([lv for lv in levels if lv > 0])) if any(levels) else 0.0
    f = int(xfade * sr)
    out: List[Any] = []
    for i, (p, lv) in enumerate(zip(parts, levels)):
        q = p * min(4.0, target / lv) if (lv > 0 and target > 0) else p
        q = q.copy()
        if f > 1 and len(q) > 2 * f:
            q[:f] *= _np.linspace(0.0, 1.0, f, dtype=_np.float32)
            q[-f:] *= _np.linspace(1.0, 0.0, f, dtype=_np.float32)
        out.append(q)
        if i < len(parts) - 1:
            out.append(_np.zeros(int(gap * sr), dtype=_np.float32))
    return _np.concatenate(out)


def silence(seconds: float, sr: int):
    return _np.zeros(max(0, int(seconds * sr)), dtype=_np.float32)


def change_rate(audio, sr: int, rate: float):
    """Speed up or slow down without changing pitch (ffmpeg atempo).

    Returns the input unchanged when the rate is ~1 or ffmpeg is missing —
    a slower narration is better than a failed one.
    """
    if _np is None or audio is None or len(audio) == 0 or abs(rate - 1.0) < 0.01:
        return audio
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return audio
    rate = min(2.0, max(0.5, float(rate)))
    pcm = _np.clip(_np.asarray(audio, dtype=_np.float32), -1.0, 1.0).tobytes()
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [
                ffmpeg, "-hide_banner", "-loglevel", "error",
                "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
                "-filter:a", f"atempo={rate:.4f}",
                "-f", "f32le", "-ar", str(sr), "-ac", "1", "pipe:1",
            ],
            input=pcm,
            capture_output=True,
            timeout=60,
            check=True,
        )
        out = _np.frombuffer(proc.stdout, dtype=_np.float32)
        return out.copy() if len(out) else audio
    except Exception:  # noqa: BLE001
        return audio


def wants_expressive(params: Dict[str, Any]) -> bool:
    """Did the request opt into the expressive Nepali path at all?"""
    def on(v: Any) -> bool:
        return v is True or str(v).lower() in ("1", "true", "yes")

    speed = params.get("speed")
    try:
        speed_set = speed is not None and abs(float(speed) - 1.0) > 0.001
    except (TypeError, ValueError):
        speed_set = False
    return on(params.get("code_switch")) or on(params.get("prosody_tags")) or speed_set
