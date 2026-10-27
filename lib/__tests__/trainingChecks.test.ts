import { describe, expect, it } from "vitest";
import {
  analyzeClip,
  blocks,
  checkClip,
  checkTranscript,
  trimToSpeech,
} from "../trainingChecks";
import { TRAINING_PROMPTS, nextPrompt, recordingOrder } from "../trainingPrompts";

const SR = 24000;

/** Silence, then a tone at `amp`, then silence — a stand-in for one spoken line. */
function clip(leadSec: number, speechSec: number, tailSec: number, amp = 0.3): Float32Array {
  const out = new Float32Array(Math.round((leadSec + speechSec + tailSec) * SR));
  const a = Math.round(leadSec * SR);
  const b = a + Math.round(speechSec * SR);
  for (let i = a; i < b; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  return out;
}

describe("analyzeClip", () => {
  it("finds where the speech starts and ends", () => {
    const m = analyzeClip(clip(1, 4, 1), SR);
    expect(m.durationSec).toBeCloseTo(6, 1);
    expect(m.speechStartSec).toBeCloseTo(1, 1);
    expect(m.speechEndSec).toBeCloseTo(5, 1);
  });

  it("measures the speech level, not the silence around it", () => {
    const m = analyzeClip(clip(2, 4, 2, 0.3), SR);
    // A 0.3 sine is about -13.5 dBFS RMS; the silence must not drag it down.
    expect(m.speechDb).toBeGreaterThan(-15);
    expect(m.speechDb).toBeLessThan(-12);
  });

  it("finds a pause in the middle", () => {
    const s = new Float32Array(SR * 7);
    s.set(clip(0, 2, 0), 0);
    s.set(clip(0, 2, 0), SR * 4); // two seconds of nothing between
    expect(analyzeClip(s, SR).longestPauseSec).toBeGreaterThan(1.8);
  });
});

describe("trimToSpeech", () => {
  it("cuts long silence but keeps a short pad around the words", () => {
    const trimmed = trimToSpeech(clip(2, 4, 3), SR);
    const sec = trimmed.length / SR;
    expect(sec).toBeGreaterThan(4.3);
    expect(sec).toBeLessThan(4.6);
  });

  it("leaves a clip with no speech untouched", () => {
    const silent = new Float32Array(SR * 3);
    expect(trimToSpeech(silent, SR)).toBe(silent);
  });
});

describe("checkClip", () => {
  const codes = (s: Float32Array) => checkClip(analyzeClip(s, SR)).map((i) => i.code);

  it("passes a clean clip", () => {
    expect(checkClip(analyzeClip(clip(0.2, 5, 0.2), SR))).toEqual([]);
  });

  it("blocks a clip with no speech", () => {
    expect(codes(new Float32Array(SR * 4))).toEqual(["no_speech"]);
  });

  it("blocks clips that are too short or too long", () => {
    expect(codes(clip(0, 2, 0))).toContain("too_short");
    expect(codes(clip(0, 25, 0))).toContain("too_long");
  });

  it("blocks a distorted clip", () => {
    const s = clip(0.2, 5, 0.2, 1);
    for (let i = 0; i < s.length; i++) s[i] = Math.max(-1, Math.min(1, s[i] * 3));
    const issues = checkClip(analyzeClip(s, SR));
    expect(issues.map((i) => i.code)).toContain("clipping");
    expect(blocks(issues)).toBe(true);
  });

  it("blocks a clip too quiet to learn from, and only warns when merely quiet", () => {
    expect(codes(clip(0.2, 5, 0.2, 0.005))).toContain("too_quiet");
    const quiet = checkClip(analyzeClip(clip(0.2, 5, 0.2, 0.04), SR));
    expect(quiet.map((i) => i.code)).toContain("quiet");
    expect(blocks(quiet)).toBe(false);
  });
});

describe("checkTranscript", () => {
  it("requires text", () => {
    expect(blocks(checkTranscript("  ", 4, "en"))).toBe(true);
  });

  it("accepts a sentence that fits the audio", () => {
    expect(checkTranscript("Turn on multi-factor authentication before you do anything else.", 4, "en")).toEqual([]);
    expect(checkTranscript("आफ्नो पासवर्ड कसैलाई पनि नभन्नुहोस्।", 3, "ne")).toEqual([]);
  });

  it("warns when the text is far too short or too long for the audio", () => {
    expect(checkTranscript("Hello.", 8, "en")[0]?.code).toBe("text_short");
    expect(checkTranscript("x".repeat(400), 3, "en")[0]?.code).toBe("text_long");
  });
});

describe("training prompts", () => {
  it("has unique, stable ids for both languages", () => {
    for (const list of Object.values(TRAINING_PROMPTS)) {
      const ids = list.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(list.length).toBeGreaterThan(50);
    }
    expect(TRAINING_PROMPTS.ne[0].id).toBe("ne-001");
  });

  it("serves the breathy-sound, voice-reference and important-word sentences first", () => {
    const first = nextPrompt("ne", new Set());
    expect(first?.id).toBe("ne-568");
    expect(first?.note).toMatch(/^Breathy sounds/);
    const breathy = TRAINING_PROMPTS.ne.filter((p) => p.note?.startsWith("Breathy sounds")).map((p) => p.id);
    expect(recordingOrder("ne").slice(0, breathy.length).map((p) => p.id)).toEqual(breathy);
    const order = recordingOrder("ne").map((p) => p.id).slice(breathy.length);
    expect(order.slice(0, 11)).toEqual([
      "ne-488", "ne-489", "ne-490", "ne-491", "ne-492", "ne-493", "ne-494", "ne-495",
      "ne-028", "ne-079", "ne-082",
    ]);
    expect(order[11]).toBe("ne-496");
    expect(new Set(order).size + breathy.length).toBe(TRAINING_PROMPTS.ne.length);
  });

  it("then moves through the rest in order, skipping what is recorded", () => {
    const priority = recordingOrder("ne").filter((p) => /^(Breathy sounds|Voice reference|Important words|Long passage|Every kind of word)/.test(p.note ?? "") || ["ne-028", "ne-079", "ne-082"].includes(p.id));
    const recorded = new Set([...priority.map((p) => p.id), "ne-001", "ne-002"]);
    expect(nextPrompt("ne", recorded)?.id).toBe("ne-003");
    expect(nextPrompt("ne", recorded, "ne-003")?.id).toBe("ne-004");
  });

  it("gives every sentence a reading note, and keeps the old ids", () => {
    expect(TRAINING_PROMPTS.ne.every((p) => p.note)).toBe(true);
    expect(TRAINING_PROMPTS.ne.find((p) => p.id === "ne-028")?.text).toBe("धन्यवाद, अर्को भिडियोमा भेटौंला।");
    expect(TRAINING_PROMPTS.ne.find((p) => p.id === "ne-079")?.text).toBe("अर्को भिडियोमा फेरि भेटौंला, नमस्ते।");
  });

  it("covers every Nepali letter and common letter cluster", () => {
    const all = TRAINING_PROMPTS.ne.map((p) => p.text).join(" ");
    const letters = "अ आ इ ई उ ऊ ऋ ए ऐ ओ औ क ख ग घ ङ च छ ज झ ञ ट ठ ड ढ ण त थ द ध न प फ ब भ म य र ल व श ष स ह क्ष त्र ज्ञ ा ि ी ु ू ृ े ै ो ौ ं ँ ः ्";
    const clusters =
      "क्त क्य क्र ख्य ग्य ग्र ङ्क ङ्ख ङ्ग ङ्घ च्च च्छ ज्ज ज्य ञ्च ञ्ज ट्ट ट्र ड्ड ड्र ण्ड त्त त्य त्व द्ध द्य द्व द्र ध्य ध्व न्त न्द न्ध न्न न्य प्त प्र प्ल ब्ब ब्र भ्र म्ब म्म म्र य्य र्क र्ग र्च र्ज र्त र्थ र्द र्ध र्न र्प र्म र्य र्व र्श र्ष र्स ल्ल ल्य व्य श्च श्र श्व ष्ट ष्ठ ष्ण स्क स्त स्थ स्न स्प स्म स्य स्व ह्म ह्य ह्र ह्ल";
    const missing = [...letters.split(" "), ...clusters.split(" ")].filter((x) => !all.includes(x));
    expect(missing).toEqual([]);
  });

  it("returns nothing once every sentence is recorded", () => {
    const all = new Set(TRAINING_PROMPTS.en.map((p) => p.id));
    expect(nextPrompt("en", all)).toBeNull();
  });
});
