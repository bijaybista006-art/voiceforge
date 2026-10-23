import { describe, expect, it } from "vitest";
import { looksNepali, scriptGuide, scriptText } from "../voiceScripts";

describe("scriptGuide", () => {
  it("gives Nepali guidance and scripts for Nepali, English for English", () => {
    const ne = scriptGuide("ne");
    expect(looksNepali(ne.howTo)).toBe(true);
    expect(ne.scripts.every((s) => looksNepali(scriptText(s)))).toBe(true);
    const en = scriptGuide("en");
    expect(looksNepali(en.howTo)).toBe(false);
    expect(en.scripts.length).toBeGreaterThan(0);
  });

  it("asks other languages to read their own words", () => {
    expect(scriptGuide("fr").scripts).toEqual([]);
  });

  it("keeps every first line short enough to end by about 4 seconds", () => {
    // About 12–14 characters a second when read aloud, in both languages.
    for (const s of [...scriptGuide("ne").scripts, ...scriptGuide("en").scripts]) {
      expect(s.first.length).toBeGreaterThan(30);
      expect(s.first.length).toBeLessThan(60);
    }
  });
});

describe("looksNepali", () => {
  it("tells a Nepali transcript from an English one", () => {
    expect(looksNepali("नमस्ते साथीहरू, आजको भिडियोमा स्वागत छ।")).toBe(true);
    expect(looksNepali("नमस्ते, म बिजय। के तपाईंको password साँच्चै सुरक्षित छ?")).toBe(true);
    expect(looksNepali("Hi, I'm Bijay from IT Gateway.")).toBe(false);
    expect(looksNepali("")).toBe(false);
  });
});
