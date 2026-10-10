import type { GenParams, ModelId } from "./types";

/**
 * Languages supported by Chatterbox Multilingual (the backend model).
 * No Nepali yet — Hindi is the closest supported option.
 */
export const LANGUAGES: Array<{ code: string; name: string }> = [
  { code: "en", name: "English" },
  { code: "hi", name: "Hindi — हिन्दी" },
  // Not one of Chatterbox's 23 languages. It has a profile in
  // lib/languageProfiles.ts that picks a Nepali model when one is configured
  // and falls back to Hindi, which shares the script, when none is.
  { code: "ne", name: "Nepali — नेपाली" },
  { code: "ar", name: "Arabic" },
  { code: "zh", name: "Chinese" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "ms", name: "Malay" },
  { code: "no", name: "Norwegian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ru", name: "Russian" },
  { code: "es", name: "Spanish" },
  { code: "sw", name: "Swahili" },
  { code: "sv", name: "Swedish" },
  { code: "tr", name: "Turkish" },
];

/**
 * Hard ceiling per chunk. Load-bearing: both models drift, rush, and
 * hallucinate words on long inputs. 1–3 sentences per pass is the sweet spot.
 */
export const MAX_CHARS = 240;

/** Chunks under this get merged into a neighbour — tiny chunks sound clipped. */
export const MIN_CHARS = 20;

/** Stitch gaps (seconds). Tuned — don't casually change. */
export const SENTENCE_GAP_SEC = 0.35;
export const PARAGRAPH_GAP_SEC = 0.7;

/** Export peak-normalization target. */
export const NORMALIZE_PEAK_DBFS = -1;

/** Spoken-minutes estimate for the script stats. */
export const WORDS_PER_MINUTE = 150;

/** Rough speaking rate used to size pending bars in the queue rail. */
export const EST_CHARS_PER_SEC = 15;

/** Health poll interval while connected / generating. */
export const HEALTH_POLL_MS = 30_000;

/** 1 initial try + 2 automatic retries with fresh seeds. */
export const MAX_ATTEMPTS = 3;

/** Reference sample guidance (seconds). */
export const SAMPLE_MIN_SEC = 8;
export const SAMPLE_IDEAL_MIN_SEC = 15;
export const SAMPLE_IDEAL_MAX_SEC = 20;

export const DEFAULT_PARAMS: GenParams = {
  seed: 4242,
  speed: 1.0,
  language: "en",
  // Chatterbox defaults tuned for factual narration — don't casually change.
  exaggeration: 0.4,
  cfg: 0.5,
  temperature: 0.7,
  stylePrompt: "Calm, clear, informative narration",
};

export const MODEL_INFO: Record<ModelId, { name: string; blurb: string }> = {
  chatterbox: {
    name: "Chatterbox",
    blurb: "Faster, consistent, no tuning. Best default for narration.",
  },
  qwen3: {
    name: "Qwen3-TTS 1.7B",
    blurb: "Higher fidelity, slower, more sensitive to the reference clip.",
  },
};

// ---------------------------------------------------------------------------
// Talking-head render budgeting
// ---------------------------------------------------------------------------

/**
 * Roughly how many seconds of GPU time each engine costs per second of audio
 * on a free T4. Measured from real runs, deliberately pessimistic — the point
 * is to stop someone starting a job that cannot finish, not to look fast.
 */
export const RENDER_COST = {
  wav2lip: 1.5,
  sadtalker: 12,
} as const;

/** The GFPGAN enhancer runs a second network per frame. */
export const ENHANCER_MULTIPLIER = 2.5;

/**
 * Hard ceiling on audio length for SadTalker. Past this, a free-tier render
 * reliably outlives the session — so the app refuses rather than warning and
 * letting the user discover it 45 minutes later.
 */
export const SADTALKER_MAX_AUDIO_SEC = 90;

/** Length of the quick quality-check render. */
export const PREVIEW_SEC = 15;

export function estimateRenderSec(
  engine: "wav2lip" | "sadtalker",
  audioSec: number,
  enhance = false
): number {
  const base = audioSec * RENDER_COST[engine];
  return engine === "sadtalker" && enhance ? base * ENHANCER_MULTIPLIER : base;
}
