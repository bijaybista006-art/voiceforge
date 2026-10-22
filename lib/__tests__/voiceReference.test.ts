import { describe, expect, it } from "vitest";
import {
  STYLE_SECONDS,
  buildReference,
  checkReference,
  speechBounds,
  trimToSpeech,
} from "../voiceReference";

const SR = 24000;
const tone = (sec: number, level = 0.5) =>
  Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => level * Math.sin((2 * Math.PI * 180 * i) / SR));
const quiet = (sec: number) => new Float32Array(Math.round(sec * SR));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** A recorded sentence: a little room tone either side, as the training page saves it. */
const clip = (sec: number) => join(quiet(0.2), tone(sec), quiet(0.22));

describe("speechBounds and trimToSpeech", () => {
  it("finds the sound and keeps a small margin", () => {
    const c = clip(3);
    expect(speechBounds(c, SR)).toMatchObject({ start: 0.2 });
    expect(trimToSpeech(c, SR).length / SR).toBeCloseTo(3.08, 1);
  });

  it("returns nothing for silence", () => {
    expect(speechBounds(quiet(1), SR)).toBeNull();
    expect(trimToSpeech(quiet(1), SR).length).toBe(0);
  });
});

describe("checkReference", () => {
  it("flags the reference that caused the stray start sounds", () => {
    // 1.4 s of silence, then speech straight through the 6-second mark.
    const r = checkReference(join(quiet(1.4), tone(8)), SR);
    expect(r.leadSec).toBeCloseTo(1.4, 1);
    expect(r.styleCutsSpeech).toBe(true);
    expect(r.warnings).toHaveLength(2);
  });

  it("passes a clip that starts on speech and pauses at 6 seconds", () => {
    const r = checkReference(join(quiet(0.05), tone(5.7), quiet(0.6), tone(3)), SR);
    expect(r.styleCutsSpeech).toBe(false);
    expect(r.warnings).toHaveLength(0);
  });

  it("does not judge the mark on a clip shorter than 6 seconds", () => {
    expect(checkReference(tone(5), SR).styleCutsSpeech).toBe(false);
  });
});

describe("buildReference", () => {
  it("ends a sentence just before 6 seconds and pauses across the mark", () => {
    const clips = [clip(2.8), clip(2.7), clip(3.3), clip(3.9)];
    const r = buildReference(clips, SR)!;
    expect(r).not.toBeNull();
    expect(r.styleEndsAt).toBeLessThanOrEqual(STYLE_SECONDS - 0.1);
    expect(r.styleEndsAt).toBeGreaterThanOrEqual(4.0);
    expect(checkReference(r.samples, SR).warnings).toHaveLength(0);
    expect(speechBounds(r.samples, SR)!.start).toBeLessThan(0.05);
    expect(r.durationSec).toBeGreaterThan(8);
    expect(r.durationSec).toBeLessThan(12.5);
  });

  it("uses each clip once and normalises to -1 dB", () => {
    const r = buildReference([clip(2.8), clip(2.7), clip(3.3), clip(3.9)], SR)!;
    expect(new Set(r.used).size).toBe(r.used.length);
    let peak = 0;
    for (const v of r.samples) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.89, 2);
  });

  it("returns null when the clips cannot fill the first 6 seconds", () => {
    expect(buildReference([clip(1.0), clip(0.9)], SR)).toBeNull();
  });
});

describe("buildReference with preferred clips", () => {
  it("takes the first 6 seconds only from the preferred clips and fills the rest from any", () => {
    const clips = [clip(3.9), clip(2.8), clip(2.7), clip(3.3)];
    const r = buildReference(clips, SR, [1, 2])!;
    expect(r.used.slice(0, 2).sort()).toEqual([1, 2]);
    expect(r.used.length).toBeGreaterThan(2);
    expect(r.durationSec).toBeGreaterThan(8);
  });
});
