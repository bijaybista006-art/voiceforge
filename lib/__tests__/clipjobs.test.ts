import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI video clips (Wan). The rules that decide where a clip goes and what the
 * caller is told, plus the job flow against a fake backend: dispatch, the
 * failover a T4 running out of memory relies on, collection into storage,
 * and a lost clip being sent again exactly once.
 */

const jobs = new Map<string, any>();
const kv = new Map<string, unknown>();
let backends: any[] = [];
const stored: string[] = [];

vi.mock("../server/redis", () => ({
  kvGet: vi.fn(async (k: string) => kv.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: unknown) => {
    kv.set(k, v);
    return true;
  }),
  kvDel: vi.fn(async (k: string) => kv.delete(k)),
  getRedis: () => ({
    set: async (k: string, v: unknown, opts?: { nx?: boolean }) => {
      if (opts?.nx && kv.has(k)) return null;
      kv.set(k, v);
      return "OK";
    },
    exists: async (k: string) => (kv.has(k) ? 1 : 0),
  }),
}));

vi.mock("../server/jobs", () => {
  class JobError extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 400, code = "error") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    JobError,
    callbackToken: async () => "token",
    getJob: vi.fn(async (id: string) => (jobs.has(id) ? { ...jobs.get(id) } : null)),
    saveJob: vi.fn(async (job: any) => {
      const saved = { ...job, updatedAt: Date.now() };
      jobs.set(job.id, saved);
      return { ...saved };
    }),
  };
});

vi.mock("../server/backends", () => ({
  backendHeaders: () => ({ "Content-Type": "application/json" }),
  getBackend: async (p: string) => backends.find((b) => b.provider === p) ?? null,
  listBackends: async () => backends,
  updateBackend: async (p: string, patch: any) => {
    const b = backends.find((x) => x.provider === p);
    if (b) Object.assign(b, patch);
    return b ?? null;
  },
  isUsableHealth: (h: string) => h === "online" || h === "busy" || h === "unverified",
}));

vi.mock("../server/blob", () => ({
  putBlob: vi.fn(async (path: string) => {
    stored.push(path);
    return { url: `https://store.test/${path}`, pathname: path };
  }),
}));

import {
  clipReadiness,
  clipRequestBody,
  completeClip,
  createAndDispatchClip,
  discoverWan,
  pickClipBackends,
  reconcileClip,
  shouldProbeWan,
  wanCandidateUrls,
  wanInstallNote,
} from "../server/clipjobs";

const kaggle = () => ({
  provider: "kaggle",
  url: "https://k.trycloudflare.com",
  selfRegistered: true,
  health: "online",
  enabled: true,
  wanUrl: "https://k.trycloudflare.com/wan",
  wanCapabilities: ["text-to-video"],
  wanProbedUrl: "https://k.trycloudflare.com/wan",
  wanProbedAt: Date.now(),
  wanLimits: { default_quality: "480p" },
});
const modal = () => ({
  provider: "modal",
  url: "https://ws--voiceforge-api.modal.run",
  selfRegistered: false,
  health: "online",
  enabled: true,
  wanUrl: "https://ws--voiceforge-wan.modal.run",
  wanCapabilities: ["text-to-video"],
  wanProbedUrl: "https://ws--voiceforge-wan-health.modal.run",
  wanProbedAt: Date.now(),
  wanLimits: { default_quality: "720p" },
});

describe("where clips go", () => {
  it("derives Modal's video and CPU-health addresses from the voice address, same form first", () => {
    const c = wanCandidateUrls("https://ws--voiceforge-api.modal.run/");
    expect(c[0]).toEqual({
      service: "https://ws--voiceforge-wan.modal.run",
      health: "https://ws--voiceforge-wan-health.modal.run",
    });
    // An older voice app has no region in its URL; a newer Wan app does
    // (the first real deploy: …-api.modal.run vs …-wan.us-east.modal.run).
    expect(c).toContainEqual({
      service: "https://ws--voiceforge-wan.us-east.modal.run",
      health: "https://ws--voiceforge-wan-health.us-east.modal.run",
    });
    expect(new Set(c.map((x) => x.health)).size).toBe(c.length);
  });

  it("keeps a regional voice address's own region first", () => {
    const c = wanCandidateUrls("https://ws--voiceforge-api.eu-west.modal.run");
    expect(c[0].service).toBe("https://ws--voiceforge-wan.eu-west.modal.run");
  });

  it("uses /wan on a notebook's tunnel, and nothing for a hand-typed custom URL", () => {
    expect(wanCandidateUrls("https://k.trycloudflare.com", true)).toEqual([
      { service: "https://k.trycloudflare.com/wan", health: "https://k.trycloudflare.com/wan" },
    ]);
    expect(wanCandidateUrls("https://my.gpu.box", false)).toEqual([]);
  });

  it("finds the Wan app at its regional address when the plain one is not there", async () => {
    backends = [{ provider: "modal", url: "https://ws--voiceforge-api.modal.run", selfRegistered: false, health: "online", enabled: true }];
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(String(url));
        return String(url) === "https://ws--voiceforge-wan-health.us-east.modal.run/health"
          ? new Response(JSON.stringify({ capabilities: ["text-to-video"], limits: { default_quality: "720p" } }))
          : new Response("modal-http: app not found", { status: 404 });
      })
    );
    try {
      expect(await discoverWan("modal" as any, 5_000)).toEqual(["text-to-video"]);
      expect(asked[0]).toBe("https://ws--voiceforge-wan-health.modal.run/health");
      expect(backends[0]).toMatchObject({
        wanUrl: "https://ws--voiceforge-wan.us-east.modal.run",
        wanProbedUrl: "https://ws--voiceforge-wan-health.us-east.modal.run",
        wanCapabilities: ["text-to-video"],
      });
      // Remembered: the next probe is not due, and asks that address first.
      expect(shouldProbeWan(backends[0])).toBe(false);
      asked.length = 0;
      await discoverWan("modal" as any, 5_000);
      expect(asked[0]).toBe("https://ws--voiceforge-wan-health.us-east.modal.run/health");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records a no when every address answers that nothing is there", async () => {
    backends = [{ provider: "modal", url: "https://ws--voiceforge-api.modal.run", selfRegistered: false, health: "online", enabled: true }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    try {
      expect(await discoverWan("modal" as any, 5_000)).toEqual([]);
      expect(backends[0].wanCapabilities).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks a new address, keeps a yes, and asks again after a no", () => {
    const now = Date.now();
    expect(shouldProbeWan({ url: "https://k.test", selfRegistered: true }, now)).toBe(true);
    expect(shouldProbeWan({ ...kaggle() }, now)).toBe(false);
    const no = { ...kaggle(), wanCapabilities: [], wanProbedAt: now - 60_000 };
    expect(shouldProbeWan(no, now)).toBe(false);
    expect(shouldProbeWan({ ...no, wanProbedAt: now - 120_000 }, now)).toBe(true);
  });

  it("keeps the standard order and skips offline, video-off and not-ready backends", () => {
    const list: any[] = [
      { ...kaggle(), provider: "colab", health: "offline" },
      { ...kaggle(), videoEnabled: false },
      { ...kaggle(), provider: "custom", wanCapabilities: [] },
      modal(),
    ];
    expect(pickClipBackends(list).map((b) => b.provider)).toEqual(["modal"]);
  });

  it("explains why no clip can be made, as the next thing to do", () => {
    expect(clipReadiness([]).reason).toMatch(/voiceforge_wan\.py|ENABLE_AI_VIDEO/);
    expect(clipReadiness([{ ...modal(), health: "offline" }] as any).reason).toMatch(/offline/);
    expect(clipReadiness([{ ...modal(), videoEnabled: false }] as any).reason).toMatch(/switched off/);
    const installing = { ...kaggle(), wanCapabilities: [], wanNote: "it is still installing AI video (downloading)" };
    expect(clipReadiness([installing] as any).reason).toMatch(/installing/);
    const ready = clipReadiness([installing, modal()] as any);
    expect(ready).toMatchObject({ ready: true, provider: "modal", limits: { default_quality: "720p" } });
    expect(ready.also).toMatch(/kaggle/);
  });

  it("turns a notebook install report into one line", () => {
    expect(wanInstallNote({ state: "ready" })).toBeUndefined();
    expect(wanInstallNote({ state: "installing", stage: "downloading the weights" })).toMatch(/downloading/);
    expect(wanInstallNote({ state: "failed", error: "disk full" })).toMatch(/disk full/);
  });
});

describe("checking a request before any GPU wakes", () => {
  it("passes only what was given, so the backend applies its own defaults", () => {
    expect(clipRequestBody({ prompt: "  a fox  " })).toEqual({ prompt: "a fox", aspect: "landscape" });
    expect(clipRequestBody({ prompt: "x", aspect: "vertical", quality: "720p", numFrames: 81, seed: 0 })).toEqual({
      prompt: "x",
      aspect: "vertical",
      quality: "720p",
      num_frames: 81,
      seed: 0,
    });
  });

  it("refuses an empty prompt and a frame count the VAE cannot make", () => {
    expect(() => clipRequestBody({ prompt: " " })).toThrow(/empty/);
    expect(() => clipRequestBody({ prompt: "x", numFrames: 120 })).toThrow(/4k\+1/);
    expect(() => clipRequestBody({ prompt: "x", numFrames: 125 })).toThrow(/4k\+1/);
  });
});

describe("the job flow", () => {
  let posts: Array<{ url: string; body: any }> = [];
  let renderStatus: (url: string) => Response;

  beforeEach(() => {
    jobs.clear();
    kv.clear();
    stored.length = 0;
    posts = [];
    backends = [kaggle(), modal()];
    renderStatus = () => new Response("{}", { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/render") && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          posts.push({ url: u, body });
          return new Response(JSON.stringify({ accepted: true, settings: { seed: body.seed ?? 1234 } }), { status: 202 });
        }
        if (u.endsWith("/video")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        if (init?.method === "DELETE") return new Response("{}", { status: 200 });
        return renderStatus(u);
      })
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sends a clip to the first backend in the order, with a callback", async () => {
    const job = await createAndDispatchClip({ prompt: "a fox", source: "key1" }, "https://app.test");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://k.trycloudflare.com/wan/render");
    expect(posts[0].body).toMatchObject({
      prompt: "a fox",
      job_id: job.id,
      callback_url: `https://app.test/api/internal/jobs/${job.id}/complete`,
      callback_token: "token",
    });
    expect(job).toMatchObject({ kind: "clip", status: "running", backend: "kaggle" });
    expect(job.clip?.settings).toEqual({ seed: 1234 });
  });

  it("collects a finished clip into storage under clips/", async () => {
    const job = await createAndDispatchClip({ prompt: "a fox", source: "key1" }, "https://app.test");
    const done = await completeClip(job, { status: "done", duration: 5.04, gen_seconds: 600, bytes: 3, settings: { seed: 1234, width: 832 } });
    expect(stored).toEqual([`clips/${job.id}.mp4`]);
    expect(done).toMatchObject({ status: "done", videoUrl: `https://store.test/clips/${job.id}.mp4`, duration: 5.04 });
    expect(done.clip?.settings).toEqual({ seed: 1234, width: 832 });
  });

  it("moves a clip a notebook could not make to the next backend, keeping its seed", async () => {
    const job = await createAndDispatchClip({ prompt: "a fox", source: "key1" }, "https://app.test");
    const moved = await completeClip(job, { status: "error", error: "GPU_OUT_OF_MEMORY: ..." });
    expect(posts.map((p) => p.url)).toEqual([
      "https://k.trycloudflare.com/wan/render",
      "https://ws--voiceforge-wan.modal.run/render",
    ]);
    expect(posts[1].body.seed).toBe(1234);
    expect(moved).toMatchObject({ status: "running", backend: "modal" });
    expect(moved.clip?.failedOn).toEqual(["kaggle"]);

    const failed = await completeClip(moved, { status: "error", error: "still no" });
    expect(failed).toMatchObject({ status: "error", error: "still no" });
  });

  it("sends a clip lost by a restarted backend again, once", async () => {
    backends = [modal()];
    const job = await createAndDispatchClip({ prompt: "a fox", source: "key1" }, "https://app.test");
    renderStatus = () => new Response("unknown render", { status: 404 });
    const again = await reconcileClip(job);
    expect(again.status).toBe("running");
    expect(again.clip?.restarts).toBe(1);
    const lost = await reconcileClip(again);
    expect(lost).toMatchObject({ status: "error", error: "the backend restarted before this clip finished" });
    expect(posts).toHaveLength(2);
  });

  it("reports progress from a poll, and finishes from one when the callback is lost", async () => {
    backends = [modal()];
    const job = await createAndDispatchClip({ prompt: "a fox", source: "key1" }, "https://app.test");
    renderStatus = () => new Response(JSON.stringify({ status: "running", progress: 40, stage: "generating (20/50)" }));
    const moving = await reconcileClip(job);
    expect(moving).toMatchObject({ progress: 40, stage: "generating (20/50)" });

    renderStatus = () =>
      new Response(JSON.stringify({ status: "done", duration: 5.04, bytes: 3, gen_seconds: 200, gpu: "NVIDIA L40S", settings: { seed: 1234 } }));
    const done = await reconcileClip(moving);
    expect(done).toMatchObject({ status: "done", videoUrl: `https://store.test/clips/${job.id}.mp4` });
    expect(done.diagnostics).toEqual({ gpu: "NVIDIA L40S" });
  });

  it("says why when no backend can make clips, before creating a job", async () => {
    backends = [];
    await expect(createAndDispatchClip({ prompt: "a fox", source: "key1" }, "https://app.test")).rejects.toMatchObject({
      status: 503,
      code: "no_clip_backend",
    });
    expect(jobs.size).toBe(0);
  });
});
