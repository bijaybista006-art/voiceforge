import { describe, expect, it } from "vitest";
import {
  applyNepaliPronunciations,
  approximateInDevanagari,
  prepareNepali,
  transliterateForNepali,
} from "../nepaliLoanwords";

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

describe("the Nepali pronunciation list", () => {
  it("respells a Nepali word, and keeps the ending attached to it", () => {
    const list = { "अभिभावक": "अभि-भावक" };
    expect(applyNepaliPronunciations("अभिभावक र अभिभावकले", list)).toBe("अभि-भावक र अभि-भावकले");
  });

  it("does not touch the same letters in the middle of another word", () => {
    const list = { "वारी": "वा-री" };
    expect(applyNepaliPronunciations("जिम्मेवारी", list)).toBe("जिम्मेवारी");
  });

  it("prefers the longer entry when two overlap", () => {
    const list = { "अपरिचित": "अ-परिचित", "अपरिचित व्यक्ति": "अ-परिचित ब्यक्ति" };
    expect(applyNepaliPronunciations("अपरिचित व्यक्तिलाई", list)).toBe("अ-परिचित ब्यक्तिलाई");
  });

  it("never rewrites its own output", () => {
    // If the spelling contains another entry's word, it is left as written.
    const list = { "क": "ख", "ख": "ग" };
    expect(applyNepaliPronunciations("क ख", list)).toBe("ख ग");
  });

  it("uses English entries when respelling English words", () => {
    const out = prepareNepali("मेरो coin हरायो", { pronunciations: { coin: "क्वाइन" } });
    expect(out).toBe("मेरो क्वाइन हरायो");
  });

  it("lets a request's own lexicon win over the list", () => {
    const out = prepareNepali("मेरो coin", {
      pronunciations: { coin: "क्वाइन" },
      lexicon: { coin: "कोइन" },
    });
    expect(out).toBe("मेरो कोइन");
  });

  it("leaves text alone when the list is empty", () => {
    expect(prepareNepali("नमस्ते साथीहरू।")).toBe("नमस्ते साथीहरू।");
  });

  it("applies the spellings chosen by ear without any list", () => {
    expect(prepareNepali("अभिभावकले इनबक्सको मेसेज हेर्नुपर्छ।")).toBe(
      "अभि-भावकले इन-बक्सको म्यासेज हेर्नुपर्छ।"
    );
    expect(prepareNepali("अपरिचित व्यक्तिलाई क्वाइन नपठाउनुहोस्।")).toBe(
      "अपरि-चित व्यक्तिलाई क्वाइन् नपठाउनुहोस्।"
    );
  });

  it("lets the Settings list override a built-in spelling", () => {
    expect(prepareNepali("लगइन गर्नुहोस्।", { pronunciations: { "लगइन": "लोग-इन" } })).toBe(
      "लोग-इन गर्नुहोस्।"
    );
  });

  it("gives English words the same chosen spellings", () => {
    expect(prepareNepali("मेरो inbox मा message छ, login गर्नुहोस्।")).toBe(
      "मेरो इन-बक्स मा म्यासेज छ, लग-इन गर्नुहोस्।"
    );
  });
});
