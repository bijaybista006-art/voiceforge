import type { Config } from "tailwindcss";

/** A theme token: `rgb(var(--name) / <alpha-value>)`, so `/20` opacity still works. */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

/**
 * Design system — mirrors the Tech Notebook project: light slate ground,
 * blue brand + violet accent, white cards with soft shadows.
 *
 * The token NAMES are unchanged from the previous dark theme on purpose:
 * every component already styles itself through them, so re-pointing the
 * values re-skins the whole app without touching each component.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  // Themes are driven by data-theme on <html> (see app/layout.tsx).
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Every colour is a CSS variable (RGB channels) defined in
        // app/globals.css for the light AND dark theme, so these token names
        // re-skin the whole app per theme with no dark: classes per component.
        // --- ground + surfaces
        bg: v("bg"),
        surface: v("surface"),
        surface2: v("surface2"),
        surface3: v("surface3"),
        line: v("line"),
        lineStrong: v("line-strong"),

        // --- type
        ink: v("ink"),
        muted: v("muted"),
        faint: v("faint"),

        // --- product accents. Speech = brand blue, Video = violet.
        audio: v("audio"),
        audioSoft: "rgb(var(--audio) / 0.1)",
        video: v("video"),
        videoSoft: "rgb(var(--video) / 0.1)",

        // --- state. `live` amber ONLY while recording/generating.
        live: v("live"),
        liveSoft: "rgb(var(--live) / 0.12)",
        danger: v("danger"),
        dangerSoft: "rgb(var(--danger) / 0.1)",
        ready: v("ready"),
        readySoft: "rgb(var(--ready) / 0.12)",

        // --- brand ramp. 50/100/700 are tints and text, so they follow the
        // theme; 300-600 are fills and stay the brand's own blue.
        brand: {
          50: v("brand-50"),
          100: v("brand-100"),
          300: v("brand-300"),
          400: v("brand-400"),
          500: v("brand-500"),
          600: v("brand-600"),
          700: v("brand-700"),
          950: v("brand-950"),
        },
        accent: {
          50: v("accent-50"),
          400: v("accent-400"),
          500: v("accent-500"),
          600: v("accent-600"),
          700: v("accent-700"),
        },

        // --- legacy aliases so nothing renders broken mid-migration
        desk: v("bg"),
        panel: v("surface"),
        rule: v("line"),
        text: v("ink"),
        signal: v("live"),
      },
      fontFamily: {
        display: ["var(--font-space-grotesk)", "system-ui", "sans-serif"],
        body: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        lift: "var(--shadow-lift)",
        glow: "0 0 0 1px rgba(37,99,235,.25), 0 8px 24px -10px rgba(37,99,235,.35)",
        glowVideo: "0 0 0 1px rgba(124,58,237,.25), 0 8px 24px -10px rgba(124,58,237,.35)",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        breathe: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: ".55" },
        },
        slide: {
          "0%": { left: "-35%" },
          "100%": { left: "100%" },
        },
      },
      animation: {
        "fade-up": "fade-up .3s ease-out both",
        shimmer: "shimmer 1.6s infinite",
        breathe: "breathe 1.8s ease-in-out infinite",
        slide: "slide 1.3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
