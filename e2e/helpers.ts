import type { ConsoleMessage, Page } from "@playwright/test";
import fixtures from "./fixtures.json";

export { fixtures };

export interface ApiCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

export const STUDIO_PAGES = [
  { path: "/studio", title: "Studio" },
  { path: "/studio/speech", title: "Text to Speech" },
  { path: "/studio/presenter", title: "Presenter Video" },
  { path: "/studio/ai-video", title: "AI Video" },
  { path: "/studio/library", title: "My Library" },
] as const;

export const ADMIN_PAGES = [
  { path: "/admin", title: "Dashboard" },
  { path: "/admin/backends", title: "Backends" },
  { path: "/admin/voices", title: "Voices" },
  { path: "/admin/presenters", title: "Presenters" },
  { path: "/admin/training", title: "Training data" },
  { path: "/admin/keys", title: "API Keys" },
  { path: "/admin/jobs", title: "Jobs" },
  { path: "/admin/api", title: "API & n8n" },
  { path: "/admin/settings", title: "Settings" },
] as const;

/** A valid 0.1 s silent mono WAV, base64 — what the TTS route returns. */
export function silentWavBase64(sampleRate = 24_000, seconds = 0.1): string {
  const n = Math.round(sampleRate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf.toString("base64");
}

type Responder = (call: ApiCall) => { status?: number; json: unknown } | undefined;

/** Default responses for every GET the UI makes, from fixtures.json. */
function defaults(call: ApiCall): { status?: number; json: unknown } {
  const { method, path } = call;
  if (method === "GET") {
    if (path === "/api/admin/backends") return { json: fixtures.backends };
    if (path === "/api/gateway/status") return { json: fixtures.gatewayStatus };
    if (path === "/api/admin/jobs") return { json: fixtures.jobs };
    if (path === "/api/admin/presenters") return { json: fixtures.presenters };
    if (path === "/api/admin/voices") return { json: fixtures.voices };
    if (path === "/api/admin/keys") return { json: fixtures.keys };
    if (path === "/api/admin/training") return { json: fixtures.training };
    if (path === "/api/gateway/clips") return { json: fixtures.clipsReadiness };
  }
  if (path === "/api/admin/backends/test") return { json: { ok: true, latencyMs: 123 } };
  if (path === "/api/gateway/generate") {
    return { json: { audio_b64: silentWavBase64(), sample_rate: 24_000, duration: 0.1, gen_seconds: 0.5 } };
  }
  if (path === "/api/admin/presenter-clips" && method === "POST") return { json: { jobId: "e2e-presenter-1" } };
  if (path.startsWith("/api/admin/presenter-clips/")) {
    return { json: { jobId: "e2e-presenter-1", status: "running", stage: "narrating", progress: 10 } };
  }
  if (path === "/api/gateway/clips" && method === "POST") {
    return { json: { job_id: "e2e-clip-1", status: "queued", backend: "colab", settings: null } };
  }
  if (path.startsWith("/api/gateway/clips/")) {
    return { json: { job_id: "e2e-clip-1", status: "running", stage: "denoising", progress: 20 } };
  }
  return { json: { ok: true } };
}

/**
 * Mock the app's own /api (only that — Next's JS chunks under
 * /_next/static/chunks/app/admin/api/ must load for real) and media hosts.
 * Returns the list of calls the page made, with parsed JSON bodies.
 */
export async function mockApi(page: Page, respond?: Responder): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];
  await page.route("https://example.invalid/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/octet-stream", body: "" })
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      let body: unknown = undefined;
      const raw = req.postData();
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const call: ApiCall = { method: req.method(), path: url.pathname, search: url.search, body };
      calls.push(call);
      const res = respond?.(call) ?? defaults(call);
      await route.fulfill({ status: res.status ?? 200, json: res.json });
    }
  );
  return calls;
}

/** Collect console errors and uncaught exceptions. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Pin the theme before any script runs. */
export async function setTheme(page: Page, theme: "light" | "dark" | "system") {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("vf-theme", t);
    } catch {
      /* ignore */
    }
  }, theme);
}

export function writes(calls: ApiCall[]): ApiCall[] {
  return calls.filter((c) => c.method !== "GET");
}
