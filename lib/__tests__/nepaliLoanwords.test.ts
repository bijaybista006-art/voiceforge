import { describe, expect, it } from "vitest";
import { approximateInDevanagari, transliterateForNepali } from "../nepaliLoanwords";

const LATIN = /[A-Za-z]/;

describe("transliterateForNepali", () => {
  it("leaves no Latin for the Nepali model to stumble on", () => {
    const out = transliterateForNepali(
      "तपाईंको laptop र mobile मा strong password राख्नुहोस्। Hacker ले तपाईंको account मा login गर्न सक्छ।"
    );
    expect(LATIN.test(out)).toBe(false);
    expect(out).toContain("ल्यापटप्");
    expect(out).toContain("पासवर्ड्");
    expect(out).toContain("ह्याकर्");
  });

  it("keeps the sentence whole: same words, same order, same punctuation", () => {
    const src = "तपाईंको laptop मा password राख्नुहोस्।";
    const out = transliterateForNepali(src);
    expect(out.split(" ")).toHaveLength(src.split(" ").length);
    expect(out.startsWith("तपाईंको ")).toBe(true);
    expect(out.endsWith("राख्नुहोस्।")).toBe(true);
  });

  it("spells initials as letters", () => {
    expect(transliterateForNepali("तपाईंको IP र VPN")).toBe("तपाईंको आई पी र भी पी एन्");
  });

  it("separates letters from digits and leaves the digits for the backend", () => {
    expect(transliterateForNepali("M365 को license")).toBe("एम् 365 को लाइसेन्स्");
  });

  it("approximates a word nobody listed, rather than leaving it in Latin", () => {
    const out = transliterateForNepali("यो simple price हो");
    expect(LATIN.test(out)).toBe(false);
    expect(approximateInDevanagari("price")).toBe("प्राइस्");
    expect(approximateInDevanagari("night")).toBe("नाइट्");
    expect(approximateInDevanagari("window")).toBe("विन्डो");
  });

  it("lets the caller's lexicon win", () => {
    expect(transliterateForNepali("मेरो laptop", { Laptop: "ल्याप्टप" })).toBe("मेरो ल्याप्टप");
  });

  it("does not touch an English line or a pure Nepali one", () => {
    expect(transliterateForNepali("Thank you, and stay safe!")).toBe("Thank you, and stay safe!");
    expect(transliterateForNepali("नमस्ते साथीहरू।")).toBe("नमस्ते साथीहरू।");
  });
});
