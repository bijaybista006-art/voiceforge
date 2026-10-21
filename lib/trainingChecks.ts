/**
 * Quality checks for training clips. Pure functions — no DOM, no storage —
 * so the browser runs them before upload and the tests run them on synthetic
 * signals.
 *
 * Training data is held to a stricter standard than a voice's reference clip.
 * A reference clip is imitated once per request; a training clip is learned
 * from, so clipping, room silence or a transcript that doesn't match the
 * audio is baked into every later render.
 */

export const TRAINING_LANGUAGES = ["ne", "en"] as const;
export type TrainingLanguage = (typeof TRAINING_LANGUAGES)[number];

export function isTrainingLanguage(code: string): code is TrainingLanguage {
  return (TRAINING_LANGUAGES as readonly string[]).includes(code);
}

/** Sample rate every training clip is stored at — the rate the model speaks at. */
export const TRAINING_SAMPLE_RATE = 24_000;
export const MIN_CLIP_SEC = 3;
export const MAX_CLIP_SEC = 20;
/** Minutes per language before a first training run is worth doing. */
export const TARGET_MINUTES = 30;

const FRAME_SEC = 0.02;
/** Leading and trailing quiet kept after trimming, so no word is cut. */
const PAD_SEC = 0.2;

export interface ClipMetrics {
  durationSec: number;
  /** Loudest sample, dBFS. 0 is full scale. */
  peakDb: number;
  /** Average level of the frames that contain speech, dBFS. */
  speechDb: number;
  /** Share of samples at or near full scale, 0–1. */
  clippedRatio: number;
  /** Longest run of silence between the first and last speech, seconds. */
  longestPauseSec: number;
  /** Where speech starts and ends, seconds. Equal when there is none. */
  speechStartSec: number;
  speechEndSec: number;
}

export interface ClipIssue {
  code: string;
  message: string;
  /** "block" stops the save; "warn" is shown but allowed. */
  level: "block" | "warn";
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120);

function frameLevels(samples: Float32Array, sampleRate: number): number[] {
  const size = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += size) {
    let sum = 0;
    const end = Math.min(samples.length, i + size);
    for (let k = i; k < end; k++) sum += samples[k] * samples[k];
    out.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  return out;
}

/**
 * Which frames are speech. The threshold follows the recording: 30 dB under
 * its loudest frames, but never below -50 dBFS, so a quiet room's hiss is
 * not mistaken for a word and a soft speaker is not mistaken for silence.
 */
function speechMask(levels: number[]): boolean[] {
  const sorted = [...levels].sort((a, b) => b - a);
  const loud = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const threshold = Math.max(db(loud) - 30, -50);
  return levels.map((l) => db(l) > threshold);
}

export function analyzeClip(samples: Float32Array, sampleRate: number): ClipMetrics {
  const durationSec = samples.length / sampleRate;
  let peak = 0;
  let clipped = 0;
  for (const v of samples) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.99) clipped++;
  }

  const levels = frameLevels(samples, sampleRate);
  const speech = speechMask(levels);
  const first = speech.indexOf(true);
  const last = speech.lastIndexOf(true);

  let speechSum = 0;
  let speechFrames = 0;
  let longestPause = 0;
  let run = 0;
  for (let i = Math.max(0, first); first >= 0 && i <= last; i++) {
    if (speech[i]) {
      speechSum += levels[i] * levels[i];
      speechFrames++;
      run = 0;
    } else {
      run++;
      longestPause = Math.max(longestPause, run);
    }
  }

  return {
    durationSec,
    peakDb: db(peak),
    speechDb: speechFrames ? db(Math.sqrt(speechSum / speechFrames)) : -120,
    clippedRatio: samples.length ? clipped / samples.length : 0,
    longestPauseSec: longestPause * FRAME_SEC,
    speechStartSec: first >= 0 ? first * FRAME_SEC : 0,
    speechEndSec: last >= 0 ? Math.min(durationSec, (last + 1) * FRAME_SEC) : 0,
  };
}

/**
 * Cut the silence before the first word and after the last, keeping a short
 * pad. Long lead-in silence teaches the model to start late.
 */
export function trimToSpeech(
  samples: Float32Array,
  sampleRate: number,
  metrics: ClipMetrics = analyzeClip(samples, sampleRate)
): Float32Array {
  if (metrics.speechEndSec <= metrics.speechStartSec) return samples;
  const start = Math.max(0, Math.floor((metrics.speechStartSec - PAD_SEC) * sampleRate));
  const end = Math.min(samples.length, Math.ceil((metrics.speechEndSec + PAD_SEC) * sampleRate));
  return samples.slice(start, end);
}

export function checkClip(m: ClipMetrics): ClipIssue[] {
  const issues: ClipIssue[] = [];
  if (m.speechEndSec <= m.speechStartSec) {
    issues.push({ code: "no_speech", level: "block", message: "No speech was found in this clip." });
    return issues;
  }
  if (m.durationSec < MIN_CLIP_SEC) {
    issues.push({ code: "too_short", level: "block", message: `Under ${MIN_CLIP_SEC} seconds — say a full sentence.` });
  }
  if (m.durationSec > MAX_CLIP_SEC) {
    issues.push({ code: "too_long", level: "block", message: `Over ${MAX_CLIP_SEC} seconds — split it into shorter sentences.` });
  }
  if (m.clippedRatio > 0.001) {
    issues.push({ code: "clipping", level: "block", message: "The recording is distorted (too loud). Move back from the mic or lower its gain." });
  } else if (m.peakDb > -0.5) {
    issues.push({ code: "near_clipping", level: "warn", message: "Very close to distorting. A little further from the mic would be safer." });
  }
  if (m.speechDb < -38) {
    issues.push({ code: "too_quiet", level: "block", message: "Too quiet to learn from. Move closer to the mic." });
  } else if (m.speechDb < -30) {
    issues.push({ code: "quiet", level: "warn", message: "On the quiet side. Closer to the mic would help." });
  }
  if (m.longestPauseSec > 1.5) {
    issues.push({ code: "long_pause", level: "warn", message: `There is a ${m.longestPauseSec.toFixed(1)}s pause in the middle. Read it in one go if you can.` });
  }
  return issues;
}

/**
 * Does the transcript plausibly match the audio's length? Not a proof — a
 * cheap catch for the common mistakes: a sentence skipped, the wrong prompt
 * read, or a description typed instead of the words spoken.
 */
export function checkTranscript(text: string, speechSec: number, language: string): ClipIssue[] {
  const t = text.trim();
  if (!t) return [{ code: "no_text", level: "block", message: "Type exactly what was said." }];
  if (t.length > 1000) return [{ code: "text_too_long", level: "block", message: "That transcript is too long for one clip." }];
  const perSec = t.replace(/\s+/g, "").length / Math.max(0.5, speechSec);
  // Devanagari packs a syllable into fewer characters than Latin script.
  const [low, high] = language === "ne" ? [3, 22] : [5, 28];
  if (perSec < low) {
    return [{ code: "text_short", level: "warn", message: "The transcript looks short for this much speech. Is every word there?" }];
  }
  if (perSec > high) {
    return [{ code: "text_long", level: "warn", message: "The transcript looks long for this much speech. Was part of it skipped?" }];
  }
  return [];
}

export function blocks(issues: ClipIssue[]): boolean {
  return issues.some((i) => i.level === "block");
}
