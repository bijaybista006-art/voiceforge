import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A text presenter clip is sent to a backend once its narration is done, and
 * that step is reached by every status poll. On 2026-10-18 the studio's
 * 5-second polls sent the same clip to a cold Modal container twice; Modal
 * made it twice under one id and the finished file could not be collected.
 * These tests hold the step to exactly one send, however many polls arrive.
 */

const jobs = new Map<string, any>();
const kv = new Map<string, unknown>();

vi.mock("../server/redis", () => ({
  kvGet: vi.fn(async (k: string) => kv.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: unknown) => {
    kv.set(k, v);
    return true;
  }),
  kvDel: vi.fn(async (k: string) => kv.delete(k)),
  getSettings: async () => ({ pronunciations: {} }),
  // The atomic claim, as the database function behaves: only the first wins.
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
    createAndDispatchJob: vi.fn(),
    getJob: vi.fn(async (id: string) => (jobs.has(id) ? { ...jobs.get(id) } : null)),
    saveJob: vi.fn(async (job: any) => {
      const saved = { ...job, updatedAt: Date.now() };
      jobs.set(job.id, saved);
      return { ...saved };
    }),
    reconcileJob: vi.fn(async (job: any) => job),
  };
});

const presenter = { id: "p1", name: "P", kind: "recording", url: "https://store.test/p.mp4" };
const backend = {
  provider: "modal",
  url: "https://modal.test",
  presenterUrl: "https://modal.test/presenter",
  health: "online",
  enabled: true,
};

vi.mock("../server/presenters", () => ({
  presenterCapability: () => "presenter-relip",
  resolvePresenter: async () => presenter,
  usablePresenterBackends: async () => [backend],
}));

vi.mock("../server/backends", () => ({
  backendHeaders: () => ({ "Content-Type": "application/json" }),
  getBackend: async () => null,
  listBackends: async () => [],
  updateBackend: async () => null,
}));

vi.mock("../server/blob", () => ({ putBlob: vi.fn() }));
vi.mock("../server/voices", () => ({ resolveVoice: async () => null }));

import { reconcilePresenter } from "../server/presenterjobs";

let renderPosts = 0;

beforeEach(() => {
  jobs.clear();
  kv.clear();
  renderPosts = 0;
  // A cold backend: accepting the clip takes a while.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/render") && init?.method === "POST") {
        renderPosts++;
        await new Promise((r) => setTimeout(r, 200));
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      return new Response("{}", { status: 200 });
    })
  );
  const now = Date.now();
  jobs.set("narration", { id: "narration", status: "done", audioUrl: "https://store.test/n.wav", createdAt: now, updatedAt: now });
  jobs.set("clip", {
    id: "clip",
    kind: "presenter",
    status: "queued",
    stage: "narrating",
    createdAt: now,
    updatedAt: now,
    presenter: { id: "p1", kind: "recording", audioJobId: "narration", appUrl: "https://app.test" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sending a text clip to the backend", () => {
  it("sends it once when five polls arrive together", async () => {
    const stale = { ...jobs.get("clip") };
    const results = await Promise.all(Array.from({ length: 5 }, () => reconcilePresenter({ ...stale })));
    expect(renderPosts).toBe(1);
    expect(jobs.get("clip").backendUrl).toBe("https://modal.test/presenter");
    expect(jobs.get("clip").stage).toBe("lip-syncing");
    // Every poll got an answer; none of them failed the clip.
    expect(results.every((r) => r.status !== "error")).toBe(true);
  });

  it("does not send it again from a poll that read the job before it was sent", async () => {
    const stale = { ...jobs.get("clip") };
    await reconcilePresenter({ ...stale });
    // The same out-of-date copy of the job, polled after the send finished.
    await reconcilePresenter({ ...stale });
    expect(renderPosts).toBe(1);
  });

  it("releases the step afterwards", async () => {
    await reconcilePresenter({ ...jobs.get("clip") });
    expect(kv.has("job:clip:dispatching")).toBe(false);
  });

  it("waits while the narration is still running", async () => {
    jobs.set("narration", { ...jobs.get("narration"), status: "running", audioUrl: undefined });
    const out = await reconcilePresenter({ ...jobs.get("clip") });
    expect(renderPosts).toBe(0);
    expect(out.status).toBe("queued");
  });
});
