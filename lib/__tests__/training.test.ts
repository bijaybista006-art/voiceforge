import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
const files = new Map<string, number>();
let kvWorks = true;

vi.mock("../server/redis", () => ({
  kvGet: vi.fn(async (k: string) => store.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: unknown) => {
    if (!kvWorks) return false;
    store.set(k, v);
    return true;
  }),
  kvDel: vi.fn(async (k: string) => store.delete(k)),
  kvScan: vi.fn(async (prefix: string) =>
    [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)
  ),
  isRedisConfigured: () => true,
  redisFailure: () => null,
}));

vi.mock("../server/blob", () => ({
  putBlob: vi.fn(async (path: string, body: ArrayBuffer) => {
    files.set(path, body.byteLength);
    return { url: `https://store.test/${path}`, pathname: path };
  }),
  deleteBlob: vi.fn(async (path: string) => {
    files.delete(path);
  }),
  isBlobConfigured: () => true,
}));

import {
  TrainingError,
  addSample,
  deleteSample,
  listSamples,
  summarize,
  toPipeList,
  speakersOf,
  updateSample,
} from "../server/training";

/** A silent 16-bit PCM WAV. */
function wav(seconds: number, sampleRate = 24000, channels = 1): ArrayBuffer {
  const frames = Math.round(seconds * sampleRate);
  const bytes = frames * channels * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + bytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, bytes, true);
  return buf;
}

beforeEach(() => {
  store.clear();
  files.clear();
  kvWorks = true;
});

describe("addSample", () => {
  it("stores the clip under training/<language>/ and records it", async () => {
    const s = await addSample({ speaker: "Bijay", language: "ne", text: "  नमस्ते   साथीहरू  ", source: "prompt", promptId: "ne-001", wav: wav(4) });
    expect(s.path).toMatch(/^training\/ne\/ne-[a-z0-9]+-[0-9a-f]{6}\.wav$/);
    expect(s.text).toBe("नमस्ते साथीहरू");
    expect(s.promptId).toBe("ne-001");
    expect(s.durationSec).toBeCloseTo(4, 2);
    expect(files.has(s.path)).toBe(true);
    expect(await listSamples("ne")).toHaveLength(1);
  });

  it("refuses languages it cannot train", async () => {
    await expect(addSample({ speaker: "Bijay", language: "fr", text: "Bonjour", source: "free", wav: wav(4) })).rejects.toThrow(TrainingError);
  });

  it("refuses anything but 24 kHz mono 16-bit, and lengths outside 3–20 s", async () => {
    await expect(addSample({ speaker: "Bijay", language: "en", text: "Hi there.", source: "free", wav: wav(4, 48000) })).rejects.toThrow(/24 kHz mono/);
    await expect(addSample({ speaker: "Bijay", language: "en", text: "Hi there.", source: "free", wav: wav(4, 24000, 2) })).rejects.toThrow(/24 kHz mono/);
    await expect(addSample({ speaker: "Bijay", language: "en", text: "Hi.", source: "free", wav: wav(1.5) })).rejects.toThrow(/3–20 seconds/);
    await expect(addSample({ speaker: "Bijay", language: "en", text: "Long.", source: "free", wav: wav(25) })).rejects.toThrow(/3–20 seconds/);
  });

  it("requires a transcript", async () => {
    await expect(addSample({ speaker: "Bijay", language: "en", text: "   ", source: "free", wav: wav(4) })).rejects.toThrow(/what was said/);
  });

  it("removes the uploaded file if the record can't be written", async () => {
    kvWorks = false;
    await expect(addSample({ speaker: "Bijay", language: "en", text: "Hello there.", source: "free", wav: wav(4) })).rejects.toThrow(/Nothing was saved/);
    expect(files.size).toBe(0);
  });
});

describe("editing and deleting", () => {
  it("fixes a transcript", async () => {
    const s = await addSample({ speaker: "Bijay", language: "en", text: "Helo there.", source: "free", wav: wav(4) });
    expect((await updateSample(s.id, { text: "Hello there." }))?.text).toBe("Hello there.");
    await expect(updateSample(s.id, { text: " " })).rejects.toThrow(/empty/);
    expect(await updateSample("nope", { text: "x" })).toBeNull();
  });

  it("deletes the file and the record together", async () => {
    const s = await addSample({ speaker: "Bijay", language: "en", text: "Hello there.", source: "free", wav: wav(4) });
    expect(await deleteSample(s.id)).toBe(true);
    expect(files.has(s.path)).toBe(false);
    expect(await listSamples()).toHaveLength(0);
    expect(await deleteSample(s.id)).toBe(false);
  });
});

describe("dataset", () => {
  it("totals each language", async () => {
    await addSample({ speaker: "Bijay", language: "ne", text: "एक", source: "free", wav: wav(4) });
    await addSample({ speaker: "Bijay", language: "ne", text: "दुई", source: "free", wav: wav(6) });
    await addSample({ speaker: "Bijay", language: "en", text: "Three.", source: "free", wav: wav(5) });
    const sum = summarize(await listSamples());
    expect(sum.find((s) => s.language === "ne")).toMatchObject({ clips: 2, seconds: 10 });
    expect(sum.find((s) => s.language === "en")).toMatchObject({ clips: 1, seconds: 5 });
  });

  it("writes one audio|text line per clip, with no stray separators", async () => {
    const s = await addSample({ speaker: "Bijay", language: "en", text: "A | B", source: "free", wav: wav(4) });
    await updateSample(s.id, { text: "First line\nsecond | part" });
    const out = toPipeList(await listSamples("en"));
    expect(out).toBe(`${s.url}|First line second part`);
    expect(out.split("\n")).toHaveLength(1);
  });
});

describe("speakers and descriptions", () => {
  it("needs a speaker, so no clip lands outside a set", async () => {
    await expect(addSample({ speaker: "  ", language: "en", text: "Hello there.", source: "free", wav: wav(4) })).rejects.toThrow(/Name the speaker/);
    expect(files.size).toBe(0);
  });

  it("keeps each speaker's clips apart, matching names without case", async () => {
    await addSample({ speaker: "Bijay", language: "ne", text: "एक", source: "free", wav: wav(4) });
    await addSample({ speaker: "bijay ", language: "ne", text: "दुई", source: "free", wav: wav(4) });
    await addSample({ speaker: "Apsara", language: "ne", text: "तीन", source: "free", wav: wav(4) });
    expect(await listSamples("ne", "BIJAY")).toHaveLength(2);
    expect(await listSamples("ne", "Apsara")).toHaveLength(1);
    expect(speakersOf(await listSamples())).toEqual(["Bijay", "Apsara"]);
  });

  it("lists clips saved before speakers existed as Unnamed", async () => {
    store.set("vf:sample:old", { id: "old", language: "ne", text: "पुरानो", durationSec: 4, createdAt: 1 });
    expect(speakersOf(await listSamples())).toEqual(["Unnamed"]);
    expect(await listSamples("ne", "unnamed")).toHaveLength(1);
  });

  it("stores an optional description beside the transcript, never in it", async () => {
    const s = await addSample({
      speaker: "Bijay",
      language: "en",
      text: "Hello there.",
      description: "  calm   tone\n\n\n\nhome office  ",
      source: "free",
      wav: wav(4),
    });
    expect(s.description).toBe("calm tone\n\nhome office");
    expect(s.text).toBe("Hello there.");
    expect(toPipeList([s])).not.toMatch(/calm/);

    const plain = await addSample({ speaker: "Bijay", language: "en", text: "No notes.", source: "free", wav: wav(4) });
    expect(plain).not.toHaveProperty("description");
  });

  it("edits the description alone, or clears it, without touching the transcript", async () => {
    const s = await addSample({ speaker: "Bijay", language: "en", text: "Hello there.", description: "old", source: "free", wav: wav(4) });
    const edited = await updateSample(s.id, { description: "USB mic" });
    expect(edited).toMatchObject({ text: "Hello there.", description: "USB mic" });
    const cleared = await updateSample(s.id, { description: "  " });
    expect(cleared).not.toHaveProperty("description");
    expect(cleared?.text).toBe("Hello there.");
  });
});
