import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The collection step is where a long render could silently break: audio must
 * come back over GET (a response has no size cap) rather than inside the
 * callback body (which Vercel rejects over 4.5 MB). These tests pin that
 * contract, plus the reconcile path that rescues a job whose callback was
 * lost — the failure that would otherwise strand a finished render forever.
 */

const store = new Map<string, unknown>();
const putBlob = vi.fn(async (pathname: string) => ({
  url: `https://blob.test/${pathname}`,
}));

vi.mock("../server/redis", () => ({
  kvGet: vi.fn(async (k: string) => store.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: unknown) => {
    store.set(k, v);
    return true;
  }),
  kvDel: vi.fn(async (k: string) => store.delete(k)),
  getRedis: () => null,
  isRedisConfigured: () => true,
  getSettings: async () => ({
    retentionDays: 7,
    kaggleNotebookUrl: "",
    defaultModel: "chatterbox",
    defaultLanguage: "en",
  }),
}));

vi.mock("../server/blob", () => ({
  putBlob: (...args: unknown[]) => putBlob(args[0] as string),
  deleteBlob: vi.fn(async () => {}),
  isBlobConfigured: () => true,
}));

let activeBackend: unknown = null;
let fallbackBackends: unknown[] = [];

vi.mock("../server/backends", () => ({
  backendHeaders: () => ({ "Content-Type": "application/json", "X-Backend-Secret": "s" }),
  resolveBackend: async () => activeBackend,
  usableBackends: async () => (activeBackend ? [activeBackend, ...fallbackBackends] : []),
  // Dispatch notes an unreachable backend on its registry row. A no-op here,
  // but it must exist: leaving it out made every dispatch throw on an
  // undefined call and silently stranded the job in "queued".
  recordUnreachable: async () => {},
  recordReached: async () => {},
}));

const libraryVoice: Record<string, unknown> = {
  id: "me-1234",
  name: "Me",
  language: "en",
  transcript: "hello",
  audioUrl: "https://blob.test/voices/me-1234.wav",
  durationSec: 15,
  sizeBytes: 1000,
  createdAt: 0,
  updatedAt: 0,
};
let voiceExists = true;

/** Other library voices, for linked-reference tests. */
const extraVoices = new Map<string, Record<string, unknown>>();

vi.mock("../server/voices", () => ({
  getVoice: async (id: string) =>
    voiceExists && id === libraryVoice.id ? libraryVoice : extraVoices.get(id) ?? null,
}));

const { collectJob, createAndDispatchJob, flushPending, getJob, reconcileJob } =
  await import("../server/jobs");
type Job = Awaited<ReturnType<typeof reconcileJob>>;

function job(patch: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    status: "running",
    mode: "stitch",
    format: "mp3",
    voiceId: "me-1234",
    source: "key-1",
    chars: 100,
    chunks: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    backend: "colab",
    backendUrl: "https://gpu.test",
    ...patch,
  } as Job;
}

/** Minimal fetch double that maps URL substrings to responses. */
function routeFetch(routes: Record<string, { status?: number; json?: unknown; body?: string }>) {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    void init;
    const href = String(url);
    const hit = Object.entries(routes).find(([frag]) => href.includes(frag));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const [, spec] = hit;
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => spec.json,
      arrayBuffer: async () => new TextEncoder().encode(spec.body ?? "AUDIO").buffer,
      text: async () => spec.body ?? "",
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => store.clear());
afterEach(() => vi.unstubAllGlobals());

describe("collectJob", () => {
  it("pulls the file over GET and stores it, rather than reading it from the callback", async () => {
    const fetchMock = routeFetch({ "/jobs/job-1/audio/0": { body: "MP3BYTES" } });

    const done = await collectJob(job(), {
      status: "done",
      format: "mp3",
      duration: 12.5,
      gen_seconds: 30,
      items: [{ index: 0, duration: 12.5 }],
    });

    expect(done.status).toBe("done");
    expect(done.audioUrl).toBe("https://blob.test/jobs/job-1.mp3");
    expect(done.duration).toBe(12.5);
    // The audio came from a GET to the backend, not from the request body.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/jobs/job-1/audio/0"))).toBe(true);
  });

  it("keeps one file per item in batch mode and sets no single audio_url", async () => {
    routeFetch({
      "/jobs/job-1/audio/0": { body: "ONE" },
      "/jobs/job-1/audio/1": { body: "TWO" },
    });

    const done = await collectJob(job({ mode: "items" }), {
      status: "done",
      format: "mp3",
      items: [
        { index: 0, duration: 1 },
        { index: 1, duration: 2 },
      ],
    });

    expect(done.items?.map((i) => i.audioUrl)).toEqual([
      "https://blob.test/jobs/job-1-0.mp3",
      "https://blob.test/jobs/job-1-1.mp3",
    ]);
    expect(done.audioUrl).toBeUndefined();
  });

  it("records the backend's error instead of pretending the job finished", async () => {
    routeFetch({});
    const failed = await collectJob(job(), { status: "error", error: "CUDA out of memory" });
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("CUDA out of memory");
  });

  it("fails the job when a file can't be collected, rather than half-finishing it", async () => {
    routeFetch({ "/jobs/job-1/audio/0": { status: 410 } });
    const failed = await collectJob(job(), {
      status: "done",
      items: [{ index: 0, duration: 1 }],
    });
    expect(failed.status).toBe("error");
    expect(failed.error).toMatch(/couldn't collect item 0/i);
  });

  it("honours the format the backend actually produced, not the one requested", async () => {
    // The backend falls back to WAV when libsndfile has no MP3 support.
    routeFetch({ "/jobs/job-1/audio/0": { body: "WAVBYTES" } });
    const done = await collectJob(job({ format: "mp3" }), {
      status: "done",
      format: "wav",
      items: [{ index: 0, duration: 1 }],
    });
    expect(done.format).toBe("wav");
    expect(done.audioUrl).toBe("https://blob.test/jobs/job-1.wav");
  });

  it("a second collector (callback + poll race) returns the finished job instead of failing on a 404", async () => {
    // First collector finishes and the backend drops its copy...
    routeFetch({
      "/jobs/job-1/audio/0": { body: "ONE" },
      "/jobs/job-1/audio/1": { body: "TWO" },
    });
    const result = {
      status: "done",
      format: "mp3" as const,
      items: [
        { index: 0, duration: 1 },
        { index: 1, duration: 2 },
      ],
    };
    const first = await collectJob(job({ mode: "items" }), result);
    expect(first.status).toBe("done");

    // ...so every audio GET now 404s. The late collector must not overwrite "done" with an error.
    const fetchMock = routeFetch({});
    const second = await collectJob(job({ mode: "items" }), result);
    expect(second.status).toBe("done");
    expect(second.items).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("reconcileJob", () => {
  it("finishes a job whose callback never arrived", async () => {
    routeFetch({
      "/jobs/job-1/audio/0": { body: "MP3" },
      "/jobs/job-1": { json: { status: "done", format: "mp3", items: [{ index: 0, duration: 3 }] } },
    });

    const settled = await reconcileJob(job());
    expect(settled.status).toBe("done");
    expect(settled.audioUrl).toBe("https://blob.test/jobs/job-1.mp3");
  });

  it("gives up when the backend has forgotten the job — a restarted Colab", async () => {
    routeFetch({ "/jobs/job-1": { status: 404 } });
    const settled = await reconcileJob(job());
    expect(settled.status).toBe("error");
    expect(settled.error).toMatch(/restarted/i);
  });

  it("leaves a still-running job alone", async () => {
    routeFetch({ "/jobs/job-1": { json: { status: "running", progress: 40 } } });
    expect((await reconcileJob(job())).status).toBe("running");
  });

  it("keeps the job running when the backend is briefly unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      })
    );
    expect((await reconcileJob(job())).status).toBe("running");
  });

  it("never re-collects a job that is already done", async () => {
    const fetchMock = routeFetch({});
    const already = job({ status: "done" });
    expect(await reconcileJob(already)).toBe(already);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createAndDispatchJob — dispatch happens after the response", () => {
  /**
   * The GPU call is made after the response is sent, because this route is
   * killed at 60 seconds and a cold container can eat most of that. The
   * caller polls status_url, so it only needs the job record back.
   *
   * The voice still has to reach the backend before the render runs — a
   * background worker can't recover from "voice_not_cached" the way a single
   * chunk can — so the push is still attempted, just not on the clock.
   *
   * `flushPending` is what a request's lifetime does in production: wait for
   * the scheduled work to settle.
   */
  const dispatchInput = {
    chunks: ["Hello."],
    paragraphBreaks: [false],
    voiceId: "me-1234",
    mode: "stitch" as const,
    format: "mp3" as const,
    source: "key-1",
    params: {},
  };

  beforeEach(() => {
    activeBackend = { provider: "colab", url: "https://gpu.test", health: "online" };
    fallbackBackends = [];
    voiceExists = true;
  });

  it("moves on to the next backend when the first refuses the job (a disabled Modal workspace)", async () => {
    activeBackend = { provider: "modal", url: "https://modal.test", health: "online" };
    fallbackBackends = [{ provider: "kaggle", url: "https://kaggle.test", health: "online" }];
    const fn = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith("https://modal.test/jobs"))
        return { ok: false, status: 404, json: async () => ({}), text: async () => "workspace is disabled" };
      if (href.startsWith("https://kaggle.test/jobs"))
        return { ok: true, status: 200, json: async () => ({ accepted: true }), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ voices_cached: ["me-1234"] }), text: async () => "" };
    });
    vi.stubGlobal("fetch", fn);

    const job = await createAndDispatchJob(dispatchInput, "https://app.test");
    await flushPending();

    const saved = await getJob(job.id);
    expect(saved?.status).toBe("running");
    expect(saved?.backend).toBe("kaggle");
    expect(saved?.backendUrl).toBe("https://kaggle.test");
  });

  it("pushes the voice when the backend doesn't have it yet", async () => {
    const fetchMock = routeFetch({
      "/health": { json: { voices_cached: [] } },
      "/voices/me-1234": { json: { ok: true } },
      "/jobs": { json: { accepted: true } },
    });

    const job = await createAndDispatchJob(dispatchInput, "https://app.test");
    // Returns before the GPU has been touched at all.
    expect(job.status).toBe("queued");

    await flushPending();

    const puts = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes("/voices/me-1234") && c[1]?.method === "PUT"
    );
    expect(puts).toHaveLength(1);
  });

  it("skips the upload when the backend already has it", async () => {
    const fetchMock = routeFetch({
      "/health": { json: { voices_cached: ["me-1234"] } },
      "/jobs": { json: { accepted: true } },
    });

    await createAndDispatchJob(dispatchInput, "https://app.test");
    await flushPending();

    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/voices/me-1234"))
    ).toBe(false);
  });

  it("pushes anyway when /health can't be read, rather than risking the render", async () => {
    const fetchMock = routeFetch({
      "/health": { status: 500 },
      "/voices/me-1234": { json: { ok: true } },
      "/jobs": { json: { accepted: true } },
    });

    await createAndDispatchJob(dispatchInput, "https://app.test");
    await flushPending();

    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/voices/me-1234"))
    ).toBe(true);
  });

  it("fails with a clear error when the voice isn't in the library", async () => {
    voiceExists = false;
    routeFetch({ "/health": { json: { voices_cached: [] } } });

    await expect(createAndDispatchJob(dispatchInput, "https://app.test")).rejects.toMatchObject({
      code: "unknown_voice",
      status: 404,
    });
  });

  it("dispatches anyway when the pre-upload fails — the worker can still cache it", async () => {
    // This used to throw voice_sync_failed and kill the job. A failed
    // pre-upload is now just a lost optimisation: the clip travels with the
    // job, so the backend caches it on arrival.
    const fetchMock = routeFetch({
      "/health": { json: { voices_cached: [] } },
      "/voices/me-1234": { status: 400, body: "bad clip" },
      "/jobs": { json: { accepted: true } },
    });

    await createAndDispatchJob(dispatchInput, "https://app.test");
    await flushPending();

    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/jobs"))).toBe(true);
  });

  it("marks the job running once the backend accepts it", async () => {
    routeFetch({
      "/health": { json: { voices_cached: ["me-1234"] } },
      "/jobs": { json: { accepted: true } },
    });

    const job = await createAndDispatchJob(dispatchInput, "https://app.test");
    await flushPending();

    expect((await getJob(job.id))?.status).toBe("running");
  });

  it("records a failed dispatch on the job, since nobody is listening", async () => {
    // This used to be a 502 on the response. The response has already gone,
    // so the job record is the only place a poller can learn about it.
    routeFetch({
      "/health": { json: { voices_cached: ["me-1234"] } },
      "/jobs": { status: 500, body: "boom" },
    });

    const job = await createAndDispatchJob(dispatchInput, "https://app.test");
    await flushPending();

    const saved = await getJob(job.id);
    expect(saved?.status).toBe("error");
    expect(saved?.error).toMatch(/500/);
  });

  it("never leaves a job stuck in queued when the backend is unreachable", async () => {
    // No /jobs route at all: the stub answers 404, which is unreachable enough.
    routeFetch({ "/health": { status: 500 } });

    const job = await createAndDispatchJob(dispatchInput, "https://app.test");
    await flushPending();

    expect((await getJob(job.id))?.status).toBe("error");
  });
});

describe("a queued job is not yet a lost job", () => {
  /**
   * Dispatch happens after the response, so a job sits in "queued" while the
   * POST that hands it to the backend is still in flight — most of a minute on
   * a cold container. The backend 404s for it during that window, and treating
   * that as "the backend restarted" killed jobs that were about to start.
   */
  it("keeps waiting when the backend has never heard of a queued job", async () => {
    routeFetch({ "/jobs/": { status: 404 } });
    const queued = job({ status: "queued", createdAt: Date.now() });
    const got = await reconcileJob(queued);
    expect(got.status).toBe("queued");
    expect(got.error).toBeUndefined();
  });

  it("still fails a running job the backend has forgotten", async () => {
    // A restarted Colab really has lost it, and nothing is coming.
    routeFetch({ "/jobs/": { status: 404 } });
    const got = await reconcileJob(job({ status: "running", createdAt: Date.now() }));
    expect(got.status).toBe("error");
    expect(got.error).toMatch(/restarted/);
  });
});

describe("reconcile stops chasing a dead job", () => {
  /**
   * The admin Jobs page polls while it's open. Each reconcile is a request to
   * the backend, and on Modal that wakes a billed GPU — so a job stuck in
   * "running" must stop being chased rather than waking the GPU forever.
   */
  it("fails a job past the backend's timeout without contacting it", async () => {
    const fetchMock = routeFetch({});
    const ancient = Date.now() - 40 * 60 * 1000;

    const settled = await reconcileJob(job({ createdAt: ancient }));

    expect(settled.status).toBe("error");
    expect(settled.error).toMatch(/never reported back/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still reconciles a job that is young enough to be real", async () => {
    const fetchMock = routeFetch({ "/jobs/job-1": { json: { status: "running" } } });

    await reconcileJob(job({ createdAt: Date.now() - 60_000 }));

    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("cold backend must not kill the job", () => {
  /**
   * Production failure: the first n8n scene after an idle period hit a cold
   * Modal container. The pre-dispatch voice upload timed out and the whole
   * job died with 502 voice_sync_failed, so the workflow fell back to a
   * generic voice for every scene. The clip now travels WITH the job and the
   * backend caches it in its own worker, which has no deadline.
   */
  const dispatchInput = {
    chunks: ["Scene one."],
    paragraphBreaks: [false],
    voiceId: "me-1234",
    mode: "stitch" as const,
    format: "mp3" as const,
    source: "key-1",
    params: {},
  };

  beforeEach(() => {
    activeBackend = { provider: "modal", url: "https://gpu.test", health: "online" };
    voiceExists = true;
  });

  it("still dispatches when the voice upload fails on a cold backend", async () => {
    const fetchMock = routeFetch({
      "/health": { status: 503 },
      "/voices/me-1234": { status: 504 },
      "/jobs": { json: { accepted: true } },
    });

    const job = await createAndDispatchJob(dispatchInput, "https://app.test");
    await flushPending();

    expect((await getJob(job.id))?.status).toBe("running");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/jobs"))).toBe(true);
  });

  it("sends the clip with the job so the worker can cache it itself", async () => {
    const fetchMock = routeFetch({
      "/health": { status: 503 },
      "/voices/me-1234": { status: 504 },
      "/jobs": { json: { accepted: true } },
    });

    await createAndDispatchJob(dispatchInput, "https://app.test");
    await flushPending();

    const dispatch = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/jobs"));
    const sent = JSON.parse(String((dispatch?.[1] as RequestInit)?.body));
    expect(sent.voice).toEqual({
      audio_url: "https://blob.test/voices/me-1234.wav",
      transcript: "hello",
      language: "en",
    });
  });

  it("still refuses a voice that isn't in the library at all", async () => {
    voiceExists = false;
    routeFetch({ "/health": { json: { voices_cached: [] } } });

    await expect(createAndDispatchJob(dispatchInput, "https://app.test")).rejects.toMatchObject({
      code: "unknown_voice",
    });
  });
});

describe("expressive narration: linked voices travel with the job", () => {
  const input = {
    chunks: ["[excited] तपाईंको laptop को IP कसैले देख्न सक्छ?"],
    paragraphBreaks: [false],
    voiceId: "me-1234",
    mode: "stitch" as const,
    format: "mp3" as const,
    source: "key-1",
    params: { language: "ne", code_switch: true, prosody_tags: true },
  };

  beforeEach(() => {
    activeBackend = { provider: "modal", url: "https://gpu.test", health: "online" };
    voiceExists = true;
    libraryVoice.refs = { en: "me-en", calm: "gone-voice" };
    extraVoices.set("me-en", {
      id: "me-en",
      name: "Me (English)",
      language: "en",
      transcript: "hi",
      audioUrl: "https://blob.test/voices/me-en.wav",
    });
  });

  afterEach(() => {
    delete libraryVoice.refs;
    extraVoices.clear();
  });

  async function sentBody(params: Record<string, unknown>) {
    const fetchMock = routeFetch({
      "/health": { json: { voices_cached: ["me-1234"] } },
      "/jobs": { json: { accepted: true } },
    });
    await createAndDispatchJob({ ...input, params }, "https://app.test");
    await flushPending();
    const dispatch = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/jobs"));
    return JSON.parse(String((dispatch?.[1] as RequestInit)?.body));
  }

  it("sends the linked English voice, and skips a link whose voice was deleted", async () => {
    const sent = await sentBody(input.params);
    expect(sent.voice_refs).toEqual({
      en: {
        voice_id: "me-en",
        audio_url: "https://blob.test/voices/me-en.wav",
        transcript: "hi",
        language: "en",
      },
    });
    expect(sent.params.code_switch).toBe(true);
    expect(sent.params.prosody_tags).toBe(true);
  });

  it("sends no refs to a request that did not opt in", async () => {
    const sent = await sentBody({ language: "ne" });
    expect(sent.voice_refs).toBeUndefined();
  });
});
