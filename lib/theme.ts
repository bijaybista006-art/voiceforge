/**
 * Light / Dark / System theme.
 *
 * The choice is kept in localStorage under THEME_KEY. THEME_SCRIPT runs inline
 * in <head> (app/layout.tsx) BEFORE the first paint, so the page never flashes
 * the wrong theme: it resolves "system" against prefers-color-scheme and sets
 * data-theme ("light" | "dark") plus data-theme-pref (the stored choice) on
 * <html>. All colours are CSS variables keyed off data-theme (app/globals.css).
 */

export type ThemePref = "light" | "dark" | "system";

export const THEME_KEY = "vf-theme";

export function isThemePref(v: unknown): v is ThemePref {
  return v === "light" || v === "dark" || v === "system";
}

/** Kept tiny and dependency-free: it is inlined into every page's <head>. */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_KEY}");if(p!=="light"&&p!=="dark")p="system";var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.setAttribute("data-theme",d?"dark":"light");r.setAttribute("data-theme-pref",p);}catch(e){}})();`;

export function resolveTheme(pref: ThemePref, systemDark: boolean): "light" | "dark" {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isThemePref(v) ? v : "system";
  } catch {
    return "system";
  }
}

/** Save a choice and apply it now. Safe where storage is blocked. */
export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage blocked: the theme still applies for this page view */
  }
  applyTheme(pref);
}

export function applyTheme(pref: ThemePref): void {
  const systemDark =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveTheme(pref, Boolean(systemDark)));
  root.setAttribute("data-theme-pref", pref);
}
