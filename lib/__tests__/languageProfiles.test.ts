import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, LANGUAGES } from "../config";
import {
  DEFAULT_ENGINE,
  LANGUAGE_PROFILES,
  languageForText,
  needsOwnEngine,
  profileFor,
  resolveSynthesis,
} from "../languageProfiles";

/**
 * Profiles are opt-in. The guarantee that matters most is the negative one:
 * a language without a profile must produce exactly the settings it produced
 * before profiles existed, or every voice on the platform changes at once.
 */

describe("languages without a profile are untouched", () => {
  it("English resolves to the tuned defaults and the usual engine", () => {
    expect(resolveSynthesis({ language: "en" })).toEqual({
      engine: DEFAULT_ENGINE,
      modelLanguage: "en",
      exaggeration: DEFAULT_PARAMS.exaggeration,
      cfg: DEFAULT_PARAMS.cfg,
      temperature: DEFAULT_PARAMS.temperature,
    });
  });

  it("uses the real tuned values, not round numbers", () => {
    // Pinned deliberately: a spec once described these as 0.5/0.5. They are
    // not, and "behaves exactly as today" means these exact figures.
    expect(DEFAULT_PARAMS.exaggeration).toBe(0.4);
    expect(DEFAULT_PARAMS.cfg).toBe(0.5);
    expect(DEFAULT_PARAMS.temperature).toBe(0.7);
  });

  it("carries no fallback, so nothing can substitute a model", () => {
    expect(resolveSynthesis({ language: "hi" }).fallback).toBeUndefined();
    expect(resolveSynthesis({ language: "fr" }).fallback).toBeUndefined();
  });

  it("passes the language straight through to the model", () => {
    for (const code of ["en", "hi", "fr", "ja", "sw"]) {
      expect(resolveSynthesis({ language: code }).modelLanguage).toBe(code);
    }
  });

  it("treats an unknown language as unprofiled rather than failing", () => {
    expect(resolveSynthesis({ language: "xx" }).engine).toBe(DEFAULT_ENGINE);
  });

  it("falls back to English when no language is given at all", () => {
    expect(resolveSynthesis({}).modelLanguage).toBe("en");
  });

  it("reports that they need no engine of their own", () => {
    expect(needsOwnEngine("en")).toBe(false);
    expect(needsOwnEngine("hi")).toBe(false);
    expect(needsOwnEngine(null)).toBe(false);
  });
});

describe("the Nepali profile", () => {
  it("asks for a Nepali engine", () => {
    const got = resolveSynthesis({ language: "ne" });
    expect(got.engine).toBe("chatterbox-ne");
    expect(got.modelLanguage).toBe("ne");
    expect(needsOwnEngine("ne")).toBe(true);
  });

  it("uses its own pacing rather than the defaults", () => {
    // More expressive than the narration defaults, with a lower cfg so the
    // Nepali fine-tune commits to a delivery instead of flattening out.
    const got = resolveSynthesis({ language: "ne" });
    expect(got.exaggeration).toBe(0.65);
    expect(got.cfg).toBe(0.35);
    expect(got.temperature).toBe(0.8);
  });

  it("has no fallback: Nepali is never handed to another language's model", () => {
    expect(LANGUAGE_PROFILES.ne.fallback).toBeUndefined();
    expect(resolveSynthesis({ language: "ne" }).fallback).toBeUndefined();
  });

  it("is case-insensitive, because callers send what they like", () => {
    expect(profileFor("NE")).toBe(LANGUAGE_PROFILES.ne);
  });

  it("is offered in the voice-cloning dropdown", () => {
    expect(LANGUAGES.some((l) => l.code === "ne")).toBe(true);
  });
});

describe("resolution order — request beats voice beats profile beats default", () => {
  it("a voice override beats the profile", () => {
    const got = resolveSynthesis({ language: "ne", voice: { cfg: 0.9 } });
    expect(got.cfg).toBe(0.9);
    // and leaves the rest of the profile alone
    expect(got.temperature).toBe(0.8);
  });

  it("a request override beats the voice", () => {
    const got = resolveSynthesis({
      language: "ne",
      voice: { cfg: 0.9 },
      request: { cfg: 0.1 },
    });
    expect(got.cfg).toBe(0.1);
  });

  it("a request override beats the defaults on an unprofiled language", () => {
    const got = resolveSynthesis({ language: "en", request: { exaggeration: 0.95 } });
    expect(got.exaggeration).toBe(0.95);
    expect(got.cfg).toBe(DEFAULT_PARAMS.cfg);
  });

  it("lets a caller force an engine", () => {
    expect(resolveSynthesis({ language: "en", request: { engine: "qwen3" } }).engine).toBe("qwen3");
  });

  it("lets a voice pin an engine that the request can still override", () => {
    expect(
      resolveSynthesis({ language: "en", voice: { engine: "qwen3" } }).engine
    ).toBe("qwen3");
    expect(
      resolveSynthesis({
        language: "en",
        voice: { engine: "qwen3" },
        request: { engine: DEFAULT_ENGINE },
      }).engine
    ).toBe(DEFAULT_ENGINE);
  });

  it("ignores undefined overrides rather than treating them as zero", () => {
    // A caller sending {cfg: undefined} must not silence the model.
    const got = resolveSynthesis({
      language: "en",
      request: { cfg: undefined, exaggeration: undefined },
    });
    expect(got.cfg).toBe(DEFAULT_PARAMS.cfg);
    expect(got.exaggeration).toBe(DEFAULT_PARAMS.exaggeration);
  });

  it("accepts a genuine zero, which is not the same as absent", () => {
    expect(resolveSynthesis({ language: "en", request: { exaggeration: 0 } }).exaggeration).toBe(0);
  });
});

describe("languageForText", () => {
  it("keeps the chosen language when the script matches", () => {
    expect(languageForText("Hello everyone!", "en", "en")).toBe("en");
    expect(languageForText("नमस्ते सबैलाई", "ne", "ne")).toBe("ne");
    expect(languageForText("Bonjour tout le monde", "fr", "en")).toBe("fr");
  });

  it("does not send English text to the Nepali model", () => {
    expect(languageForText("Hello everyone!", "ne", "en")).toBe("en");
    // A Nepali voice reading an all-English line still needs the English model.
    expect(languageForText("Thank you, and have a great day!", "ne", "ne")).toBe("en");
  });

  it("does not send Devanagari to a model that cannot read it", () => {
    expect(languageForText("नमस्ते सबैलाई", "en", "ne")).toBe("ne");
    expect(languageForText("नमस्ते सबैलाई", "en", "hi")).toBe("hi");
    expect(languageForText("नमस्ते सबैलाई", "en", "en")).toBe("ne");
  });

  it("leaves mixed Nepali and English with the Nepali engine", () => {
    expect(languageForText("मेरो laptop को password", "ne", "ne")).toBe("ne");
  });

  it("falls back to the voice, then English, when nothing was chosen", () => {
    expect(languageForText("Hello", undefined, "fr")).toBe("fr");
    expect(languageForText("Hello", undefined, undefined)).toBe("en");
  });
});
