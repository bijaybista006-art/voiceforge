import { describe, expect, it } from "vitest";
import { JOB_KIND_LABEL, formatSeconds, jobKind, timeAgo } from "@/lib/jobView";
import { THEME_KEY, THEME_SCRIPT, isThemePref, resolveTheme } from "@/lib/theme";

describe("theme", () => {
  it("accepts only the three preferences", () => {
    expect(isThemePref("light")).toBe(true);
    expect(isThemePref("dark")).toBe(true);
    expect(isThemePref("system")).toBe(true);
    expect(isThemePref("blue")).toBe(false);
    expect(isThemePref(null)).toBe(false);
  });

  it("resolves System from the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("boot script reads the same storage key and sets both attributes", () => {
    expect(THEME_SCRIPT).toContain(`localStorage.getItem("${THEME_KEY}")`);
    expect(THEME_SCRIPT).toContain('setAttribute("data-theme"');
    expect(THEME_SCRIPT).toContain('setAttribute("data-theme-pref"');
    // Must be valid JavaScript on its own: it runs before React.
    expect(() => new Function(THEME_SCRIPT)).not.toThrow();
  });

  it("boot script picks the stored theme, and falls back to the OS", () => {
    const run = (stored: string | null, osDark: boolean) => {
      const attrs: Record<string, string> = {};
      const g = {
        localStorage: { getItem: () => stored },
        window: { matchMedia: () => ({ matches: osDark }) },
        document: { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } },
      };
      new Function("localStorage", "window", "document", THEME_SCRIPT)(g.localStorage, g.window, g.document);
      return attrs;
    };
    expect(run("dark", false)).toEqual({ "data-theme": "dark", "data-theme-pref": "dark" });
    expect(run("light", true)).toEqual({ "data-theme": "light", "data-theme-pref": "light" });
    expect(run(null, true)).toEqual({ "data-theme": "dark", "data-theme-pref": "system" });
    expect(run("nonsense", false)).toEqual({ "data-theme": "light", "data-theme-pref": "system" });
  });
});

describe("job view", () => {
  it("labels every kind in plain words, defaulting to narration", () => {
    expect(JOB_KIND_LABEL[jobKind("clip")]).toBe("AI video clip");
    expect(JOB_KIND_LABEL[jobKind("presenter")]).toBe("Presenter clip");
    expect(JOB_KIND_LABEL[jobKind(undefined)]).toBe("Narration");
    expect(JOB_KIND_LABEL[jobKind("tts")]).toBe("Narration");
  });

  it("formats lengths", () => {
    expect(formatSeconds(5)).toBe("5.0 s");
    expect(formatSeconds(132)).toBe("2:12");
    expect(formatSeconds(3723)).toBe("1:02:03");
    expect(formatSeconds(undefined)).toBeNull();
    expect(formatSeconds(Number.NaN)).toBeNull();
  });

  it("says how long ago", () => {
    const now = 1_700_000_000_000;
    expect(timeAgo(now - 10_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe("2 d ago");
    expect(timeAgo(now + 60_000, now)).toBe("just now");
  });
});
