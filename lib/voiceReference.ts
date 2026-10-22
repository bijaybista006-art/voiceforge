/**
 * What makes a good voice reference, and building one from training clips.
 *
 * Chatterbox reads two things from a reference clip (mtl_tts.py,
 * prepare_conditionals): the first 6 seconds become the speech prompt the
 * model continues from — how fast, how loud, how sentences end — and the
 * first 10 seconds set the sound of the voice. Nothing after 10 s is used.
 *
 * Measured in Oct 2026: a reference with 1.4 s of silence at the start, an
 * English word, and its 6-second mark in the middle of a word made every
 * Nepali take start by finishing that word — a short blip — then up to 1.8 s
 * of silence. Rebuilt from three clean training clips so that speech starts
 * at once and the 6-second mark falls in a pause, the blip and the silence
 * were gone in ten takes out of ten.
 *
 * Pure functions on Float32 samples, so they are tested without a browser.
 */

/** Seconds of the reference the model continues from. */
export const STYLE_SECONDS = 6;
/** Seconds of the reference that set the sound of the voice. */
export const VOICE_SECONDS = 10;

const FRAME_SEC = 0.02;
/** Quieter than this, relative to the loudest frame, counts as silence. */
const SILENCE_DB = -35;

function frameDb(samples: Float32Array, sr: number): number[] {
  const hop = Math.max(1, Math.round(sr * FRAME_SEC));
  const out: number[] = [];
  for (let s = 0; s + hop <= samples.length; s += hop) {
    let e = 0;
    for (let k = s; k < s + hop; k++) e += samples[k] * samples[k];
    out.push(10 * Math.log10(e / hop + 1e-12));
  }
  return out;
}

/** Which 20 ms frames have sound in them. */
function soundFrames(samples: Float32Array, sr: number): boolean[] {
  const db = frameDb(samples, sr);
  const peak = Math.max(-120, ...db);
  // Digital silence has no loudest frame to measure against.
  if (peak < -80) return db.map(() => false);
  return db.map((d) => d > peak + SILENCE_DB);
}

/** First and last moment of sound, in seconds; null for a silent clip. */
export function speechBounds(samples: Float32Array, sr: number): { start: number; end: number } | null {
  const on = soundFrames(samples, sr);
  const first = on.indexOf(true);
  if (first < 0) return null;
  const last = on.lastIndexOf(true);
  return { start: first * FRAME_SEC, end: (last + 1) * FRAME_SEC };
}

/** The clip from just before its first sound to just after its last. */
export function trimToSpeech(samples: Float32Array, sr: number, pad = 0.04): Float32Array {
  const b = speechBounds(samples, sr);
  if (!b) return samples.subarray(0, 0);
  const a = Math.max(0, Math.floor((b.start - pad) * sr));
  const z = Math.min(samples.length, Math.ceil((b.end + pad) * sr));
  return samples.subarray(a, z);
}

export interface ReferenceCheck {
  /** Silence before the first sound. */
  leadSec: number;
  /** True when the 6-second mark falls on sound — usually mid-word. */
  styleCutsSpeech: boolean;
  /** Plain-language problems, empty for a good reference. */
  warnings: string[];
}

/** Is this clip a good reference? Only the first 10 seconds matter. */
export function checkReference(samples: Float32Array, sr: number): ReferenceCheck {
  const on = soundFrames(samples, sr);
  const first = on.indexOf(true);
  const leadSec = first < 0 ? samples.length / sr : first * FRAME_SEC;
  // Sound within 60 ms either side of the mark counts as cutting a word.
  const mark = Math.round(STYLE_SECONDS / FRAME_SEC);
  let styleCutsSpeech = false;
  if (samples.length / sr > STYLE_SECONDS) {
    for (let i = mark - 3; i <= mark + 3; i++) if (on[i]) styleCutsSpeech = true;
  }
  const warnings: string[] = [];
  if (leadSec > 0.3) {
    warnings.push(
      `It starts with ${leadSec.toFixed(1)}s of silence. The model copies that, so generated speech starts late — trim it.`
    );
  }
  if (styleCutsSpeech) {
    warnings.push(
      "The 6-second mark falls in the middle of speech. The model learns your speaking style from the first 6 seconds and continues from that point, so a cut word comes out as a stray sound at the start of every clip. End a sentence just before 6 seconds."
    );
  }
  return { leadSec, styleCutsSpeech, warnings };
}

export interface BuiltReference {
  samples: Float32Array;
  /** Which input clips were used, in the order they play. */
  used: number[];
  /** Where the sentence before the 6-second mark ends. */
  styleEndsAt: number;
  durationSec: number;
}

/**
 * Join clean clips into a reference: speech from the first moment, a
 * sentence ending just before 6 seconds and a pause across the mark, then
 * more clips up to about 10 seconds. Returns null when the clips cannot fill
 * the first 6 seconds. `styleFrom` limits the first 6 seconds — the part the
 * model copies most closely — to the cleanest clips; the rest may use any.
 */
export function buildReference(
  clips: Float32Array[],
  sr: number,
  styleFrom?: number[]
): BuiltReference | null {
  const GAP = 0.25; // between sentences, as people pause
  // The sentence must be over by here. Clips carry 40 ms of margin after
  // their last sound, so the sound itself ends 0.14 s before the mark.
  const LATEST = STYLE_SECONDS - 0.1;
  const EARLIEST = 4.0; // and not so early that the pause gets long
  const TARGET = 5.5;
  const speech = clips.map((c) => trimToSpeech(c, sr));
  const len = speech.map((s) => s.length / sr);
  const ids = speech.map((_, i) => i).filter((i) => len[i] > 0.5);
  const firstIds = styleFrom ? ids.filter((i) => styleFrom.includes(i)) : ids;

  // The first sentences: the order of up to three clips, with a natural
  // pause between them, whose end lands nearest a little before the mark.
  let best: { order: number[]; end: number; gap: number } | null = null;
  const consider = (order: number[]) => {
    for (const gap of [GAP, 0.2, 0.15]) {
      const end = order.reduce((t, i, k) => t + len[i] + (k ? gap : 0), 0);
      if (end < EARLIEST || end > LATEST) continue;
      if (!best || Math.abs(end - TARGET) < Math.abs(best.end - TARGET)) best = { order, end, gap };
      return;
    }
  };
  for (const a of firstIds) {
    consider([a]);
    for (const b of firstIds) {
      if (b === a) continue;
      consider([a, b]);
      for (const c of firstIds) if (c !== a && c !== b) consider([a, b, c]);
    }
  }
  if (!best) return null;
  const { order, end, gap: firstGap } = best as { order: number[]; end: number; gap: number };

  // A pause across the mark, then more speech for the sound of the voice.
  const parts: Float32Array[] = [];
  const used: number[] = [];
  order.forEach((i, k) => {
    if (k) parts.push(new Float32Array(Math.round(firstGap * sr)));
    parts.push(speech[i]);
    used.push(i);
  });
  const pause = Math.max(0.35, STYLE_SECONDS + 0.15 - end);
  parts.push(new Float32Array(Math.round(pause * sr)));
  let t = end + pause;
  for (const i of ids) {
    if (used.includes(i) || t >= VOICE_SECONDS) continue;
    if (t + len[i] > VOICE_SECONDS + 2) continue; // keep it near 10 s
    if (used.length > order.length) {
      parts.push(new Float32Array(Math.round(GAP * sr)));
      t += GAP;
    }
    parts.push(speech[i]);
    used.push(i);
    t += len[i];
  }
  parts.push(new Float32Array(Math.round(0.2 * sr)));

  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) {
    const gain = 0.89 / peak; // -1 dB
    for (let i = 0; i < n; i++) out[i] *= gain;
  }
  return { samples: out, used, styleEndsAt: end, durationSec: n / sr };
}
